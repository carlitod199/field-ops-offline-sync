<?php
declare(strict_types=1);

/**
 * Role checks.
 *
 * Every permission the API enforces is asserted for every role, including the
 * ones that must be denied. A permission table is only as good as its negative
 * cases: a wildcard that matches too much fails open, and nothing about the
 * happy path would reveal it.
 */

test_group('permissions (unit)');

/** Every slug the API checks anywhere. */
const ALL_SLUGS = [
    'sync.pull',
    'inspections.write',
    'inspections.photo',
    'inspections.review',
    'assets.write',
];

/** Expected answer for every (role, slug) pair. */
const EXPECTED = [
    'technician' => [
        'sync.pull' => true,
        'inspections.write' => true,
        'inspections.photo' => true,
        'inspections.review' => false,
        'assets.write' => false,
    ],
    'supervisor' => [
        'sync.pull' => true,
        'inspections.write' => true,
        'inspections.photo' => true,
        'inspections.review' => true,
        'assets.write' => true,
    ],
    'admin' => [
        'sync.pull' => true,
        'inspections.write' => true,
        'inspections.photo' => true,
        'inspections.review' => true,
        'assets.write' => true,
    ],
    'viewer' => [
        'sync.pull' => false,
        'inspections.write' => false,
        'inspections.photo' => false,
        'inspections.review' => false,
        'assets.write' => false,
    ],
];

foreach (EXPECTED as $role => $expectations) {
    test_case(sprintf('%s: every slug resolves as specified', $role), function () use ($role, $expectations): void {
        $user = ['id' => 1, 'role' => $role];
        foreach (ALL_SLUGS as $slug) {
            assert_same($expectations[$slug], user_can($user, $slug), sprintf('%s / %s', $role, $slug));
        }
    });
}

test_case('the supervisor wildcard covers inspections.* and nothing beyond it', function (): void {
    $supervisor = ['id' => 2, 'role' => 'supervisor'];
    // Granted as `inspections.*`
    assert_true(user_can($supervisor, 'inspections.anything'));
    assert_true(user_can($supervisor, 'inspections.deeply.nested'));
    // Not granted: a different branch entirely
    assert_false(user_can($supervisor, 'inspection.write'), 'singular prefix must not match');
    assert_false(user_can($supervisor, 'assets.delete'));
    assert_false(user_can($supervisor, 'users.write'));
});

test_case('admin holds the global wildcard', function (): void {
    $admin = ['id' => 3, 'role' => 'admin'];
    assert_true(user_can($admin, 'anything.at.all'));
    assert_true(user_can($admin, 'sync.pull'));
});

test_case('an unknown role is granted nothing', function (): void {
    $stranger = ['id' => 4, 'role' => 'contractor'];
    foreach (ALL_SLUGS as $slug) {
        assert_false(user_can($stranger, $slug), $slug);
    }
});

test_case('a missing or empty role is granted nothing', function (): void {
    assert_false(user_can([], 'sync.pull'));
    assert_false(user_can(['role' => ''], 'sync.pull'));
    assert_false(user_can(['role' => null], 'sync.pull'));
});

test_case('an empty slug is always denied, even for admin', function (): void {
    // Guards against a caller passing a variable that turned out to be empty
    // and accidentally being told "yes".
    assert_false(user_can(['role' => 'admin'], ''));
});

test_case('role_grants exposes exactly what the login response advertises', function (): void {
    // The device mirrors these strings to decide which controls to draw, so
    // the shape is part of the contract, not an implementation detail.
    assert_same(['sync.pull', 'inspections.write', 'inspections.photo'], role_grants('technician'));
    assert_same(['sync.pull', 'inspections.*', 'assets.write'], role_grants('supervisor'));
    assert_same(['*'], role_grants('admin'));
    assert_same([], role_grants('nobody'));
});
