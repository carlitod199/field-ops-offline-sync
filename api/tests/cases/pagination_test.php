<?php
declare(strict_types=1);

/**
 * Delta paging, against a real database.
 *
 * The property under test: a page must never end inside a group of rows that
 * share one `updated_at` value. The cursor has millisecond resolution, so if a
 * page stopped halfway through such a group, the remainder would not be
 * `> cursor` on the next request and would never be delivered — a silent,
 * permanent loss with no error anywhere.
 *
 * `sync_pull_sites()` is called unmodified; only the connection is swapped.
 */

test_group('delta paging (SQLite)');

function paging_fixture(): PDO
{
    $pdo = test_sqlite_pdo();
    test_sqlite_create_sites($pdo);
    db_use($pdo);
    return $pdo;
}

/** Timestamps for a run of rows, one millisecond apart. */
function paging_stamp(int $millisecond): string
{
    return (new DateTimeImmutable('2026-08-25 12:00:00.000', new DateTimeZone('UTC')))
        ->modify('+' . $millisecond . ' milliseconds')
        ->format('Y-m-d H:i:s.v');
}

test_case('a page that fits is returned whole, with no cursor advice', function (): void {
    paging_fixture();
    for ($id = 1; $id <= 3; $id++) {
        test_insert_site(db(), $id, paging_stamp($id));
    }

    [$records, $deleted, $hasMore, $watermark] = sync_pull_sites(null, 10);

    assert_same(3, count($records));
    assert_same([], $deleted);
    assert_false($hasMore);
    assert_null($watermark, 'a complete page lets the caller use the request cursor');
});

test_case('a truncated page reports has_more and a watermark', function (): void {
    paging_fixture();
    for ($id = 1; $id <= 10; $id++) {
        test_insert_site(db(), $id, paging_stamp($id));
    }

    [$records, , $hasMore, $watermark] = sync_pull_sites(null, 4);

    assert_same(4, count($records));
    assert_true($hasMore);
    assert_same(paging_stamp(4), $watermark, 'the watermark is the last delivered row');
});

test_case('a page never ends inside a group sharing one timestamp', function (): void {
    // Rows 4, 5 and 6 all land on the same millisecond. With a limit of 5 the
    // naive answer is "rows 1-5", which strands row 6 forever.
    paging_fixture();
    $shared = paging_stamp(40);
    $stamps = [
        1 => paging_stamp(10),
        2 => paging_stamp(20),
        3 => paging_stamp(30),
        4 => $shared,
        5 => $shared,
        6 => $shared,
        7 => paging_stamp(50),
        8 => paging_stamp(60),
    ];
    foreach ($stamps as $id => $stamp) {
        test_insert_site(db(), $id, $stamp);
    }

    [$records, , $hasMore, $watermark] = sync_pull_sites(null, 5);

    $ids = array_column($records, 'id');
    assert_same([1, 2, 3], $ids, 'the tie group is trimmed off the page');
    assert_true($hasMore);
    assert_same(paging_stamp(30), $watermark, 'the cursor stops before the tie group');

    // The property, stated directly: for the watermark timestamp, the page
    // either contains all rows carrying it or none.
    $atWatermark = array_filter($records, static fn (array $r): bool => $r['updated_at'] === sql_to_iso($watermark));
    $totalAtWatermark = (int)db()
        ->query("SELECT COUNT(*) FROM sites WHERE updated_at = '" . $watermark . "'")
        ->fetchColumn();
    assert_same($totalAtWatermark, count($atWatermark), 'the boundary group is delivered whole');
});

test_case('a page that is entirely one tie group overflows rather than splitting', function (): void {
    // Six rows on a single millisecond, limit 4. Splitting is impossible
    // without loss, so the whole group is delivered and the limit is exceeded
    // deliberately.
    paging_fixture();
    $shared = paging_stamp(70);
    for ($id = 1; $id <= 6; $id++) {
        test_insert_site(db(), $id, $shared);
    }

    [$records, , $hasMore, $watermark] = sync_pull_sites(null, 4);

    assert_same(6, count($records), 'the whole group is delivered');
    assert_same([1, 2, 3, 4, 5, 6], array_column($records, 'id'));
    assert_true($hasMore);
    assert_same($shared, $watermark);
});

test_case('paging to exhaustion delivers every row', function (): void {
    // The end-to-end property. 37 rows, a page size of 5, and a deliberately
    // lumpy timestamp distribution including several tie groups. Walking the
    // cursor exactly as the client does must yield every id.
    paging_fixture();
    $expected = [];
    for ($id = 1; $id <= 37; $id++) {
        // intdiv groups rows into clusters of three sharing one timestamp
        $stamp = paging_stamp(intdiv($id - 1, 3) * 10);
        test_insert_site(db(), $id, $stamp);
        $expected[] = $id;
    }

    $seen = [];
    $cursor = null;
    $pages = 0;

    do {
        [$records, , $hasMore, $watermark] = sync_pull_sites($cursor, 5);
        foreach ($records as $record) {
            $seen[$record['id']] = true;
        }
        // Exactly what the client does with the response.
        $cursor = $hasMore ? $watermark : null;
        $pages++;
        if ($pages > 50) {
            fail_assertion('paging did not terminate');
        }
    } while ($hasMore);

    $delivered = array_keys($seen);
    sort($delivered);
    assert_same($expected, $delivered, 'every row must be delivered');
    assert_true($pages > 1, 'the fixture must actually have paged');
});

test_case('a delta excludes rows at or before the cursor', function (): void {
    paging_fixture();
    for ($id = 1; $id <= 6; $id++) {
        test_insert_site(db(), $id, paging_stamp($id * 10));
    }

    [$records] = sync_pull_sites(paging_stamp(30), 10);

    assert_same([4, 5, 6], array_column($records, 'id'), 'the cursor is exclusive');
});

test_case('a full load hides soft-deleted rows; a delta reports them as tombstones', function (): void {
    paging_fixture();
    test_insert_site(db(), 1, paging_stamp(10));
    test_insert_site(db(), 2, paging_stamp(20), paging_stamp(20));

    [$fullRecords, $fullDeleted] = sync_pull_sites(null, 10);
    assert_same([1], array_column($fullRecords, 'id'), 'a full load carries live rows only');
    assert_same([], $fullDeleted);

    [$deltaRecords, $deltaDeleted] = sync_pull_sites(paging_stamp(5), 10);
    assert_same([1], array_column($deltaRecords, 'id'));
    assert_same([2], $deltaDeleted, 'the delta must tell the device to drop it');
});
