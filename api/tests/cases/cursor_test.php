<?php
declare(strict_types=1);

/**
 * Cursor arithmetic and the delta cursor decision.
 *
 * These are the functions the whole delta scheme rests on. They need no
 * database: they are string and date arithmetic, which is exactly why they
 * were written as separate functions rather than inline in the route.
 */

test_group('cursor arithmetic (unit)');

test_case('sql_to_iso keeps millisecond precision and marks UTC', function (): void {
    assert_same('2026-08-25T12:00:00.123Z', sql_to_iso('2026-08-25 12:00:00.123'));
});

test_case('sql_to_iso accepts a value with no fractional part', function (): void {
    assert_same('2026-08-25T12:00:00.000Z', sql_to_iso('2026-08-25 12:00:00'));
});

test_case('sql_to_iso passes null through', function (): void {
    assert_null(sql_to_iso(null));
    assert_null(sql_to_iso(''));
});

test_case('iso_to_sql converts an offset to UTC', function (): void {
    // 09:00 in UTC-03:00 is 12:00 UTC. A handset in a different zone must not
    // be able to shift its own cursor relative to the server's clock.
    assert_same('2026-08-25 12:00:00.000', iso_to_sql('2026-08-25T09:00:00-03:00'));
});

test_case('iso_to_sql keeps milliseconds from a Z timestamp', function (): void {
    assert_same('2026-08-25 12:00:00.123', iso_to_sql('2026-08-25T12:00:00.123Z'));
});

test_case('iso_to_sql rejects unparseable input', function (): void {
    assert_null(iso_to_sql('garbage'));
    assert_null(iso_to_sql('25/08/2026'));
});

test_case('iso_to_sql rejects relative expressions', function (): void {
    // DateTimeImmutable accepts these happily. They are not timestamps, and
    // treating "tomorrow" as a cursor would silently hide every row.
    assert_null(iso_to_sql('tomorrow'));
    assert_null(iso_to_sql('+1 week'));
    assert_null(iso_to_sql('now'));
});

test_case('sql_minus_seconds subtracts the overlap window', function (): void {
    assert_same('2026-08-25 11:59:55.123', sql_minus_seconds('2026-08-25 12:00:00.123', 5));
});

test_case('sql_minus_seconds crosses a minute boundary correctly', function (): void {
    assert_same('2026-08-25 11:59:58.000', sql_minus_seconds('2026-08-25 12:00:03.000', 5));
});

test_case('sql_minus_seconds treats a negative window as zero', function (): void {
    assert_same('2026-08-25 12:00:00.500', sql_minus_seconds('2026-08-25 12:00:00.500', -10));
});

test_case('the overlap always moves the cursor backwards', function (): void {
    // The property that matters: the cursor handed to the client is never
    // ahead of the moment it was sampled. If it were, rows committed during
    // the request window would fall behind it and never be delivered.
    $sampled = '2026-08-25 12:00:00.000';
    foreach ([0, 1, 5, 60, 3600] as $overlap) {
        $cursor = sql_minus_seconds($sampled, $overlap);
        assert_true($cursor <= $sampled, sprintf('overlap of %ds', $overlap));
    }
});

test_group('delta cursor decision (unit)');

$serverNow = '2026-08-25 12:00:00.000';

test_case('an empty parameter means a full load', function () use ($serverNow): void {
    assert_same([null, null], sync_normalise_cursor('', $serverNow));
    assert_same([null, null], sync_normalise_cursor('   ', $serverNow));
});

test_case('a valid cursor in the past becomes a delta', function () use ($serverNow): void {
    assert_same(
        ['2026-08-25 11:00:00.000', null],
        sync_normalise_cursor('2026-08-25T11:00:00.000Z', $serverNow)
    );
});

test_case('an unparseable cursor is a 422, not a silent full load', function () use ($serverNow): void {
    assert_same([null, 'invalid_cursor'], sync_normalise_cursor('not-a-date', $serverNow));
});

test_case('a cursor ahead of the server clock self-heals to a full load', function () use ($serverNow): void {
    // The failure this prevents: after a clock correction on either side, the
    // client holds a cursor in the server's future. Every subsequent delta
    // would be empty — `updated_at > cursor` matches nothing — and the device
    // would quietly stop receiving data until real time caught up.
    [$since, $error] = sync_normalise_cursor('2026-08-25T18:00:00.000Z', $serverNow);
    assert_null($since, 'cursor must be discarded');
    assert_null($error, 'and it must not be reported as an error');
});

test_case('a cursor exactly at the server clock is still a delta', function () use ($serverNow): void {
    // Equal is not ahead. Discarding here would force a full load on every
    // request that happens to land on the same millisecond.
    assert_same([$serverNow, null], sync_normalise_cursor('2026-08-25T12:00:00.000Z', $serverNow));
});
