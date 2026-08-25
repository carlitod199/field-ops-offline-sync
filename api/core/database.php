<?php
declare(strict_types=1);

/**
 * PDO connection plus the small query helpers the routes use.
 *
 * Two connection attributes carry design weight:
 *
 *  - ATTR_EMULATE_PREPARES = false — statements are prepared by MySQL, so the
 *    values never pass through a PHP-side quoting routine. Two consequences
 *    follow, and both shape the SQL in this project:
 *
 *      (a) a *named* placeholder may appear only once per statement. With
 *          emulation off the driver binds parameters positionally against the
 *          server's parameter list, so `:tenant` used twice is two parameters,
 *          not one. Every query here uses each named placeholder exactly once.
 *
 *      (b) parameters are bound as strings unless told otherwise, and MySQL 8
 *          rejects a string where the grammar needs an integer literal —
 *          `LIMIT '500'` is a syntax error there, while MariaDB coerces it.
 *          Anywhere an integer is structurally required (LIMIT, INTERVAL) the
 *          value is bound with PDO::PARAM_INT, which is what db_int() below is
 *          for. Both cases are asserted in the MySQL integration group.
 *
 *  - time_zone = '+00:00' — the whole system stores and compares UTC. Delta
 *    synchronisation compares a cursor against `updated_at`; if the session
 *    time zone changes between two requests, the comparison silently moves by
 *    hours and rows disappear from the delta.
 */

require_once __DIR__ . '/../config.php';

/**
 * Holder for the connection and the per-request clock sample.
 *
 * A class rather than a pair of function statics so that both can be reset
 * together: swapping the connection has to invalidate the clock sample, or a
 * timestamp read from one database would be compared against rows in another.
 */
final class Db
{
    private static ?PDO $pdo = null;
    private static ?string $now = null;

    public static function connection(): PDO
    {
        if (self::$pdo instanceof PDO) {
            return self::$pdo;
        }

        $cfg = config_get('db');
        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $cfg['host'],
            $cfg['port'],
            $cfg['name'],
            $cfg['charset']
        );

        self::$pdo = new PDO($dsn, $cfg['user'], $cfg['pass'], [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
            PDO::ATTR_STRINGIFY_FETCHES => false,
        ]);

        self::$pdo->exec("SET time_zone = '+00:00'");

        return self::$pdo;
    }

    /**
     * Installs a connection built elsewhere.
     *
     * Used by the test suite, which drives the same query code against an
     * in-memory SQLite database, and by any CLI script that already holds a
     * connection. Passing null drops the current one so the next call builds a
     * fresh connection from configuration.
     */
    public static function use(?PDO $pdo): void
    {
        self::$pdo = $pdo;
        self::$now = null;
    }

    public static function now(): string
    {
        if (self::$now === null) {
            self::$now = (string)self::connection()->query('SELECT NOW(3)')->fetchColumn();
        }
        return self::$now;
    }
}

/** Shared connection for the request. */
function db(): PDO
{
    return Db::connection();
}

/** Replaces the shared connection. See Db::use(). */
function db_use(?PDO $pdo): void
{
    Db::use($pdo);
}

/**
 * Marks a value to be bound as an integer.
 *
 * Wrap any parameter that MySQL needs as a numeric literal rather than a
 * string: `LIMIT :n`, `INTERVAL :days DAY`.
 *
 * @return array{0: int, 1: int}
 */
function db_int(int $value): array
{
    return [$value, PDO::PARAM_INT];
}

/**
 * Prepares and executes a statement.
 *
 * A parameter is bound as a string unless it is wrapped by db_int(), in which
 * case the [value, type] pair is honoured. Nulls are bound as PARAM_NULL so a
 * nullable column receives NULL rather than the empty string.
 */
function db_statement(string $sql, array $params = []): PDOStatement
{
    $stmt = db()->prepare($sql);

    foreach ($params as $name => $value) {
        if (is_array($value) && count($value) === 2 && is_int($value[1])) {
            $stmt->bindValue($name, $value[0], $value[1]);
            continue;
        }
        $stmt->bindValue($name, $value, $value === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
    }

    $stmt->execute();
    return $stmt;
}

/** Prepared SELECT returning every row. */
function db_rows(string $sql, array $params = []): array
{
    return db_statement($sql, $params)->fetchAll();
}

/** Prepared SELECT returning the first row, or null. */
function db_row(string $sql, array $params = []): ?array
{
    $row = db_statement($sql, $params)->fetch();
    return $row === false ? null : $row;
}

/** Prepared statement returning the number of affected rows. */
function db_exec(string $sql, array $params = []): int
{
    return db_statement($sql, $params)->rowCount();
}

/**
 * The database clock, sampled once per request.
 *
 * Sampling once matters: `/sync/pull` uses this value as the cursor it hands
 * back and must not let the clock advance between the moment the cursor is
 * taken and the moment the rows are read.
 *
 * Format is MySQL's `Y-m-d H:i:s.v` in UTC, with millisecond precision to
 * match the `DATETIME(3)` columns.
 */
function db_now(): string
{
    return Db::now();
}

/** The request clock as ISO 8601, which is what the wire format uses. */
function db_now_iso(): string
{
    return sql_to_iso(db_now());
}

/** `Y-m-d H:i:s[.v]` (UTC) -> `Y-m-dTH:i:s.vZ`. */
function sql_to_iso(?string $sqlDateTime): ?string
{
    if ($sqlDateTime === null || $sqlDateTime === '') {
        return null;
    }
    $dt = DateTimeImmutable::createFromFormat('Y-m-d H:i:s.u', $sqlDateTime, new DateTimeZone('UTC'))
        ?: DateTimeImmutable::createFromFormat('Y-m-d H:i:s', $sqlDateTime, new DateTimeZone('UTC'));
    if ($dt === false) {
        return null;
    }
    return $dt->format('Y-m-d\TH:i:s.v\Z');
}

/**
 * ISO 8601 -> `Y-m-d H:i:s.v` in UTC, or null when the input is unusable.
 *
 * Anything with an explicit offset is converted to UTC; a bare timestamp is
 * read as UTC. Returning null rather than throwing lets the caller decide
 * whether a bad cursor is a 422 or simply "start from the beginning".
 */
function iso_to_sql(?string $iso): ?string
{
    $iso = trim((string)$iso);
    if ($iso === '') {
        return null;
    }
    // Reject anything that is not at least a calendar date. DateTimeImmutable
    // happily accepts relative expressions like "tomorrow" or "+1 week", which
    // are not timestamps and must not be treated as cursors.
    if (preg_match('/^\d{4}-\d{2}-\d{2}([T ]|$)/', $iso) !== 1) {
        return null;
    }
    try {
        $dt = new DateTimeImmutable($iso, new DateTimeZone('UTC'));
    } catch (Exception) {
        return null;
    }
    return $dt->setTimezone(new DateTimeZone('UTC'))->format('Y-m-d H:i:s.v');
}

/** Subtracts whole seconds from a `Y-m-d H:i:s.v` value. */
function sql_minus_seconds(string $sqlDateTime, int $seconds): string
{
    $dt = DateTimeImmutable::createFromFormat('Y-m-d H:i:s.u', $sqlDateTime, new DateTimeZone('UTC'));
    if ($dt === false) {
        return $sqlDateTime;
    }
    return $dt->sub(new DateInterval('PT' . max(0, $seconds) . 'S'))->format('Y-m-d H:i:s.v');
}
