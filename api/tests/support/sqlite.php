<?php
declare(strict_types=1);

/**
 * An in-memory SQLite database that the production query code can run against.
 *
 * This is not a mock. The queries under test — the pager in `routes/sync.php`,
 * the ledger in `core/idempotency.php` — are executed verbatim, with real
 * prepared statements, real transactions and a real UNIQUE index. What SQLite
 * gives up compared to MySQL is `ON UPDATE CURRENT_TIMESTAMP(3)` and the
 * `INTERVAL` syntax, neither of which those two code paths use; the MySQL-only
 * behaviour is covered by the integration group, which skips when no server is
 * reachable.
 *
 * `NOW()` is registered as a user function so the same SQL text works on both
 * engines. Timestamps use MySQL's `Y-m-d H:i:s.v` layout, which sorts and
 * compares identically as text.
 */

function test_sqlite_pdo(?string $path = null): PDO
{
    $dsn = 'sqlite:' . ($path ?? ':memory:');

    $pdo = new PDO($dsn, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);

    test_sqlite_register_now($pdo);

    return $pdo;
}

/** Registers NOW([precision]) so MySQL-shaped SQL runs unchanged. */
function test_sqlite_register_now(PDO $pdo): void
{
    $now = static function (int|string|null $precision = 0): string {
        return (new DateTimeImmutable('now', new DateTimeZone('UTC')))->format('Y-m-d H:i:s.v');
    };

    // PHP 8.4 moved this onto the Pdo\Sqlite subclass and deprecated the old
    // method on PDO. Support both so the suite runs on 8.1 through 8.4.
    if (class_exists('Pdo\Sqlite') && $pdo instanceof Pdo\Sqlite) {
        $pdo->createFunction('NOW', $now, -1);
        return;
    }

    /** @psalm-suppress DeprecatedMethod */
    @$pdo->sqliteCreateFunction('NOW', $now, -1);
}

/** The `sites` table, shaped like the MySQL one but with TEXT timestamps. */
function test_sqlite_create_sites(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE sites (
            id          INTEGER PRIMARY KEY,
            code        TEXT NOT NULL,
            name        TEXT NOT NULL,
            address     TEXT,
            updated_at  TEXT NOT NULL,
            deleted_at  TEXT DEFAULT NULL
        )'
    );
}

/** The idempotency ledger plus a throwaway table to act as the domain write. */
function test_sqlite_create_ledger(PDO $pdo): void
{
    $pdo->exec(
        'CREATE TABLE sync_operations (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            client_uuid  TEXT NOT NULL UNIQUE,
            user_id      INTEGER NOT NULL,
            operation    TEXT NOT NULL,
            entity_type  TEXT,
            entity_id    INTEGER,
            result_json  TEXT,
            created_at   TEXT NOT NULL
        )'
    );
    $pdo->exec(
        'CREATE TABLE widgets (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            label TEXT NOT NULL
        )'
    );
}

/** Inserts a site row with an explicit timestamp. */
function test_insert_site(PDO $pdo, int $id, string $updatedAt, ?string $deletedAt = null): void
{
    $stmt = $pdo->prepare(
        'INSERT INTO sites (id, code, name, address, updated_at, deleted_at)
         VALUES (:id, :code, :name, NULL, :updated_at, :deleted_at)'
    );
    $stmt->execute([
        ':id' => $id,
        ':code' => sprintf('SITE-%03d', $id),
        ':name' => 'Site ' . $id,
        ':updated_at' => $updatedAt,
        ':deleted_at' => $deletedAt,
    ]);
}
