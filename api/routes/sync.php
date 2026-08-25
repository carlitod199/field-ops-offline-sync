<?php
declare(strict_types=1);

/**
 * Synchronisation endpoints.
 *
 *   GET  /api/v1/sync/pull?updated_since=<ISO8601>&limit=<n>
 *   POST /api/v1/sync/push
 *
 * ---------------------------------------------------------------------------
 * PULL — delta reads
 * ---------------------------------------------------------------------------
 * The client stores one cursor. It sends the cursor, receives every row whose
 * `updated_at` is strictly greater, and stores the cursor the server hands
 * back for next time.
 *
 * The race this design has to survive:
 *
 *   T0  request arrives, server reads the clock             -> 12:00:00.000
 *   T1  another connection's transaction stamps updated_at  -> 12:00:00.001
 *   T2  this request SELECTs; the row above is not committed yet, so it is
 *       not returned
 *   T3  the other transaction commits
 *   T4  client stores cursor 12:00:00.000... and asks again with
 *       `updated_since=12:00:00.000` — but if the cursor had been sampled
 *       *after* the SELECT it would already be past 12:00:00.001, and that
 *       row would never be delivered again. It is lost, silently, forever.
 *
 * Two defences, both required:
 *
 *   1. The cursor is sampled BEFORE any SELECT runs (db_now() is memoised for
 *      exactly this reason). A row written after the cursor was taken is by
 *      definition ahead of the cursor and will be picked up next time.
 *
 *   2. The cursor is then moved BACKWARDS by SYNC_CURSOR_OVERLAP_SECONDS. A
 *      row's `updated_at` is stamped when the statement runs, not when the
 *      transaction commits, so a write that started at 11:59:59.900 and
 *      commits at 12:00:00.400 carries a timestamp *older* than a cursor
 *      sampled at T0. Overlapping the window by more than the longest write
 *      transaction is what covers that gap.
 *
 * The price of the overlap is that a few rows are delivered twice. That costs
 * nothing: the client applies rows with INSERT OR REPLACE keyed on the server
 * id, so re-delivery is a no-op. Making the read side idempotent is much
 * cheaper than making it exact.
 *
 * The alternative — a monotonically increasing change sequence assigned at
 * commit time, which removes the race entirely — is discussed and rejected in
 * docs/architecture.md.
 *
 * ---------------------------------------------------------------------------
 * PUSH — queued writes
 * ---------------------------------------------------------------------------
 * A batch of operations, each carrying its own `client_uuid`. Every operation
 * is applied in its own transaction and reported on individually, because the
 * client must be able to clear precisely the operations that succeeded and
 * keep the rest queued. A batch that fails as a unit would force the client to
 * choose between re-sending known-good writes and dropping unknown ones.
 */

require_once __DIR__ . '/../core/database.php';
require_once __DIR__ . '/../core/idempotency.php';
require_once __DIR__ . '/../core/permissions.php';
require_once __DIR__ . '/../core/request.php';
require_once __DIR__ . '/../core/response.php';

/** A business-rule rejection of a single operation. Never retried by the client. */
final class OperationRejected extends RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}

/* ===========================================================================
   PULL
   =========================================================================== */

/**
 * GET /api/v1/sync/pull
 *
 * Response data:
 *   {
 *     "mode": "full" | "delta",
 *     "next_cursor": "2026-08-25T12:00:00.000Z",
 *     "has_more": false,
 *     "sites":       { "records": [...], "deleted_ids": [...], "has_more": false },
 *     "assets":      { ... },
 *     "inspections": { ... }
 *   }
 *
 * `has_more` at the top level means "call again immediately with next_cursor";
 * it is not an error and not a partial failure.
 */
/**
 * Decides what the client's `updated_since` parameter means.
 *
 * Three outcomes, and the third is the interesting one:
 *
 *   ''                      -> [null, null]              full load
 *   valid ISO 8601          -> ['Y-m-d H:i:s.v', null]   delta
 *   valid but ahead of now  -> [null, null]              full load (self-heal)
 *   unparseable             -> [null, 'invalid_cursor']  422
 *
 * A cursor ahead of the server clock cannot be honoured: `updated_at > cursor`
 * would hide every existing row until real time caught up, and the client
 * would sit on an empty delta for however long the skew is. It happens after a
 * clock correction on either side. Falling back to a full load is the only
 * self-healing answer, and it is why this returns a cursor rather than
 * throwing.
 *
 * Extracted from the route so the decision can be tested without an HTTP
 * request; the route itself only turns the error code into a response.
 *
 * @return array{0: ?string, 1: ?string} [since, errorCode]
 */
