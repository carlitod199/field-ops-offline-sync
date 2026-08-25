<?php
declare(strict_types=1);

/**
 * Integration group — requires MySQL.
 *
 * Skipped, loudly, when no server is reachable. What it covers cannot be
 * covered anywhere else:
 *
 *   * `ON UPDATE CURRENT_TIMESTAMP(3)`. The entire delta depends on the column
 *     moving when a back-office tool edits a row, and only MySQL implements it.
 *   * `LIMIT :param` and `INTERVAL :param DAY` with EMULATE_PREPARES off. Both
 *     need PDO::PARAM_INT; bound as strings MySQL rejects the statement
 *     outright, and SQLite would happily accept either.
 *   * That `schema.sql` actually executes.
 *
 * It runs against TEST_DB_NAME (default `field_ops_test`), never against the
 * configured application database, and it drops and recreates the tables in
 * it. Point it at a throwaway schema.
 */

/** Connection for the test schema, or null with the reason it is unavailable. */
function mysql_test_connection(): array
{
    $host = (string)env_get('DB_HOST', '127.0.0.1');
    $port = env_int('DB_PORT', 3306);
    $name = (string)env_get('TEST_DB_NAME', 'field_ops_test');
    $user = (string)env_get('DB_USER', 'root');
    $pass = (string)env_get('DB_PASS', '');

    $target = sprintf('%s@%s:%d/%s', $user, $host, $port, $name);

    try {
        $pdo = new PDO(
            sprintf('mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4', $host, $port, $name),
            $user,
            $pass,
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
                PDO::ATTR_STRINGIFY_FETCHES => false,
                PDO::ATTR_TIMEOUT => 3,
            ]
        );
        $pdo->exec("SET time_zone = '+00:00'");
        return [$pdo, $target, null];
    } catch (Throwable $e) {
        return [null, $target, $e->getMessage()];
    }
}

[$mysql, $mysqlTarget, $mysqlError] = mysql_test_connection();

if ($mysql === null) {
    test_skip_group(
        'MySQL integration',
        sprintf(
            "no MySQL reachable at %s (%s)\n       "
            . 'Create the schema and set DB_HOST/DB_PORT/DB_USER/DB_PASS/TEST_DB_NAME to run this group.',
            $mysqlTarget,
            $mysqlError
        )
    );
    return;
}

test_group('MySQL integration (' . $mysqlTarget . ')');

/** Loads schema.sql into the test database, dropping whatever was there. */
function mysql_reset_schema(PDO $pdo): void
{
    $tables = ['sync_operations', 'inspection_photos', 'inspections', 'assets', 'sites',
        'login_attempts', 'auth_tokens', 'users'];

    $pdo->exec('SET FOREIGN_KEY_CHECKS = 0');
    foreach ($tables as $table) {
        $pdo->exec('DROP TABLE IF EXISTS `' . $table . '`');
    }
    $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');

    $sql = (string)file_get_contents(dirname(__DIR__, 2) . '/database/schema.sql');

    // The schema is plain DDL with no routines and no string literals
    // containing `--` or `;`, so stripping whole-line comments and splitting
    // on a statement-terminating semicolon is sufficient, and avoids shelling
    // out to the mysql client.
    //
    // Comments are removed *before* splitting: leaving them in and skipping
    // any chunk that begins with one silently drops the statement that follows
    // it, which is exactly the mistake this comment exists to prevent
    // repeating.
    $withoutComments = preg_replace('/^\s*--.*$/m', '', $sql) ?? $sql;

    foreach (explode(';', $withoutComments) as $statement) {
        $statement = trim($statement);
        if ($statement === '') {
            continue;
        }
        $pdo->exec($statement);
    }
}

test_case('schema.sql executes and creates every table', function () use ($mysql): void {
    mysql_reset_schema($mysql);
    db_use($mysql);

    $found = $mysql->query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()"
    )->fetchAll(PDO::FETCH_COLUMN);

    foreach (['users', 'auth_tokens', 'login_attempts', 'sites', 'assets',
        'inspections', 'inspection_photos', 'sync_operations'] as $table) {
        assert_true(in_array($table, $found, true), 'missing table ' . $table);
    }
});

