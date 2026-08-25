<?php
declare(strict_types=1);

/**
 * Turns every failure mode into the JSON error envelope.
 *
 * A framework-free PHP API has three ways of leaking an HTML error page to a
 * client that only knows how to parse JSON: an uncaught throwable, a PHP
 * warning/notice printed inline, and a fatal error at shutdown. All three are
 * captured here, so `http.js` on the device can rely on "the body is always
 * JSON" and does not need an HTML-detection fallback.
 *
 * Detail is only echoed back when APP_ENV=local. Elsewhere the client sees a
 * generic message and the detail goes to the log file.
 */

require_once __DIR__ . '/response.php';
require_once __DIR__ . '/../config.php';

/** Appends one timestamped line to the configured log file. */
function log_line(string $message): void
{
    $file = (string)config_get('log_file');
    $dir = dirname($file);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        error_log($message);
        return;
    }
    @file_put_contents(
        $file,
        sprintf("[%s] %s%s", gmdate('Y-m-d\TH:i:s\Z'), $message, PHP_EOL),
        FILE_APPEND | LOCK_EX
    );
}

/** True when the deployment is allowed to expose internal detail. */
function errors_verbose(): bool
{
    return config_get('env') === 'local';
}

/** Installs the handlers. Called once, from the front controller. */
function errors_install(): void
{
    // Report everything; the handlers decide what the client is told.
    error_reporting(E_ALL);
    ini_set('display_errors', '0');
    ini_set('log_errors', '1');

    set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
        // Respect the `@` operator and any error_reporting() narrowing.
        if ((error_reporting() & $severity) === 0) {
            return false;
        }
        // Promote to an exception so a single catch site handles both worlds.
        throw new ErrorException($message, 0, $severity, $file, $line);
    });

    set_exception_handler(static function (Throwable $e): void {
        errors_report($e);
    });

    register_shutdown_function(static function (): void {
        $fatal = error_get_last();
        if ($fatal === null || !in_array($fatal['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
            return;
        }
        log_line(sprintf('FATAL %s in %s:%d', $fatal['message'], $fatal['file'], $fatal['line']));
        if (headers_sent()) {
            return;
        }
        api_fail(
            'internal_error',
            errors_verbose() ? $fatal['message'] : 'Internal server error.',
            500
        );
    });
}

/** Logs a throwable and answers with a 500 envelope. */
function errors_report(Throwable $e): never
{
    log_line(sprintf(
        '%s: %s in %s:%d%s%s',
        $e::class,
        $e->getMessage(),
        $e->getFile(),
        $e->getLine(),
        PHP_EOL,
        $e->getTraceAsString()
    ));

    api_fail(
        'internal_error',
        errors_verbose() ? $e->getMessage() : 'Internal server error.',
        500,
        errors_verbose() ? ['file' => $e->getFile(), 'line' => $e->getLine()] : null
    );
}