function sync_normalise_cursor(string $raw, string $serverNow): array
{
    $raw = trim($raw);
    if ($raw === '') {
        return [null, null];
    }

    $since = iso_to_sql($raw);
    if ($since === null) {
        return [null, 'invalid_cursor'];
    }

    // Both sides are `Y-m-d H:i:s.v` in UTC, so a string comparison is a
    // chronological one.
    if ($since > $serverNow) {
        return [null, null];
    }

    return [$since, null];
}

function route_sync_pull(array $user): never
{
    require_permission($user, 'sync.pull');

    $maxLimit = (int)config_get('sync.page_limit');
    $requested = field_int($_GET, 'limit');
    $limit = $requested === null ? $maxLimit : max(1, min($requested, $maxLimit));

    [$since, $cursorError] = sync_normalise_cursor((string)($_GET['updated_since'] ?? ''), db_now());
    if ($cursorError !== null) {
        api_fail($cursorError, "Parameter 'updated_since' must be an ISO 8601 timestamp.", 422);
    }

    $isDelta = $since !== null;

    // Sampled before the first SELECT, then moved back by the overlap window.
    $requestCursor = sql_minus_seconds(db_now(), (int)config_get('sync.cursor_overlap_seconds'));

    $entities = [
        'sites' => sync_pull_sites($since, $limit),
        'assets' => sync_pull_assets($since, $limit),
        'inspections' => sync_pull_inspections($user, $since, $limit),
    ];

    // When any entity was truncated, the cursor may only advance as far as the
    // *lowest* watermark of the truncated entities. Rows already delivered
    // beyond that point are simply delivered again on the next page.
    $watermarks = [];
    $hasMore = false;
    $payload = [];
    foreach ($entities as $name => [$records, $deletedIds, $entityHasMore, $watermark]) {
        $payload[$name] = [
            'records' => $records,
            'deleted_ids' => $deletedIds,
            'has_more' => $entityHasMore,
        ];
        if ($entityHasMore) {
            $hasMore = true;
            if ($watermark !== null) {
                $watermarks[] = $watermark;
            }
        }
    }

    $nextCursor = $hasMore && $watermarks !== [] ? min($watermarks) : $requestCursor;

    api_ok(array_merge([
        'mode' => $isDelta ? 'delta' : 'full',
        'next_cursor' => sql_to_iso($nextCursor),
        'has_more' => $hasMore,
    ], $payload));
}

/**
 * Reads one page of an entity and works out how far the cursor may move.
 *
 * `$sql` must end with a WHERE clause (the tie-group re-query appends to it)
 * and must not carry its own ORDER BY or LIMIT.
 *
 * Ordering is `(updated_at, id)`: `updated_at` alone is not a total order, and
 * an unstable sort makes paging skip and repeat rows at page boundaries.
 *
 * @return array{0: array<int, array>, 1: bool, 2: ?string} [rows, hasMore, watermark]
 */
function sync_page(string $sql, array $params, int $limit): array
{
    // One row more than the page is asked for: its presence is what tells us
    // the page was truncated, without a second COUNT query.
    //
    // LIMIT needs a numeric literal. With EMULATE_PREPARES off a parameter is
    // bound as a string by default; MySQL 8 rejects `LIMIT '501'` outright
    // (MariaDB coerces it, which is exactly the kind of difference that makes
    // this fail only in production), so the value goes through db_int().
    $rows = db_rows(
        $sql . ' ORDER BY updated_at, id LIMIT :page_probe',
        $params + [':page_probe' => db_int($limit + 1)]
    );

    if (count($rows) <= $limit) {
        return [$rows, false, null];
    }

    $probe = array_pop($rows); // only told us that more rows exist
    $boundary = (string)$rows[count($rows) - 1]['updated_at'];

    // A group of rows sharing one `updated_at` value must never be split: the
    // cursor has millisecond resolution, so a cursor placed inside such a group
    // would strand the rest of it (those rows are not `> cursor`) and lose them
    // permanently.
    //
    // The group only needs trimming when it actually straddles the page edge,
    // which is exactly when the probe row carries the boundary timestamp too.
    // Trimming unconditionally would shrink every page by one whole timestamp
    // group for no reason.
    if ((string)$probe['updated_at'] !== $boundary) {
        return [$rows, true, $boundary];
    }

    while ($rows !== [] && (string)$rows[count($rows) - 1]['updated_at'] === $boundary) {
        array_pop($rows);
    }

    if ($rows === []) {
        // The whole page is one tie group. Deliver it in full and let the page
        // overflow — a group larger than the page limit within a single
        // millisecond is a bulk import, and correctness beats the limit here.
        $rows = db_rows(
            $sql . ' AND updated_at = :tie_boundary ORDER BY id',
            $params + [':tie_boundary' => $boundary]
        );
        return [$rows, true, $boundary];
    }

    return [$rows, true, (string)$rows[count($rows) - 1]['updated_at']];
}

