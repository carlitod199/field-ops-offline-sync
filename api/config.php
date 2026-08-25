<?php
declare(strict_types=1);

/**
 * Single configuration entry point. Every other file reads settings from here
 * rather than calling env_get() directly, so the set of knobs is visible in
 * one place and `.env.example` can be kept honest.
 */

require_once __DIR__ . '/core/env.php';

/** @return array<string, mixed> */
function config(): array
{
    static $config = null;
    if ($config !== null) {
        return $config;
    }

    $uploadDir = (string)env_get('UPLOAD_DIR', 'api/storage/uploads');
    // A relative UPLOAD_DIR is resolved against the repository root so the
    // same `.env` works from the CLI and from a web server document root.
    if (!str_starts_with($uploadDir, DIRECTORY_SEPARATOR)) {
        $uploadDir = repo_root() . DIRECTORY_SEPARATOR . $uploadDir;
    }

    $logFile = (string)env_get('APP_LOG_FILE', 'api/storage/logs/api.log');
    if (!str_starts_with($logFile, DIRECTORY_SEPARATOR)) {
        $logFile = repo_root() . DIRECTORY_SEPARATOR . $logFile;
    }

    $config = [
        'env' => (string)env_get('APP_ENV', 'production'),
        'log_file' => $logFile,

        'db' => [
            'host' => (string)env_get('DB_HOST', '127.0.0.1'),
            'port' => env_int('DB_PORT', 3306),
            'name' => (string)env_get('DB_NAME', 'field_ops'),
            'user' => (string)env_get('DB_USER', 'root'),
            'pass' => (string)env_get('DB_PASS', ''),
            'charset' => (string)env_get('DB_CHARSET', 'utf8mb4'),
        ],

        'token' => [
            'ttl_days' => env_int('TOKEN_TTL_DAYS', 30),
            'absolute_days' => env_int('TOKEN_ABSOLUTE_DAYS', 90),
        ],

        'login' => [
            'max_attempts' => env_int('LOGIN_MAX_ATTEMPTS', 8),
            'window_minutes' => env_int('LOGIN_WINDOW_MINUTES', 15),
        ],

        'sync' => [
            'cursor_overlap_seconds' => env_int('SYNC_CURSOR_OVERLAP_SECONDS', 5),
            'page_limit' => env_int('SYNC_PAGE_LIMIT', 500),
            'push_max_operations' => env_int('SYNC_PUSH_MAX_OPERATIONS', 100),
        ],

        'upload' => [
            'dir' => $uploadDir,
            'max_bytes' => env_int('UPLOAD_MAX_BYTES', 8 * 1024 * 1024),
        ],

        'cors_allowed_origins' => env_list('CORS_ALLOWED_ORIGINS'),
    ];

    return $config;
}

/** Dotted lookup into config(), e.g. config_get('sync.page_limit'). */
function config_get(string $path, mixed $default = null): mixed
{
    $node = config();
    foreach (explode('.', $path) as $segment) {
        if (!is_array($node) || !array_key_exists($segment, $node)) {
            return $default;
        }
        $node = $node[$segment];
    }
    return $node;
}
