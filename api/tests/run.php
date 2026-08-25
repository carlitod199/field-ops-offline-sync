<?php
declare(strict_types=1);

/**
 * Test runner.
 *
 *   php api/tests/run.php
 *
 * Exit code 0 when everything passed, 1 otherwise, so it drops straight into
 * a CI step.
 *
 * Groups that need MySQL announce themselves as skipped, with the address they
 * tried, rather than failing or being silently absent.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "run.php is a command-line script.\n");
    exit(1);
}

error_reporting(E_ALL);
ini_set('display_errors', '1');

// The API under test. Nothing here opens a database connection at load time.
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../core/database.php';
require_once __DIR__ . '/../core/permissions.php';
require_once __DIR__ . '/../core/request.php';
require_once __DIR__ . '/../core/response.php';
require_once __DIR__ . '/../core/idempotency.php';
require_once __DIR__ . '/../core/uploads.php';
require_once __DIR__ . '/../core/auth.php';
require_once __DIR__ . '/../routes/sync.php';

// Test-side support.
require_once __DIR__ . '/support/harness.php';
require_once __DIR__ . '/support/sqlite.php';
require_once __DIR__ . '/support/fixtures.php';

register_shutdown_function('fixture_cleanup');

echo "field-ops-offline-sync — API test suite\n";
echo 'PHP ' . PHP_VERSION . ' | pdo_sqlite ' . (extension_loaded('pdo_sqlite') ? 'yes' : 'no')
    . ' | gd ' . (extension_loaded('gd') ? 'yes' : 'no')
    . ' | fileinfo ' . (extension_loaded('fileinfo') ? 'yes' : 'no') . "\n";

foreach (['pdo_sqlite', 'gd', 'fileinfo'] as $required) {
    if (!extension_loaded($required)) {
        fwrite(STDERR, sprintf("The suite needs the %s extension.\n", $required));
        exit(1);
    }
}

$cases = glob(__DIR__ . '/cases/*_test.php') ?: [];
sort($cases);
foreach ($cases as $case) {
    require_once $case;
}

exit(TestRun::run());