/**
 * Splits a page into live records and tombstones.
 *
 * On a full load (`$isDelta` false) the query already excluded deleted rows,
 * so `deleted_ids` is empty. On a delta the client has to be told about rows
 * that left the set, otherwise a site deleted in the office stays on every
 * handset until the app is reinstalled.
 *
 * @return array{0: array<int, array>, 1: array<int, int>}
 */
function sync_split_deleted(array $rows, callable $mapper): array
{
    $records = [];
    $deletedIds = [];
    foreach ($rows as $row) {
        if (($row['deleted_at'] ?? null) !== null) {
            $deletedIds[] = (int)$row['id'];
            continue;
        }
        $records[] = $mapper($row);
    }
    return [$records, $deletedIds];
}

/** @return array{0: array, 1: array, 2: bool, 3: ?string} */
function sync_pull_sites(?string $since, int $limit): array
{
    $sql = 'SELECT id, code, name, address, updated_at, deleted_at FROM sites WHERE 1 = 1';
    $params = [];

    if ($since !== null) {
        $sql .= ' AND updated_at > :since';
        $params[':since'] = $since;
    } else {
        $sql .= ' AND deleted_at IS NULL';
    }

    [$rows, $hasMore, $watermark] = sync_page($sql, $params, $limit);
    [$records, $deletedIds] = sync_split_deleted($rows, static fn (array $r): array => [
        'id' => (int)$r['id'],
        'code' => (string)$r['code'],
        'name' => (string)$r['name'],
        'address' => $r['address'] !== null ? (string)$r['address'] : null,
        'updated_at' => sql_to_iso((string)$r['updated_at']),
    ]);

    return [$records, $deletedIds, $hasMore, $watermark];
}

/** @return array{0: array, 1: array, 2: bool, 3: ?string} */
function sync_pull_assets(?string $since, int $limit): array
{
    $sql = 'SELECT id, site_id, code, name, category, status, installed_on, updated_at, deleted_at
              FROM assets
             WHERE 1 = 1';
    $params = [];

    if ($since !== null) {
        $sql .= ' AND updated_at > :since';
        $params[':since'] = $since;
    } else {
        $sql .= ' AND deleted_at IS NULL';
    }

    [$rows, $hasMore, $watermark] = sync_page($sql, $params, $limit);
    [$records, $deletedIds] = sync_split_deleted($rows, static fn (array $r): array => [
        'id' => (int)$r['id'],
        'site_id' => (int)$r['site_id'],
        'code' => (string)$r['code'],
        'name' => (string)$r['name'],
        'category' => (string)$r['category'],
        'status' => (string)$r['status'],
        'installed_on' => $r['installed_on'] !== null ? (string)$r['installed_on'] : null,
        'updated_at' => sql_to_iso((string)$r['updated_at']),
    ]);

    return [$records, $deletedIds, $hasMore, $watermark];
}

/**
 * Inspections, scoped by role.
 *
 * A technician syncs their own work; a supervisor syncs everything, because
 * reviewing is their job. The scope is applied in SQL, not after the fetch —
 * filtering in PHP would still page over rows the caller may not see and would
 * hand out short pages for no visible reason.
 *
 * @return array{0: array, 1: array, 2: bool, 3: ?string}
 */
