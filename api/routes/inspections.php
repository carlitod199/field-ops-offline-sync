<?php
declare(strict_types=1);

/**
 * Inspection media.
 *
 *   POST /api/v1/inspections/{id}/photos   (multipart/form-data)
 *
 * Why photos are a separate endpoint and a separate phase of the sync, rather
 * than a base64 field inside the push batch:
 *
 *  - Size. A push batch is JSON the server buffers and parses whole. One
 *    4 MB photo becomes ~5.4 MB of base64 and drags every unrelated operation
 *    in the batch down with it; on a marginal connection the batch never
 *    completes and *nothing* syncs.
 *
 *  - Failure isolation. A photo that fails to upload should not prevent the
 *    inspection it belongs to from being recorded. Separating them means the
 *    text record — the part with the operational value — lands first.
 *
 *  - Ordering. The photo needs a parent to attach to. The client only learns
 *    the inspection's server id when push confirms it, so the upload phase can
 *    only run afterwards. The queue enforces that ordering: a photo entry
 *    stays pending until its parent row has a server id.
 *
 * Field name: `photo`. Optional `client_uuid` makes the upload replay-safe on
 * the same ledger the push batch uses; a retried upload after a lost response
 * returns the original photo record instead of storing the bytes twice.
 */

require_once __DIR__ . '/../core/database.php';
require_once __DIR__ . '/../core/idempotency.php';
require_once __DIR__ . '/../core/permissions.php';
require_once __DIR__ . '/../core/request.php';
require_once __DIR__ . '/../core/response.php';
require_once __DIR__ . '/../core/uploads.php';

/**
 * POST /api/v1/inspections/{id}/photos
 *
 * @param string $inspectionId captured from the route pattern
 */
function route_inspection_photo_upload(array $user, string $inspectionId): never
{
    require_permission($user, 'inspections.photo');

    $inspection = db_row(
        'SELECT id, user_id, status FROM inspections
          WHERE id = :inspection_id AND deleted_at IS NULL
          LIMIT 1',
        [':inspection_id' => (int)$inspectionId]
    );

    if ($inspection === null) {
        // 404 and not 409: the parent is confirmed before this endpoint is ever
        // called, so a missing parent means it was deleted, not that the client
        // ran ahead of itself.
        api_fail('inspection_not_found', 'Inspection not found.', 404);
    }

    if ((int)$inspection['user_id'] !== (int)$user['id'] && !user_can($user, 'inspections.review')) {
        api_fail('forbidden', 'You can only attach photos to your own inspections.', 403);
    }

    if ((string)$inspection['status'] === 'reviewed') {
        api_fail('conflict', 'This inspection was already reviewed and no longer accepts photos.', 409);
    }

    $clientUuid = field_client_uuid($_POST);
    $capturedAt = field_timestamp($_POST, 'captured_at', db_now());

    $file = $_FILES['photo'] ?? null;
    if (!is_array($file)) {
        api_fail('field_required', "Send the image in the multipart field 'photo'.", 422);
    }

    // Validation runs before the ledger check on purpose: a malformed file is
    // rejected the same way whether or not it is a retry.
    $validated = upload_validate($file);

    $storedPath = null;

    $apply = static function () use ($validated, $inspection, $clientUuid, $capturedAt, &$storedPath): array {
        $stored = upload_store($validated);
        $storedPath = $stored['absolute_path'];

        db_exec(
            'INSERT INTO inspection_photos
                (inspection_id, client_uuid, original_name, stored_path, mime_type,
                 byte_size, width_px, height_px, sha256, captured_at, created_at)
             VALUES
                (:inspection_id, :client_uuid, :original_name, :stored_path, :mime_type,
                 :byte_size, :width_px, :height_px, :sha256, :captured_at, NOW(3))',
            [
                ':inspection_id' => (int)$inspection['id'],
                ':client_uuid' => $clientUuid,
                ':original_name' => $validated['original_name'],
                ':stored_path' => $stored['relative_path'],
                ':mime_type' => $validated['mime'],
                ':byte_size' => $validated['size'],
                ':width_px' => $validated['width'],
                ':height_px' => $validated['height'],
                ':sha256' => $stored['sha256'],
                ':captured_at' => $capturedAt,
            ]
        );

        $photoId = (int)db()->lastInsertId();

        // Touching the parent does two things: it keeps photo_count truthful,
        // and it pushes the inspection past every existing delta cursor so the
        // new count reaches other devices on their next pull.
        db_exec(
            'UPDATE inspections
                SET photo_count = photo_count + 1, updated_at = NOW(3)
              WHERE id = :inspection_id',
            [':inspection_id' => (int)$inspection['id']]
        );

        return ['inspection_photo', $photoId, [
            'id' => $photoId,
            'inspection_id' => (int)$inspection['id'],
            'client_uuid' => $clientUuid,
            'byte_size' => $validated['size'],
            'sha256' => $stored['sha256'],
        ]];
    };

    try {
        $outcome = idempotent_apply((int)$user['id'], $clientUuid, 'inspection.photo', $apply);
    } catch (Throwable $e) {
        // The file is written inside the transaction but is not part of it.
        // If the transaction rolled back, remove the orphan rather than leaving
        // bytes on disk that no row references.
        if ($storedPath !== null && is_file($storedPath)) {
            @unlink($storedPath);
        }
        throw $e;
    }

    if ($outcome['status'] === 'rejected') {
        api_fail((string)$outcome['error'], (string)$outcome['message'], 409);
    }

    api_ok(
        $outcome['result'],
        $outcome['status'] === 'duplicate' ? 'Photo already uploaded.' : 'Photo stored.',
        $outcome['status'] === 'duplicate' ? 200 : 201
    );
}
