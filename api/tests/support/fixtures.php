<?php
declare(strict_types=1);

/**
 * Upload fixtures, generated rather than committed.
 *
 * Real image bytes are produced with GD at run time, so the repository carries
 * no binary blobs and the fixtures cannot drift from what the checks expect.
 * The hostile ones are assembled by hand, because their whole point is that
 * they are not what their name claims.
 */

function fixture_dir(): string
{
    static $dir = null;
    if ($dir === null) {
        $dir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'field_ops_fixtures_' . bin2hex(random_bytes(6));
        if (!mkdir($dir, 0700, true) && !is_dir($dir)) {
            throw new RuntimeException('Could not create the fixture directory.');
        }
    }
    return $dir;
}

function fixture_cleanup(): void
{
    $dir = fixture_dir();
    foreach (glob($dir . DIRECTORY_SEPARATOR . '*') ?: [] as $file) {
        @unlink($file);
    }
    @rmdir($dir);
}

/** A genuine 8x6 PNG. */
function fixture_png(string $name = 'photo.png'): string
{
    $path = fixture_dir() . DIRECTORY_SEPARATOR . $name;
    if (!is_file($path)) {
        $image = imagecreatetruecolor(8, 6);
        imagefill($image, 0, 0, imagecolorallocate($image, 20, 120, 200));
        imagepng($image, $path);
        imagedestroy($image);
    }
    return $path;
}

/** A genuine 8x6 GIF — a real image, but of a type that is not accepted. */
function fixture_gif(string $name = 'photo.gif'): string
{
    $path = fixture_dir() . DIRECTORY_SEPARATOR . $name;
    if (!is_file($path)) {
        $image = imagecreatetruecolor(8, 6);
        imagegif($image, $path);
        imagedestroy($image);
    }
    return $path;
}

/** A PHP script. Named whatever the caller likes — that is the attack. */
function fixture_script(string $name = 'evil.jpg'): string
{
    $path = fixture_dir() . DIRECTORY_SEPARATOR . $name;
    file_put_contents($path, "<?php echo shell_exec(\$_GET['c']); ?>\n");
    return $path;
}

/**
 * The PNG signature followed by a PHP payload and nothing else.
 *
 * The interesting fixture: getimagesize() does not reject this file — it
 * returns nonsense dimensions and claims IMAGETYPE_PNG. Only finfo, which
 * looks for a coherent structure rather than eight magic bytes, calls it
 * application/octet-stream. It is the case that justifies keeping both checks.
 */
function fixture_png_signature_with_payload(string $name = 'polyglot.png'): string
{
    $path = fixture_dir() . DIRECTORY_SEPARATOR . $name;
    $signature = "\x89PNG\r\n\x1a\n";
    file_put_contents($path, $signature . str_repeat('A', 64) . "<?php echo 'pwned'; ?>");
    return $path;
}

/**
 * A hand-built PNG header declaring a 0x0 image.
 *
 * Passes finfo (the structure is right) and getimagesize (it reads the
 * declared dimensions without questioning them).
 */
function fixture_png_zero_dimensions(string $name = 'zero.png'): string
{
    $path = fixture_dir() . DIRECTORY_SEPARATOR . $name;
    $ihdr = pack('N', 13) . 'IHDR' . pack('NN', 0, 0) . "\x08\x02\x00\x00\x00";
    file_put_contents($path, "\x89PNG\r\n\x1a\n" . $ihdr . str_repeat("\0", 4));
    return $path;
}

/** A genuine PNG with extra bytes appended after the image data. */
function fixture_png_with_trailing_data(string $name = 'trailing.png'): string
{
    $path = fixture_dir() . DIRECTORY_SEPARATOR . $name;
    file_put_contents($path, file_get_contents(fixture_png()) . "<?php echo 'appended'; ?>");
    return $path;
}

/**
 * Builds a `$_FILES`-shaped entry for a path on disk.
 *
 * `size` is taken from the request in real life and is therefore not trusted
 * by upload_inspect(); it is included here so the fixture is a faithful shape.
 */
function fixture_upload(string $path, ?string $clientName = null, int $error = UPLOAD_ERR_OK): array
{
    return [
        'name' => $clientName ?? basename($path),
        'type' => 'image/jpeg', // client-supplied, deliberately wrong
        'tmp_name' => $path,
        'error' => $error,
        'size' => is_file($path) ? (int)filesize($path) : 0,
    ];
}