function sync_pull_inspections(array $user, ?string $since, int $limit): array
{
    $sql = 'SELECT id, client_uuid, asset_id, user_id, checklist_result, reading_value, reading_unit,
                   notes, performed_at, status, reviewed_at, photo_count, updated_at, deleted_at
              FROM inspections
             WHERE 1 = 1';
    $params = [];

    if (!user_can($user, 'inspections.review')) {
        $sql .= ' AND user_id = :user_id';
        $params[':user_id'] = (int)$user['id'];
    }

    if ($since !== null) {
        $sql .= ' AND updated_at > :since';
        $params[':since'] = $since;
    } else {
        $sql .= ' AND deleted_at IS NULL';
    }

    [$rows, $hasMore, $watermark] = sync_page($sql, $params, $limit);
    [$records, $deletedIds] = sync_split_deleted($rows, static fn (array $r): array => [
        'id' => (int)$r['id'],
        // Echoing client_uuid back is what lets the device match a server row
        // against the local row it created offline, instead of guessing.
        'client_uuid' => (string)$r['client_uuid'],
        'asset_id' => (int)$r['asset_id'],
        'user_id' => (int)$r['user_id'],
        'checklist_result' => (string)$r['checklist_result'],
        'reading_value' => $r['reading_value'] !== null ? (float)$r['reading_value'] : null,
        'reading_unit' => $r['reading_unit'] !== null ? (string)$r['reading_unit'] : null,
        'notes' => $r['notes'] !== null ? (string)$r['notes'] : null,
        'performed_at' => sql_to_iso((string)$r['performed_at']),
        'status' => (string)$r['status'],
        'reviewed_at' => sql_to_iso($r['reviewed_at'] ?? null),
        'photo_count' => (int)$r['photo_count'],
        'updated_at' => sql_to_iso((string)$r['updated_at']),
    ]);

    return [$records, $deletedIds, $hasMore, $watermark];
}

/* ===========================================================================
   PUSH
   =========================================================================== */

/** Operation name -> [permission slug, handler]. */
function sync_push_operations(): array
{
    return [
        'inspection.create' => ['inspections.write', 'sync_op_inspection_create'],
        'inspection.update' => ['inspections.write', 'sync_op_inspection_update'],
        'asset.set_status' => ['assets.write', 'sync_op_asset_set_status'],
    ];
}

/**
 * POST /api/v1/sync/push
 *
 * Body:
 *   { "operations": [
 *       { "client_uuid": "...", "operation": "inspection.create", "payload": { ... } }
 *   ] }
 *
 * Per-operation `status`, and what the client does with it:
 *   applied   — stored now                -> remove from the outbox
 *   duplicate — stored by an earlier try  -> remove from the outbox
 *   rejected  — a rule refused it         -> keep, flag for a human, never retry
 *
 * An operation that produces no result at all (network failure, 5xx, a batch
 * that never arrived) stays queued and is retried with backoff. That is the
 * third outcome, and it is deliberately not expressible in this response.
 */
function route_sync_push(array $user): never
{
    $body = request_body();
    $operations = $body['operations'] ?? null;

    if (!is_array($operations) || $operations === []) {
        api_fail('field_required', "Field 'operations' must be a non-empty array.", 422);
    }

    $maxOperations = (int)config_get('sync.push_max_operations');
    if (count($operations) > $maxOperations) {
        api_fail(
            'batch_too_large',
            sprintf('At most %d operations per batch.', $maxOperations),
            422,
            ['max_operations' => $maxOperations]
        );
    }

    $registry = sync_push_operations();
    $results = [];
    $counts = ['applied' => 0, 'duplicate' => 0, 'rejected' => 0];

    foreach ($operations as $index => $operation) {
        if (!is_array($operation)) {
            api_fail('invalid_operation', sprintf('Operation #%d is not an object.', (int)$index), 422);
        }

        // A malformed or missing client_uuid is fatal for the whole batch: with
        // no identity there is no way to report on that operation, and the
        // client would not know whether it ran.
        $clientUuid = field_client_uuid($operation);
        $name = (string)(field_string($operation, 'operation', 40) ?? '');
        $payload = is_array($operation['payload'] ?? null) ? $operation['payload'] : [];

        $result = ['client_uuid' => $clientUuid, 'operation' => $name];

        if (!isset($registry[$name])) {
            $results[] = $result + sync_push_rejection('unknown_operation', 'Unsupported operation name.');
            $counts['rejected']++;
            continue;
        }

        [$permission, $handler] = $registry[$name];

        // Authorisation is evaluated per operation and reported per operation.
        // Failing the whole batch with 403 would strand the operations the
        // caller *is* allowed to perform.
        if (!user_can($user, $permission)) {
            $results[] = $result + sync_push_rejection('forbidden', 'Your role does not allow this operation.');
            $counts['rejected']++;
            continue;
        }

        try {
            $outcome = idempotent_apply(
                (int)$user['id'],
                $clientUuid,
                $name,
                static fn (): array => $handler($user, $clientUuid, $payload)
            );
        } catch (OperationRejected $e) {
            $results[] = $result + sync_push_rejection($e->errorCode, $e->getMessage());
            $counts['rejected']++;
            continue;
        }

        $counts[$outcome['status']] = ($counts[$outcome['status']] ?? 0) + 1;
        $results[] = $result + [
            'status' => $outcome['status'],
            'entity_type' => $outcome['entity_type'],
            'entity_id' => $outcome['entity_id'],
            'error' => $outcome['error'],
            'message' => $outcome['message'],
        ];
    }

    api_ok([
        'results' => $results,
        'applied' => $counts['applied'],
        'duplicate' => $counts['duplicate'],
        'rejected' => $counts['rejected'],
    ]);
}

