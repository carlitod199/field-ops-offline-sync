<?php
declare(strict_types=1);

/**
 * Upload validation and storage for inspection photos.
 *
 * The rule this file exists to enforce: *the bytes decide*. A filename is
 * attacker-controlled metadata; `$_FILES['photo']['type']` is a client-supplied
 * header and equally worthless. `evil.php` renamed to `evil.jpg` passes an
 * extension check and a Content-Type check and fails the two checks below.
 *
 * Validation runs in this order:
 *   1. the upload actually succeeded (PHP's own error code)
 *   2. size is within bounds
 *   3. the extension is on a short allow-list  — cheap, filters obvious junk
 *   4. finfo reports an allowed MIME type from the file's magic bytes
 *   5. getimagesize() confirms the file parses as the image type it claims
 *
 * Steps 4 and 5 are not redundant, and the reason is not the obvious one.
 * Measured behaviour on PHP 8.4 (see api/tests/cases/uploads_test.php, which
 * asserts all of this rather than assuming it):
 *
 *   - A file consisting of the PNG signature followed by arbitrary bytes is
 *     reported by finfo as application/octet-stream, so step 4 rejects it.
 *     getimagesize() on that same file does NOT fail — it returns nonsense
 *     dimensions and claims IMAGETYPE_PNG. Step 5 alone would let it through.
 *
 *   - Conversely, step 5 is what enforces that the decoded type matches the
 *     detected one, and that the image has real dimensions. A crafted IHDR
 *     declaring a 0x0 image satisfies finfo and is rejected here.
 *
 * Each check covers a case the other misses, which is why both run.
 *
 * What neither catches: a genuinely valid image with extra bytes appended
 * after the end of the image data. That file *is* a real image, and it is
 * accepted. It is harmless here because stored files are given a generated
 * name, kept outside the web root, and never served by path — but the
 * limitation is real and is asserted in the test suite so it stays visible.
 *
 * Stored files get a random name and a directory outside the web root. The
 * original name is kept in the database for display only and is never used to
 * build a path.
 */

require_once __DIR__ . '/response.php';
require_once __DIR__ . '/../config.php';

/** MIME type -> canonical extension, and simultaneously the allow-list. */
const UPLOAD_ALLOWED_TYPES = [
    'image/jpeg' => 'jpg',
    'image/png' => 'png',
    'image/webp' => 'webp',
];

/** Extensions accepted on the incoming filename. */
const UPLOAD_ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

/** IMAGETYPE_* constant -> MIME type, for the getimagesize() cross-check. */
const UPLOAD_IMAGETYPE_MIME = [
    IMAGETYPE_JPEG => 'image/jpeg',
    IMAGETYPE_PNG => 'image/png',
    IMAGETYPE_WEBP => 'image/webp',
];

/**
 * Inspects one entry of `$_FILES` and reports what it found.
 *
 * Deliberately returns a verdict instead of ending the request: the checks are
 * the interesting part of this file and they can only be tested if calling
 * them does not terminate the process. upload_validate() below is the thin
 * wrapper that turns a verdict into an HTTP response.
 *
 * `$requireUploadedFile` exists for the same reason. In a real request the
 * is_uploaded_file() check is what stops a crafted body from pointing the
 * handler at an arbitrary server-side path, so it must stay on; a test feeding
 * a fixture from disk turns it off explicitly.
 *
 * @return array{ok: bool, code?: string, message?: string, status?: int, details?: array,
 *                tmp_path?: string, mime?: string, extension?: string, size?: int,
 *                original_name?: string, width?: int, height?: int}
 */
