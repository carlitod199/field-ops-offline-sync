<?php
declare(strict_types=1);

/**
 * The idempotency ledger, against a real database.
 *
 * SQLite here, not a mock: real prepared statements, a real transaction, and a
 * real UNIQUE index doing the arbitration. The production function
 * `idempotent_apply()` is called unmodified.
 */

test_group('idempotency ledger (SQLite)');

/** Fresh database + a callable that performs a domain write. */
function ledger_fixture(?string $path = null): PDO
{
    $pdo = test_sqlite_pdo($path);
    test_sqlite_create_ledger($pdo);
    db_use($pdo);
    return $pdo;
}

function ledger_widget_writer(string $label): callable
{
    return static function () use ($label): array {
        db_exec('INSERT INTO widgets (label) VALUES (:label)', [':label' => $label]);
        $id = (int)db()->lastInsertId();
        return ['widget', $id, ['id' => $id, 'label' => $label]];
    };
}

function ledger_count(PDO $pdo, string $table): int
{
    return (int)$pdo->query('SELECT COUNT(*) FROM ' . $table)->fetchColumn();
}

test_case('a first application writes the domain row and the ledger row', function (): void {
    $pdo = ledger_fixture();
    $uuid = '3f1c9d70-1a4e-4a2b-9c31-1b0f5a7d2e11';

    $outcome = idempotent_apply(7, $uuid, 'widget.create', ledger_widget_writer('first'));

    assert_same('applied', $outcome['status']);
    assert_same('widget', $outcome['entity_type']);
    assert_same(1, $outcome['entity_id']);
    assert_same(['id' => 1, 'label' => 'first'], $outcome['result']);
    assert_same(1, ledger_count($pdo, 'widgets'));
    assert_same(1, ledger_count($pdo, 'sync_operations'));
});

test_case('replaying the same client_uuid does not create a second row', function (): void {
    $pdo = ledger_fixture();
    $uuid = '3f1c9d70-1a4e-4a2b-9c31-1b0f5a7d2e11';

    $first = idempotent_apply(7, $uuid, 'widget.create', ledger_widget_writer('first'));

    // The retry the client is forced to make when a response is lost. Note the
    // callable would insert a *different* label — if it ran, the assertions
    // below would catch it.
    $second = idempotent_apply(7, $uuid, 'widget.create', ledger_widget_writer('second'));

    assert_same('applied', $first['status']);
    assert_same('duplicate', $second['status']);
    assert_same($first['entity_id'], $second['entity_id'], 'the replay must name the original row');
    assert_same($first['result'], $second['result'], 'the stored response is replayed verbatim');
    assert_same(1, ledger_count($pdo, 'widgets'), 'no second domain row');
    assert_same(1, ledger_count($pdo, 'sync_operations'), 'no second ledger row');
});

test_case('replaying ten times still leaves exactly one row', function (): void {
    $pdo = ledger_fixture();
    $uuid = '8b7a2c14-55d9-4f60-8a03-6d2e9f4c1a22';

    for ($attempt = 0; $attempt < 10; $attempt++) {
        idempotent_apply(7, $uuid, 'widget.create', ledger_widget_writer('attempt-' . $attempt));
    }

    assert_same(1, ledger_count($pdo, 'widgets'));
    assert_same(1, ledger_count($pdo, 'sync_operations'));
    $label = (string)$pdo->query('SELECT label FROM widgets LIMIT 1')->fetchColumn();
    assert_same('attempt-0', $label, 'the first application is the one that stands');
});

test_case('a client_uuid belonging to another user is refused, not replayed', function (): void {
    $pdo = ledger_fixture();
    $uuid = '3f1c9d70-1a4e-4a2b-9c31-1b0f5a7d2e11';

    idempotent_apply(7, $uuid, 'widget.create', ledger_widget_writer('owner'));
    $outcome = idempotent_apply(9, $uuid, 'widget.create', ledger_widget_writer('intruder'));

    assert_same('rejected', $outcome['status']);
    assert_same('client_uuid_conflict', $outcome['error']);
    assert_null($outcome['entity_id'], 'another user must not learn the row id');
    assert_same(1, ledger_count($pdo, 'widgets'));
});

test_case('a rejected domain write leaves no ledger row behind', function (): void {
    // A business-rule refusal must not be recorded as applied: the technician
    // can correct the payload and the corrected write has to be able to run.
    $pdo = ledger_fixture();
    $uuid = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

    assert_throws(RuntimeException::class, static function () use ($uuid): void {
        idempotent_apply(7, $uuid, 'widget.create', static function (): array {
            db_exec('INSERT INTO widgets (label) VALUES (:label)', [':label' => 'doomed']);
            throw new RuntimeException('business rule said no');
        });
    });

    assert_same(0, ledger_count($pdo, 'widgets'), 'the domain write is rolled back');
    assert_same(0, ledger_count($pdo, 'sync_operations'), 'and no ledger row is left');
    assert_false($pdo->inTransaction(), 'the transaction must be closed');
});

test_case('a UNIQUE violation is resolved by reading back the winner', function (): void {
    // Two copies of the same batch in flight at once. The sequence below is
    // the real one, driven by two independent connections to one database
    // file:
    //
    //   A: lookup finds nothing
    //   B: inserts the ledger row and commits   <- happens inside A's callable
    //   A: inserts the ledger row -> SQLSTATE 23000
    //   A: rolls back, re-reads, reports duplicate with B's ids
    //
    // SQLite's deferred transactions make this reproducible: A takes no write
    // lock until its first write statement, so B can commit in between.
    $path = tempnam(sys_get_temp_dir(), 'field_ops_race_') ?: null;
    if ($path === null) {
        fail_assertion('could not create a temporary database file');
    }

    try {
        $a = ledger_fixture($path);
        $b = test_sqlite_pdo($path);

        $uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

        $outcome = idempotent_apply(7, $uuid, 'widget.create', static function () use ($b, $uuid): array {
            // The competing request commits first.
            $insert = $b->prepare(
                'INSERT INTO sync_operations
                    (client_uuid, user_id, operation, entity_type, entity_id, result_json, created_at)
                 VALUES (:client_uuid, 7, :operation, :entity_type, :entity_id, :result_json, NOW(3))'
            );
            $insert->execute([
                ':client_uuid' => $uuid,
                ':operation' => 'widget.create',
                ':entity_type' => 'widget',
                ':entity_id' => 4242,
                ':result_json' => json_encode(['id' => 4242, 'label' => 'winner']),
            ]);

            // Now this request performs its own domain write and will collide
            // on the ledger insert.
            db_exec('INSERT INTO widgets (label) VALUES (:label)', [':label' => 'loser']);
            $id = (int)db()->lastInsertId();
            return ['widget', $id, ['id' => $id, 'label' => 'loser']];
        });

        assert_same('duplicate', $outcome['status'], 'the loser must not report a failure');
        assert_same(4242, $outcome['entity_id'], 'it must report the winner\'s row');
        assert_same(['id' => 4242, 'label' => 'winner'], $outcome['result']);

        // The loser's own domain write was rolled back with its transaction.
        // The winner never wrote a widget in this simulation, so the table is
        // empty; what is asserted here is that the loser left nothing behind.
        assert_same(0, ledger_count($a, 'widgets'), 'the loser\'s domain write is rolled back');
        assert_same(1, ledger_count($a, 'sync_operations'), 'exactly one ledger row survives');
        assert_false($a->inTransaction());
    } finally {
        db_use(null);
        @unlink($path);
    }
});