/** Uniform shape for a rejected operation. */
function sync_push_rejection(string $code, string $message): array
{
    return [
        'status' => 'rejected',
        'entity_type' => null,
        'entity_id' => null,
        'error' => $code,
        'message' => $message,
    ];
}

/* --------------------------- operation payloads --------------------------- */

/** Required payload string. Throws instead of exiting, so the batch survives. */
function op_string(array $payload, string $key, int $maxLength, bool $required = true): ?string
{
    $value = field_string($payload, $key, $maxLength);
    if ($value === null && $required) {
        throw new OperationRejected('field_required', sprintf("Field '%s' is required.", $key));
    }
    return $value;
}

/** Payload value constrained to a whitelist. */
function op_enum(array $payload, string $key, array $allowed, bool $required = true): ?string
{
    $value = field_string($payload, $key, 40);
    if ($value === null) {
        if ($required) {
            throw new OperationRejected('field_required', sprintf("Field '%s' is required.", $key));
        }
        return null;
    }
    if (!in_array($value, $allowed, true)) {
        throw new OperationRejected(
            'invalid_value',
            sprintf("Field '%s' must be one of: %s.", $key, implode(', ', $allowed))
        );
    }
    return $value;
}

/** Required payload integer. */
function op_int(array $payload, string $key): int
{
    $value = field_int($payload, $key);
    if ($value === null) {
        throw new OperationRejected('field_required', sprintf("Field '%s' must be an integer.", $key));
    }
    return $value;
}

/* ------------------------------- operations ------------------------------- */

/**
 * inspection.create
 *
 * The asset is referenced by its *server* id, which the device already has
 * because assets arrive through pull. That is why this repository never needs
 * to resolve a parent created offline during the same batch: the only entity
 * the field app creates is the inspection itself, and its children (photos)
 * are uploaded in a later phase, after the parent's server id is known.
 */
function sync_op_inspection_create(array $user, string $clientUuid, array $payload): array
{
    $assetId = op_int($payload, 'asset_id');
    $checklistResult = (string)op_enum($payload, 'checklist_result', ['pass', 'attention', 'fail']);
    $readingValue = field_float($payload, 'reading_value');
    $readingUnit = op_string($payload, 'reading_unit', 20, false);
    $notes = op_string($payload, 'notes', 2000, false);
    $performedAt = field_timestamp($payload, 'performed_at', db_now());

    $asset = db_row(
        'SELECT id FROM assets WHERE id = :asset_id AND deleted_at IS NULL LIMIT 1',
        [':asset_id' => $assetId]
    );
    if ($asset === null) {
        // Permanent: the asset was removed or never existed. Retrying an
        // identical payload can only fail the same way, so the client must
        // surface it rather than loop.
        throw new OperationRejected('asset_not_found', 'The asset does not exist or was removed.');
    }

    db_exec(
        'INSERT INTO inspections
            (client_uuid, asset_id, user_id, checklist_result, reading_value, reading_unit,
             notes, performed_at, status, created_at, updated_at)
         VALUES
            (:client_uuid, :asset_id, :user_id, :checklist_result, :reading_value, :reading_unit,
             :notes, :performed_at, :status, NOW(3), NOW(3))',
        [
            ':client_uuid' => $clientUuid,
            ':asset_id' => $assetId,
            ':user_id' => (int)$user['id'],
            ':checklist_result' => $checklistResult,
            ':reading_value' => $readingValue,
            ':reading_unit' => $readingUnit,
            ':notes' => $notes,
            ':performed_at' => $performedAt,
            ':status' => 'submitted',
        ]
    );

    $id = (int)db()->lastInsertId();

    return ['inspection', $id, ['id' => $id, 'client_uuid' => $clientUuid, 'status' => 'submitted']];
}

