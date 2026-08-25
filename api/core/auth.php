<?php
declare(strict_types=1);

/**
 * Bearer-token authentication for the field app.
 *
 * Design notes, and why the token is what it is:
 *
 *  - The token is *opaque*: 32 random bytes rendered as 64 hex characters. It
 *    is not a JWT. A field handset stays logged in for weeks, so the ability to
 *    revoke a single device immediately outweighs the stateless verification a
 *    JWT would buy — and a stateless token cannot be revoked without building
 *    the very lookup table a JWT was supposed to avoid.
 *
 *  - Only the SHA-256 of the token is stored. A dump of `auth_tokens` therefore
 *    does not yield usable sessions. SHA-256 (not bcrypt) is correct here
 *    precisely because the token is 256 bits of entropy: there is no dictionary
 *    to slow down, and the digest is on the hot path of every request.
 *
 *  - The lifetime is sliding with an absolute ceiling: each authenticated call
 *    may push `expires_at` out by TOKEN_TTL_DAYS, but never past
 *    `created_at + TOKEN_ABSOLUTE_DAYS`. A device that is never logged out
 *    still has to re-authenticate eventually.
 *
 *  - `last_used_at` is written at most once a minute, so a busy sync loop does
 *    not turn every read into a write.
 *
 * There is no PHP session involved anywhere in this API: no cookie is set, no
 * `session_start()` is called, and CSRF is therefore not applicable. That is a
 * deliberate consequence of being a token API consumed by a native client.
 */

require_once __DIR__ . '/database.php';
require_once __DIR__ . '/response.php';
require_once __DIR__ . '/../config.php';

/** Reads the bearer token from the Authorization header. */
function auth_bearer_token(): ?string
{
    $header = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '');

    // Some CGI/FastCGI setups drop Authorization from $_SERVER. The .htaccess
    // in this directory restores it, but ask Apache directly as a fallback.
    if ($header === '' && function_exists('apache_request_headers')) {
        $headers = array_change_key_case((array)apache_request_headers(), CASE_LOWER);
        $header = (string)($headers['authorization'] ?? '');
    }

    if (preg_match('/^Bearer\s+([a-f0-9]{64})$/i', trim($header), $m) !== 1) {
        return null;
    }
    return strtolower($m[1]);
}

/**
 * Authenticates the request and returns the user row.
 *
 * The failure codes are distinct on purpose (`token_missing`, `token_invalid`,
 * `token_revoked`, `token_expired`): the client treats all four as "drop the
 * local session", but distinguishing them makes support conversations and log
 * analysis possible.
 */
function auth_require_user(): array
{
    $token = auth_bearer_token();
    if ($token === null) {
        api_fail('token_missing', 'Authentication required.', 401);
    }

    $row = db_row(
        'SELECT t.id AS token_id, t.expires_at, t.revoked_at, t.last_used_at,
                u.id, u.name, u.email, u.role, u.is_active
           FROM auth_tokens t
           JOIN users u ON u.id = t.user_id
          WHERE t.token_hash = :token_hash
          LIMIT 1',
        [':token_hash' => hash('sha256', $token)]
    );

    if ($row === null || (int)$row['is_active'] !== 1) {
        api_fail('token_invalid', 'Session is no longer valid. Sign in again.', 401);
    }
    if ($row['revoked_at'] !== null) {
        api_fail('token_revoked', 'Session was revoked. Sign in again.', 401);
    }
    if ((string)$row['expires_at'] < db_now()) {
        api_fail('token_expired', 'Session expired. Sign in again.', 401);
    }

    auth_touch_token((int)$row['token_id']);

    return [
        'id' => (int)$row['id'],
        'name' => (string)$row['name'],
        'email' => (string)$row['email'],
        'role' => (string)$row['role'],
        'token_id' => (int)$row['token_id'],
    ];
}

/**
 * Marks the token as used and slides its expiry.
 *
 * Both are throttled to once a minute by the WHERE clause, and the sliding
 * expiry is capped by `created_at + TOKEN_ABSOLUTE_DAYS` via LEAST().
 */
