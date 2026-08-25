<?php
declare(strict_types=1);

/**
 * Dependency-free `.env` reader.
 *
 * There is no Composer in this project, so there is no vlucas/phpdotenv. The
 * file format supported here is deliberately small: `KEY=value` lines, `#`
 * comments, optional surrounding quotes. Anything more exotic belongs in a
 * real configuration system, not in a hand-rolled parser.
 *
 * Values are read once and cached for the lifetime of the request.
 */

/** Absolute path of the `api/` directory. */
function api_root(): string
{
    return dirname(__DIR__);
}

/** Absolute path of the repository root (one level above `api/`). */
function repo_root(): string
{
    return dirname(api_root());
}

/** Parses the `.env` file at the repository root. Missing file is not an error. */
function env_all(): array
{
    static $values = null;
    if ($values !== null) {
        return $values;
    }

    $values = [];
    $path = repo_root() . DIRECTORY_SEPARATOR . '.env';
    if (!is_readable($path)) {
        return $values;
    }

    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    foreach ($lines === false ? [] : $lines as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) {
            continue;
        }
        $split = strpos($line, '=');
        if ($split === false) {
            continue;
        }
        $key = trim(substr($line, 0, $split));
        $raw = trim(substr($line, $split + 1));

        // Strip an inline comment, but only when it is not inside quotes.
        if (!str_starts_with($raw, '"') && !str_starts_with($raw, "'")) {
            $hash = strpos($raw, ' #');
            if ($hash !== false) {
                $raw = rtrim(substr($raw, 0, $hash));
            }
        }
        $raw = trim($raw, "\"'");

        if ($key !== '') {
            $values[$key] = $raw;
        }
    }

    return $values;
}

/** Raw environment value. Real environment variables win over the `.env` file. */
function env_get(string $key, ?string $default = null): ?string
{
    $fromProcess = getenv($key);
    if ($fromProcess !== false && $fromProcess !== '') {
        return $fromProcess;
    }
    $values = env_all();
    return array_key_exists($key, $values) && $values[$key] !== '' ? $values[$key] : $default;
}

/** Integer environment value with a mandatory fallback. */
function env_int(string $key, int $default): int
{
    $value = env_get($key);
    return $value !== null && is_numeric($value) ? (int)$value : $default;
}

/** Comma-separated list, trimmed, empty entries dropped. */
function env_list(string $key): array
{
    $value = (string)env_get($key, '');
    if (trim($value) === '') {
        return [];
    }
    return array_values(array_filter(array_map('trim', explode(',', $value)), static fn ($v) => $v !== ''));
}
