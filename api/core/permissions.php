<?php
declare(strict_types=1);

/**
 * Role check.
 *
 * Three roles, a fixed grant table, wildcard matching on the last segment.
 * There is no per-user override and no database-backed ACL: this repository
 * demonstrates offline synchronisation, and a full permission engine would be
 * noise around it. What matters here is that authorisation is a single
 * function every write path calls, not a condition copied into each route.
 */

require_once __DIR__ . '/response.php';

const ROLE_TECHNICIAN = 'technician';
const ROLE_SUPERVISOR = 'supervisor';
const ROLE_ADMIN = 'admin';

/** Permission slugs granted to each role. */
function role_grants(string $role): array
{
    return match ($role) {
        ROLE_ADMIN => ['*'],
        ROLE_SUPERVISOR => [
            'sync.pull',
            'inspections.*',
            'assets.write',
        ],
        ROLE_TECHNICIAN => [
            'sync.pull',
            'inspections.write',
            'inspections.photo',
        ],
        default => [],
    };
}

/**
 * True when the role grants the slug.
 *
 * Matching accepts an exact slug, the global `*`, and a prefix wildcard
 * (`inspections.*` covers `inspections.write` and `inspections.review`).
 */
function user_can(array $user, string $slug): bool
{
    if ($slug === '') {
        return false;
    }
    $grants = role_grants((string)($user['role'] ?? ''));
    if (in_array('*', $grants, true) || in_array($slug, $grants, true)) {
        return true;
    }

    $prefix = '';
    foreach (explode('.', $slug) as $segment) {
        $prefix = $prefix === '' ? $segment : $prefix . '.' . $segment;
        if (in_array($prefix . '.*', $grants, true)) {
            return true;
        }
    }
    return false;
}

/** Aborts the request with 403 when the role does not grant the slug. */
function require_permission(array $user, string $slug): void
{
    if (!user_can($user, $slug)) {
        api_fail('forbidden', 'Your role does not allow this action.', 403, ['permission' => $slug]);
    }
}