function auth_touch_token(int $tokenId): void
{
    db_exec(
        'UPDATE auth_tokens
            SET last_used_at = NOW(3),
                expires_at = LEAST(
                    NOW(3) + INTERVAL :ttl_days DAY,
                    created_at + INTERVAL :absolute_days DAY
                )
          WHERE id = :token_id
            AND (last_used_at IS NULL OR last_used_at < NOW(3) - INTERVAL 1 MINUTE)',
        [
            // INTERVAL needs a numeric literal: bound as a string MySQL
            // rejects the statement outright.
            ':ttl_days' => db_int((int)config_get('token.ttl_days')),
            ':absolute_days' => db_int((int)config_get('token.absolute_days')),
            ':token_id' => db_int($tokenId),
        ]
    );
}

/**
 * Issues a device token and returns the plaintext value.
 *
 * The plaintext exists only in this return value and in the login response;
 * it is never written anywhere on the server.
 */
function auth_issue_token(int $userId, string $deviceLabel): string
{
    $token = bin2hex(random_bytes(32));

    db_exec(
        'INSERT INTO auth_tokens (user_id, token_hash, device_label, created_at, expires_at)
         VALUES (:user_id, :token_hash, :device_label, NOW(3), NOW(3) + INTERVAL :ttl_days DAY)',
        [
            ':user_id' => $userId,
            ':token_hash' => hash('sha256', $token),
            ':device_label' => mb_substr($deviceLabel, 0, 120),
            ':ttl_days' => db_int((int)config_get('token.ttl_days')),
        ]
    );

    return $token;
}

/** Revokes a single token (sign-out on one device). */
function auth_revoke_token(int $tokenId): void
{
    db_exec(
        'UPDATE auth_tokens SET revoked_at = NOW(3) WHERE id = :token_id AND revoked_at IS NULL',
        [':token_id' => db_int($tokenId)]
    );
}

/** Best-effort client IP. Trusting X-Forwarded-For without a vetted proxy is worse than not having it. */
function auth_client_ip(): string
{
    return mb_substr((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
}

/**
 * True when this e-mail/IP pair has burned through its attempt budget.
 *
 * Counting failures for the pair (rather than for the e-mail alone) keeps one
 * attacker from locking a real technician out of their own account, while
 * still bounding an online guessing attack from a single source.
 */
function auth_login_blocked(string $email, string $ip): bool
{
    $row = db_row(
        'SELECT COUNT(*) AS failures
           FROM login_attempts
          WHERE email = :email
            AND ip_address = :ip
            AND succeeded = 0
            AND created_at > NOW(3) - INTERVAL :window_minutes MINUTE',
        [
            ':email' => $email,
            ':ip' => $ip,
            ':window_minutes' => db_int((int)config_get('login.window_minutes')),
        ]
    );

    return (int)($row['failures'] ?? 0) >= (int)config_get('login.max_attempts');
}

/** Records one login attempt, successful or not. */
function auth_log_attempt(string $email, string $ip, bool $succeeded): void
{
    db_exec(
        'INSERT INTO login_attempts (email, ip_address, succeeded, created_at)
         VALUES (:email, :ip, :succeeded, NOW(3))',
        [':email' => $email, ':ip' => $ip, ':succeeded' => $succeeded ? 1 : 0]
    );
}

/**
 * Burns roughly one bcrypt verification without having a hash to check.
 *
 * Without this, "unknown e-mail" answers in a fraction of the time that "known
 * e-mail, wrong password" takes, and the response time alone enumerates valid
 * accounts. The dummy hash below is a bcrypt digest of a string nobody knows;
 * `password_verify` against it always fails and always costs the same as a
 * real check at cost 12.
 */
function auth_dummy_verify(string $password): void
{
    static $dummy = '$2y$12$EeEdxzT0hkyEeHNVqiXXuuhIEZpbR4fMm.g/Wb6rodwlwVeKebiO2';
    password_verify($password, $dummy);
}