function upload_inspect(array $file, int $maxBytes, bool $requireUploadedFile = true): array
{
    $error = (int)($file['error'] ?? UPLOAD_ERR_NO_FILE);
    if ($error !== UPLOAD_ERR_OK) {
        // INI_SIZE/FORM_SIZE deserve their own code: the client can react by
        // re-compressing, whereas the other errors are server-side problems.
        $code = in_array($error, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true)
            ? 'file_too_large'
            : 'upload_failed';

        return upload_problem($code, 'The file did not arrive complete.', 422, ['php_upload_error' => $error]);
    }

    $tmpPath = (string)($file['tmp_name'] ?? '');
    if ($tmpPath === '' || !is_file($tmpPath)) {
        return upload_problem('upload_failed', 'No uploaded file found in the request.', 422);
    }
    if ($requireUploadedFile && !is_uploaded_file($tmpPath)) {
        return upload_problem('upload_failed', 'No uploaded file found in the request.', 422);
    }

    // Trust the bytes on disk over the reported size: `size` comes from the
    // request, and only the file itself can say how large it really is.
    $size = (int)filesize($tmpPath);
    if ($size <= 0 || $size > $maxBytes) {
        return upload_problem(
            'file_too_large',
            sprintf('The file must be between 1 byte and %d bytes.', $maxBytes),
            422
        );
    }

    $originalName = mb_substr((string)($file['name'] ?? 'photo'), 0, 200);
    $extension = strtolower((string)pathinfo($originalName, PATHINFO_EXTENSION));
    if (!in_array($extension, UPLOAD_ALLOWED_EXTENSIONS, true)) {
        return upload_problem('invalid_extension', 'Only jpg, jpeg, png and webp files are accepted.', 422);
    }

    // (4) magic bytes
    $mime = (string)(new finfo(FILEINFO_MIME_TYPE))->file($tmpPath);
    if (!array_key_exists($mime, UPLOAD_ALLOWED_TYPES)) {
        return upload_problem(
            'invalid_content',
            'The file content is not a JPEG, PNG or WebP image.',
            422,
            ['detected' => $mime]
        );
    }

    // (5) the file must parse as an image, and as *that* image type
    $info = @getimagesize($tmpPath);
    if ($info === false || !isset($info[2]) || !isset(UPLOAD_IMAGETYPE_MIME[$info[2]])) {
        return upload_problem('invalid_content', 'The file could not be decoded as an image.', 422);
    }
    if (UPLOAD_IMAGETYPE_MIME[$info[2]] !== $mime) {
        return upload_problem('invalid_content', 'The file header and its content disagree.', 422);
    }
    // A crafted header can declare a zero-sized image, which satisfies both
    // finfo and getimagesize but is not a photograph of anything.
    if ((int)$info[0] <= 0 || (int)$info[1] <= 0) {
        return upload_problem('invalid_content', 'The image has no usable dimensions.', 422);
    }

    return [
        'ok' => true,
        'tmp_path' => $tmpPath,
        'mime' => $mime,
        'extension' => UPLOAD_ALLOWED_TYPES[$mime],
        'size' => $size,
        'original_name' => $originalName,
        'width' => (int)$info[0],
        'height' => (int)$info[1],
    ];
}

/** Uniform shape for a failed inspection. */
function upload_problem(string $code, string $message, int $status, ?array $details = null): array
{
    return [
        'ok' => false,
        'code' => $code,
        'message' => $message,
        'status' => $status,
        'details' => $details,
    ];
}

/**
 * Route-facing wrapper: inspects, and ends the request on any problem.
 *
 * @return array{tmp_path:string, mime:string, extension:string, size:int, original_name:string, width:int, height:int}
 */
function upload_validate(array $file): array
{
    $verdict = upload_inspect($file, (int)config_get('upload.max_bytes'));

    if ($verdict['ok'] !== true) {
        api_fail($verdict['code'], $verdict['message'], $verdict['status'], $verdict['details']);
    }

    unset($verdict['ok']);
    return $verdict;
}

/**
 * Moves a validated upload into storage under a random name.
 *
 * Files are sharded by year and month so a single directory never accumulates
 * an unbounded number of entries.
 *
 * @return array{relative_path:string, absolute_path:string, sha256:string}
 */
function upload_store(array $validated): array
{
    $base = (string)config_get('upload.dir');
    $shard = gmdate('Y') . DIRECTORY_SEPARATOR . gmdate('m');
    $directory = $base . DIRECTORY_SEPARATOR . $shard;

    if (!is_dir($directory) && !mkdir($directory, 0775, true) && !is_dir($directory)) {
        api_fail('storage_unavailable', 'Could not prepare the upload directory.', 500);
    }

    // The stored name is generated, never derived from the client's filename.
    $fileName = bin2hex(random_bytes(16)) . '.' . $validated['extension'];
    $absolute = $directory . DIRECTORY_SEPARATOR . $fileName;

    // Hash before moving: after move_uploaded_file() the temp path is gone.
    $sha256 = (string)hash_file('sha256', $validated['tmp_path']);

    if (!move_uploaded_file($validated['tmp_path'], $absolute)) {
        api_fail('storage_unavailable', 'Could not store the uploaded file.', 500);
    }
    @chmod($absolute, 0644);

    return [
        'relative_path' => $shard . '/' . $fileName,
        'absolute_path' => $absolute,
        'sha256' => $sha256,
    ];
}
