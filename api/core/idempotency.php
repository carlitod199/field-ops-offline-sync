<?php
declare(strict_types=1);

/**
 * Replay protection for queued writes.
 *
 * The mobile app assigns a `client_uuid` to a record the moment the technician
 * saves it, offline, long before the server has ever heard of it. That UUID is
 * the operation's identity for the rest of its life.
 *
 * Why this is the only workable answer: a queued write can be sent, applied by
 * the server, and have its response lost on the way back — a dropped tunnel, a
 * process kill, a handset that goes into a cellar. The client cannot tell that
 * case apart from "the request never arrived", so it must retry, and the
 * server must be able to recognise the retry. Only the client can name the
 * operation before it exists, so only a client-generated identifier works.
 * Server-side de-duplication by content hash would collapse two genuinely
 * identical inspections recorded five minutes apart.
 *
 * The ledger row is written inside the same transaction as the domain row.
 * That is what makes the pair atomic: there is no window in which an
 * inspection exists without its ledger entry, which is exactly the window a
 * retry would land in and duplicate.
 */

require_once __DIR__ . '/database.php';

/**
 * Runs `$apply` at most once for a given client_uuid.
 *
 * `$apply` must perform the domain write and return
 * `[string $entityType, int $entityId, array $result]`. It runs inside an open
 * transaction and may throw; throwing rolls back both the domain write and the
 * ledger row.
 *
 * The return value is a per-operation result, never an HTTP response — a push
 * batch reports on each operation separately and must not terminate on the
 * first one.
 *
 * @return array{status:string, entity_type:?string, entity_id:?int, result:mixed, error:?string, message:?string}
 */
function idempotent_apply(int $userId, string $clientUuid, string $operation, callable $apply): array
{
    $existing = idempotency_lookup($clientUuid);
    if ($existing !== null) {
        return idempotency_replay($existing, $userId);
    }

    $pdo = db();
    $pdo->beginTransaction();
    try {
        [$entityType, $entityId, $result] = $apply();

        db_exec(
            'INSERT INTO sync_operations
                (client_uuid, user_id, operation, entity_type, entity_id, result_json, created_at)
             VALUES (:client_uuid, :user_id, :operation, :entity_type, :entity_id, :result_json, NOW(3))',
            [
                ':client_uuid' => $clientUuid,
                ':user_id' => $userId,
                ':operation' => $operation,
                ':entity_type' => $entityType,
                ':entity_id' => $entityId,
                ':result_json' => json_encode($result, JSON_UNESCAPED_UNICODE),
            ]
        );

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }

        // Two copies of the same batch in flight at once: the UNIQUE index on
        // client_uuid is the arbiter. The loser reads back what the winner
        // stored instead of reporting a failure.
        if ($e instanceof PDOException && (string)$e->getCode() === '23000') {
            $row = idempotency_lookup($clientUuid);
            if ($row !== null) {
                return idempotency_replay($row, $userId);
            }
        }
        throw $e;
    }

    return [
        'status' => 'applied',
        'entity_type' => $entityType,
        'entity_id' => $entityId,
        'result' => $result,
        'error' => null,
        'message' => null,
    ];
}

/** Ledger row for a client_uuid, or null. */
function idempotency_lookup(string $clientUuid): ?array
{
    return db_row(
        'SELECT user_id, entity_type, entity_id, result_json
           FROM sync_operations
          WHERE client_uuid = :client_uuid
          LIMIT 1',
        [':client_uuid' => $clientUuid]
    );
}

/**
 * Formats a stored ledger row as a replay result.
 *
 * A UUID belonging to another user is refused rather than answered: replaying
 * it would hand one technician the identifiers of another's record. In
 * practice this only happens with a colliding or forged UUID, and it is a
 * permanent rejection either way.
 */
function idempotency_replay(array $row, int $userId): array
{
    if ((int)$row['user_id'] !== $userId) {
        return [
            'status' => 'rejected',
            'entity_type' => null,
            'entity_id' => null,
            'result' => null,
            'error' => 'client_uuid_conflict',
            'message' => 'This client_uuid was already used by another account.',
        ];
    }

    $result = $row['result_json'] !== null
        ? json_decode((string)$row['result_json'], true)
        : null;

    return [
        'status' => 'duplicate',
        'entity_type' => $row['entity_type'] !== null ? (string)$row['entity_type'] : null,
        'entity_id' => $row['entity_id'] !== null ? (int)$row['entity_id'] : null,
        'result' => $result,
        'error' => null,
        'message' => 'Already applied; returning the stored result.',
    ];
}
