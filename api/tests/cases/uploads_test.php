<?php
declare(strict_types=1);

/**
 * Upload validation.
 *
 * Each case feeds real bytes to the real checks. `upload_inspect()` returns a
 * verdict rather than ending the request, which is what makes this possible;
 * `upload_validate()` is the thin wrapper that turns a verdict into a 422.
 *
 * `requireUploadedFile` is passed as false throughout: these fixtures come from
 * disk, not from a multipart body, so PHP's is_uploaded_file() would reject
 * them. That check is exercised by the shape of the production call, not here.
 */

const MAX_BYTES = 8 * 1024 * 1024;

test_group('upload validation (unit, real bytes)');

test_case('a genuine PNG is accepted with the facts read from its content', function (): void {
    $verdict = upload_inspect(fixture_upload(fixture_png()), MAX_BYTES, false);

    assert_true($verdict['ok']);
    assert_same('image/png', $verdict['mime']);
    assert_same('png', $verdict['extension']);
    assert_same(8, $verdict['width']);
    assert_same(6, $verdict['height']);
    assert_true($verdict['size'] > 0);
});

test_case('the stored extension comes from the bytes, not from the filename', function (): void {
    // A real PNG uploaded as "photo.jpg". The extension allow-list lets it
    // through, but the recorded type must follow the content, or the file is
    // saved on disk under an extension that does not match what it is.
    $verdict = upload_inspect(fixture_upload(fixture_png('mislabelled.png'), 'photo.jpg'), MAX_BYTES, false);

    assert_true($verdict['ok']);
    assert_same('image/png', $verdict['mime']);
    assert_same('png', $verdict['extension'], 'extension must follow the MIME type');
});

test_case('a PHP script named .jpg is refused on its content', function (): void {
    $verdict = upload_inspect(fixture_upload(fixture_script('evil.jpg')), MAX_BYTES, false);

    assert_false($verdict['ok']);
    assert_same('invalid_content', $verdict['code']);
});

test_case('the PNG signature with a payload behind it is refused, and only finfo catches it', function (): void {
    // This is the case that proves the two content checks are not redundant —
    // and it proves it in the opposite direction to the intuitive one.
    $path = fixture_png_signature_with_payload();

    // getimagesize does NOT reject this file. It reads the bytes where the
    // dimensions ought to be and reports them as if they were real.
    $probe = @getimagesize($path);
    assert_false($probe === false, 'getimagesize alone accepts this file');
    assert_same(IMAGETYPE_PNG, $probe[2], 'and it even claims the file is a PNG');

    // finfo, which wants a coherent structure, is not fooled.
    $detected = (new finfo(FILEINFO_MIME_TYPE))->file($path);
    assert_same('application/octet-stream', $detected);

    $verdict = upload_inspect(fixture_upload($path), MAX_BYTES, false);
    assert_false($verdict['ok']);
    assert_same('invalid_content', $verdict['code']);
    assert_same(['detected' => 'application/octet-stream'], $verdict['details']);
});

test_case('a header declaring a zero-sized image is refused', function (): void {
    // Passes finfo and getimagesize; caught by the dimension check.
    $path = fixture_png_zero_dimensions();
    assert_same('image/png', (new finfo(FILEINFO_MIME_TYPE))->file($path), 'finfo accepts it');

    $verdict = upload_inspect(fixture_upload($path), MAX_BYTES, false);
    assert_false($verdict['ok']);
    assert_same('invalid_content', $verdict['code']);
    assert_same('The image has no usable dimensions.', $verdict['message']);
});

test_case('KNOWN LIMIT: a valid image with appended bytes is accepted', function (): void {
    // Asserted so the limitation stays visible instead of being assumed away.
    // The file genuinely is a decodable PNG; nothing in the pipeline can say
    // otherwise. It is safe here only because stored files get a generated
    // name, live outside the web root, and are never served by path.
    $verdict = upload_inspect(fixture_upload(fixture_png_with_trailing_data()), MAX_BYTES, false);

    assert_true($verdict['ok'], 'this is the current, accepted behaviour');
    assert_same('image/png', $verdict['mime']);
});

test_case('a real image of a disallowed type is refused on its extension', function (): void {
    $verdict = upload_inspect(fixture_upload(fixture_gif()), MAX_BYTES, false);

    assert_false($verdict['ok']);
    assert_same('invalid_extension', $verdict['code']);
});

test_case('a file larger than the limit is refused', function (): void {
    // A ceiling one byte below the fixture's real size, so the case cannot
    // silently stop testing anything if the fixture changes size.
    $path = fixture_png();
    $ceiling = (int)filesize($path) - 1;

    $verdict = upload_inspect(fixture_upload($path), $ceiling, false);

    assert_false($verdict['ok']);
    assert_same('file_too_large', $verdict['code']);
    assert_same(422, $verdict['status']);
});

test_case('a file exactly at the limit is accepted', function (): void {
    $path = fixture_png();
    $verdict = upload_inspect(fixture_upload($path), (int)filesize($path), false);

    assert_true($verdict['ok'], 'the bound is inclusive');
});

test_case('the size limit is read from the file, not from the request', function (): void {
    // A client that understates `size` must not be able to slip a large file
    // past the ceiling.
    $path = fixture_png();
    $entry = fixture_upload($path);
    $entry['size'] = 10; // a lie

    $verdict = upload_inspect($entry, (int)filesize($path) - 1, false);
    assert_false($verdict['ok'], 'the understated size must be ignored');
    assert_same('file_too_large', $verdict['code']);
});

test_case('UPLOAD_ERR_INI_SIZE is reported as file_too_large', function (): void {
    $verdict = upload_inspect(fixture_upload(fixture_png(), null, UPLOAD_ERR_INI_SIZE), MAX_BYTES, false);

    assert_false($verdict['ok']);
    assert_same('file_too_large', $verdict['code']);
    assert_same(['php_upload_error' => UPLOAD_ERR_INI_SIZE], $verdict['details']);
});

test_case('UPLOAD_ERR_PARTIAL is reported as upload_failed', function (): void {
    $verdict = upload_inspect(fixture_upload(fixture_png(), null, UPLOAD_ERR_PARTIAL), MAX_BYTES, false);

    assert_false($verdict['ok']);
    assert_same('upload_failed', $verdict['code']);
});

test_case('UPLOAD_ERR_NO_FILE is reported as upload_failed', function (): void {
    $verdict = upload_inspect(['error' => UPLOAD_ERR_NO_FILE], MAX_BYTES, false);

    assert_false($verdict['ok']);
    assert_same('upload_failed', $verdict['code']);
});

test_case('a missing temporary file is refused', function (): void {
    $entry = fixture_upload(fixture_png());
    $entry['tmp_name'] = fixture_dir() . '/does-not-exist.png';

    $verdict = upload_inspect($entry, MAX_BYTES, false);
    assert_false($verdict['ok']);
    assert_same('upload_failed', $verdict['code']);
});

test_case('a path outside the upload is rejected when the uploaded-file check is on', function (): void {
    // The production call leaves requireUploadedFile at its default. Without
    // it, a crafted request could name any readable path on the server.
    $verdict = upload_inspect(fixture_upload(fixture_png()), MAX_BYTES, true);

    assert_false($verdict['ok']);
    assert_same('upload_failed', $verdict['code']);
});
