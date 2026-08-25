<?php
declare(strict_types=1);

/**
 * The response envelope.
 *
 * Every endpoint answers with the same shape, so the mobile client has exactly
 * one place that unwraps a response and exactly one place that turns a failure
 * into a typed error:
 *
 *   success  { "ok": true,  "data": <any>, "message": <string|null>,
 *              "meta": { "server_time": "2026-08-25T12:00:00.000Z" } }
 *   failure  { "ok": false, "error": "<stable_code>", "message": "<human text>",
 *              "details": <any|null> }
 *
 * `error` is a stable machine code. The client branches on it and never on the
 * message text, which is free to change or be translated.
 */

require_once __DIR__ . '/database.php';

/** Emits the JSON body and terminates the request. */
function respond(array $payload, int $status): never
{
    if (!headers_sent()) {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        // Sync payloads are user-specific and time-sensitive; never let an
        // intermediary cache them.
        header('Cache-Control: no-store');
        header('X-Content-Type-Options: nosniff');
    }
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

/**
 * Success envelope.
 *
 * `meta.server_time` always carries the database clock, not the PHP clock. The
 * two can drift apart (different hosts, different time zones) and the client
 * compares this value against `updated_at` columns that MySQL stamps itself.
 * Handing out a PHP timestamp here is how delta cursors silently start hiding
 * rows.
 */
function api_ok(mixed $data = null, ?string $message = null, int $status = 200): never
{
    respond([
        'ok' => true,
        'data' => $data,
        'message' => $message,
        'meta' => ['server_time' => db_now_iso()],
    ], $status);
}

/** Failure envelope with a stable machine-readable code. */
function api_fail(string $code, string $message, int $status = 400, mixed $details = null): never
{
    respond([
        'ok' => false,
        'error' => $code,
        'message' => $message,
        'details' => $details,
    ], $status);
}