test_case('db_now returns the database clock in the expected format', function () use ($mysql): void {
    db_use($mysql);
    assert_same(1, preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/', db_now()));
});

test_case('updated_at moves on its own when a row is edited', function () use ($mysql): void {
    // The delta only works because MySQL maintains this column for writes that
    // never go through this API.
    db_use($mysql);
    db_exec("INSERT INTO sites (id, code, name) VALUES (1, 'SITE-001', 'North Yard')");
    $before = (string)db_row('SELECT updated_at FROM sites WHERE id = 1')['updated_at'];

    usleep(20000);
    db_exec("UPDATE sites SET name = 'North Yard (renamed)' WHERE id = 1");
    $after = (string)db_row('SELECT updated_at FROM sites WHERE id = 1')['updated_at'];

    assert_true($after > $before, sprintf('updated_at did not advance: %s -> %s', $before, $after));
});

test_case('LIMIT bound with PDO::PARAM_INT is accepted by the server', function () use ($mysql): void {
    // The positive half holds on every engine and is what the pager relies on.
    db_use($mysql);
    db_exec('DELETE FROM sites');
    db_exec("INSERT INTO sites (id, code, name) VALUES (1,'S-1','A'),(2,'S-2','B'),(3,'S-3','C')");

    $rows = db_rows('SELECT id FROM sites ORDER BY id LIMIT :page_probe', [':page_probe' => db_int(2)]);
    assert_same(2, count($rows), 'the bound limit must actually take effect');
    assert_same([1, 2], array_map(static fn (array $r): int => (int)$r['id'], $rows));
});

test_case('a string-bound LIMIT is rejected on MySQL and tolerated on MariaDB', function () use ($mysql): void {
    // This is where the two engines genuinely differ, so the assertion is made
    // per engine rather than stated as a universal truth:
    //
    //   MySQL 8   — `LIMIT '2'` is a syntax error. Binding as PDO::PARAM_INT
    //               is the fix, and without it /sync/pull would fail outright.
    //   MariaDB   — coerces the string and runs the query.
    //
    // The production code binds as an integer either way; portability is the
    // point, and pretending both engines behave alike would be the mistake.
    db_use($mysql);
    $version = (string)$mysql->query('SELECT VERSION()')->fetchColumn();
    $isMariaDb = stripos($version, 'mariadb') !== false;

    $stringBound = static function (): array {
        return db_rows('SELECT id FROM sites ORDER BY id LIMIT :page_probe', [':page_probe' => '2']);
    };

    if ($isMariaDb) {
        $rows = $stringBound();
        assert_same(2, count($rows), 'MariaDB (' . $version . ') coerces the string');
        return;
    }

    assert_throws(PDOException::class, $stringBound, 'MySQL (' . $version . ') must reject it');
});

test_case('the pager runs against MySQL and respects tie groups', function () use ($mysql): void {
    db_use($mysql);
    db_exec('DELETE FROM sites');

    // Three rows forced onto one millisecond, then two later ones.
    db_exec("INSERT INTO sites (id, code, name, updated_at) VALUES
             (10, 'SITE-010', 'A', '2026-08-25 12:00:00.100'),
             (11, 'SITE-011', 'B', '2026-08-25 12:00:00.200'),
             (12, 'SITE-012', 'C', '2026-08-25 12:00:00.300'),
             (13, 'SITE-013', 'D', '2026-08-25 12:00:00.300'),
             (14, 'SITE-014', 'E', '2026-08-25 12:00:00.300')");

    [$records, , $hasMore, $watermark] = sync_pull_sites(null, 4);

    assert_same([10, 11], array_column($records, 'id'), 'the tie group at .300 is trimmed off');
    assert_true($hasMore);
    assert_same('2026-08-25 12:00:00.200', $watermark);
});

test_case('INTERVAL bound with PDO::PARAM_INT is accepted by MySQL', function () use ($mysql): void {
    // auth_issue_token uses `NOW(3) + INTERVAL :ttl_days DAY`. Bound as a
    // string MySQL rejects the statement.
    db_use($mysql);
    db_exec('DELETE FROM auth_tokens');
    db_exec('DELETE FROM users');
    db_exec(
        "INSERT INTO users (id, name, email, password_hash, role)
         VALUES (1, 'John Smith', 'john@example.com', :hash, 'technician')",
        [':hash' => password_hash('technician123', PASSWORD_BCRYPT, ['cost' => 4])]
    );

    $token = auth_issue_token(1, 'test device');
    assert_same(1, preg_match('/^[a-f0-9]{64}$/', $token), 'token must be 64 hex characters');

    $row = db_row(
        'SELECT created_at, expires_at FROM auth_tokens WHERE token_hash = :hash',
        [':hash' => hash('sha256', $token)]
    );
    assert_true($row !== null, 'the token row must exist');
    assert_true($row['expires_at'] > $row['created_at'], 'expiry must be in the future');
});

test_case('the sliding expiry never passes the absolute ceiling', function () use ($mysql): void {
    db_use($mysql);
    $token = auth_issue_token(1, 'old device');
    $hash = hash('sha256', $token);

    // Backdate the token to just under the absolute limit.
    $absolute = (int)config_get('token.absolute_days');
    db_exec(
        'UPDATE auth_tokens
            SET created_at = NOW(3) - INTERVAL :age DAY, last_used_at = NULL
          WHERE token_hash = :hash',
        [':age' => db_int($absolute - 1), ':hash' => $hash]
    );

    $tokenId = (int)db_row('SELECT id FROM auth_tokens WHERE token_hash = :hash', [':hash' => $hash])['id'];
    auth_touch_token($tokenId);

    $row = db_row('SELECT created_at, expires_at FROM auth_tokens WHERE id = :id', [':id' => $tokenId]);
    $ceiling = db_row(
        'SELECT created_at + INTERVAL :days DAY AS ceiling FROM auth_tokens WHERE id = :id',
        [':days' => db_int($absolute), ':id' => $tokenId]
    )['ceiling'];

    assert_true(
        $row['expires_at'] <= $ceiling,
        sprintf('expiry %s exceeded the ceiling %s', $row['expires_at'], $ceiling)
    );
});
