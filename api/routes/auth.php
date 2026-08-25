<?php
declare(strict_types=1);

/**
 * Authentication endpoints.
 *
 *   POST /api/v1/auth/login   (public)
 *   GET  /api/v1/auth/me      (bearer)
 *   POST /api/v1/auth/logout  (bearer)
 */

require_once __DIR__ . '/../core/auth.php';
require_once __DIR__ . '/../core/permissions.php';
require_once __DIR__ . '/../core/request.php';
require_once __DIR__ . '/../core/response.php';

/**
 * POST /api/v1/auth/login
 *
 * Body: { "email": "...", "password": "...", "device_label": "Pixel 7a" }
 *
 * Every failure path answers `invalid_credentials` with the same wording. An
 * API that says "unknown e-mail" for one case and "wrong password" for another
 * is an account enumeration oracle, and the timing equaliser in
 * auth_dummy_verify() would be pointless without matching messages.
 */
function route_auth_login(): never
{
    $body = request_body();
    $email = mb_strtolower((string)field_required($body, 'email'));
    $password = (string)field_required($body, 'password');
    $deviceLabel = field_string($body, 'device_label', 120) ?? 'unknown device';
    $ip = auth_client_ip();

    if (auth_login_blocked($email, $ip)) {
        // Refuse before touching bcrypt: the throttle must not itself become a
        // way to burn CPU on the server.
        auth_dummy_verify($password);
        api_fail('too_many_attempts', 'Too many sign-in attempts. Try again in a few minutes.', 429);
    }

    $user = db_row(
        'SELECT id, name, email, password_hash, role, is_active
           FROM users
          WHERE email = :email
          LIMIT 1',
        [':email' => $email]
    );

    if ($user === null) {
        auth_dummy_verify($password);
    }

    $ok = $user !== null
        && (int)$user['is_active'] === 1
        && password_verify($password, (string)$user['password_hash']);

    if (!$ok) {
        auth_log_attempt($email, $ip, false);
        api_fail('invalid_credentials', 'E-mail or password is incorrect.', 401);
    }

    auth_log_attempt($email, $ip, true);

    // Transparent upgrade if the configured cost has moved since the hash was
    // written. This is the only moment the plaintext password is available.
    if (password_needs_rehash((string)$user['password_hash'], PASSWORD_BCRYPT, ['cost' => 12])) {
        db_exec(
            'UPDATE users SET password_hash = :password_hash WHERE id = :id',
            [
                ':password_hash' => password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]),
                ':id' => (int)$user['id'],
            ]
        );
    }

    $token = auth_issue_token((int)$user['id'], $deviceLabel);
    db_exec('UPDATE users SET last_login_at = NOW(3) WHERE id = :id', [':id' => (int)$user['id']]);

    $expiresAt = db_row(
        'SELECT expires_at FROM auth_tokens WHERE token_hash = :token_hash LIMIT 1',
        [':token_hash' => hash('sha256', $token)]
    );

    api_ok([
        'token' => $token,
        'expires_at' => sql_to_iso($expiresAt['expires_at'] ?? null),
        'user' => auth_public_user($user),
    ], 'Signed in.');
}

/**
 * GET /api/v1/auth/me
 *
 * The app calls this on launch to confirm a stored token is still good and to
 * refresh the cached role. The call also slides the token's expiry, which is
 * how a device that is used daily stays signed in without a refresh endpoint.
 */
function route_auth_me(array $user): never
{
    $row = db_row(
        'SELECT id, name, email, role, last_login_at FROM users WHERE id = :id LIMIT 1',
        [':id' => (int)$user['id']]
    );

    if ($row === null) {
        api_fail('token_invalid', 'Session is no longer valid. Sign in again.', 401);
    }

    api_ok([
        'user' => auth_public_user($row),
        'last_login_at' => sql_to_iso($row['last_login_at'] ?? null),
    ]);
}

/**
 * POST /api/v1/auth/logout
 *
 * Revokes the token used for this request and nothing else — signing out on a
 * phone must not sign the same technician out of a tablet.
 */
function route_auth_logout(array $user): never
{
    auth_revoke_token((int)$user['token_id']);
    api_ok(null, 'Signed out.');
}

/** The subset of a user row that may leave the server, plus the role's grants. */
function auth_public_user(array $row): array
{
    return [
        'id' => (int)$row['id'],
        'name' => (string)$row['name'],
        'email' => (string)$row['email'],
        'role' => (string)$row['role'],
        'permissions' => role_grants((string)$row['role']),
    ];
}