/**
 * inspection.update
 *
 * Conflict policy in one place: the client's write wins over the server's
 * copy, field by field, UNLESS a supervisor has already reviewed the record.
 * A review is a human decision about the data as it stood; silently
 * overwriting it would erase that decision without anyone noticing.
 *
 * The rejection is permanent. The technician sees the record marked as
 * conflicting and decides what to do, which is the only correct place for
 * that decision.
 */
function sync_op_inspection_update(array $user, string $clientUuid, array $payload): array
{
    $targetUuid = (string)op_string($payload, 'inspection_client_uuid', 36);

    $inspection = db_row(
        'SELECT id, user_id, status FROM inspections
          WHERE client_uuid = :target_uuid AND deleted_at IS NULL
          LIMIT 1',
        [':target_uuid' => $targetUuid]
    );
    if ($inspection === null) {
        throw new OperationRejected('inspection_not_found', 'The inspection does not exist on the server yet.');
    }
    if ((int)$inspection['user_id'] !== (int)$user['id'] && !user_can($user, 'inspections.review')) {
        throw new OperationRejected('forbidden', 'You can only edit your own inspections.');
    }
    if ((string)$inspection['status'] === 'reviewed') {
        throw new OperationRejected('conflict', 'A supervisor already reviewed this inspection.');
    }

    $checklistResult = op_enum($payload, 'checklist_result', ['pass', 'attention', 'fail'], false);
    $readingValue = field_float($payload, 'reading_value');
    $notes = op_string($payload, 'notes', 2000, false);

    // COALESCE keeps the stored value for any field the client left out, so a
    // partial update never blanks columns it never intended to touch.
    db_exec(
        'UPDATE inspections
            SET checklist_result = COALESCE(:checklist_result, checklist_result),
                reading_value    = COALESCE(:reading_value, reading_value),
                notes            = COALESCE(:notes, notes),
                updated_at       = NOW(3)
          WHERE id = :inspection_id',
        [
            ':checklist_result' => $checklistResult,
            ':reading_value' => $readingValue,
            ':notes' => $notes,
            ':inspection_id' => (int)$inspection['id'],
        ]
    );

    $id = (int)$inspection['id'];
    return ['inspection', $id, ['id' => $id, 'client_uuid' => $targetUuid]];
}

/**
 * asset.set_status
 *
 * Supervisor-only, and the reason the role check is not decorative: a
 * technician records what they saw, a supervisor decides what it means for the
 * asset. Both operations travel through the same offline queue.
 */
function sync_op_asset_set_status(array $user, string $clientUuid, array $payload): array
{
    $assetId = op_int($payload, 'asset_id');
    $status = (string)op_enum($payload, 'status', ['operational', 'degraded', 'out_of_service']);

    $changed = db_exec(
        'UPDATE assets
            SET status = :status, updated_at = NOW(3)
          WHERE id = :asset_id AND deleted_at IS NULL',
        [':status' => $status, ':asset_id' => $assetId]
    );

    if ($changed === 0) {
        // rowCount() is 0 both when the asset is missing and when the status
        // already had this value. Distinguish, so a no-op is not reported as a
        // failure the technician has to act on.
        $exists = db_row(
            'SELECT id FROM assets WHERE id = :asset_id AND deleted_at IS NULL LIMIT 1',
            [':asset_id' => $assetId]
        );
        if ($exists === null) {
            throw new OperationRejected('asset_not_found', 'The asset does not exist or was removed.');
        }
    }

    return ['asset', $assetId, ['id' => $assetId, 'status' => $status]];
}
