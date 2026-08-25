import { openDb } from './db';
import { newClientUuid } from './idempotency';
import { nextAttemptAt, stateAfterFailure } from './backoff';
import { MAX_SEND_ATTEMPTS, OUTBOX_HISTORY_DAYS } from '../services/config';

// ---------------------------------------------------------------------------
// The outbox.
//
// A queued write moves through these states:
//
//   pending ──send──▶ sending ──ack────▶ done
//      ▲                 │
//      │                 ├──rule refusal──▶ rejected   (retrying cannot help)
//      │                 │
//      └──transient failure, backoff──┐
//                                     └──attempts exhausted──▶ failed
//
// Two terminal failure states, on purpose. `rejected` means the server
// evaluated the write and said no — a missing asset, an inspection somebody
// already reviewed. `failed` means the app never got an answer often enough to
// keep trying. They need different words in the UI because they need different
// actions from the technician: one is "this record is wrong", the other is
// "this record still has not gone anywhere".
//
// Backoff is exponential from one minute. A handset that drifts in and out of
// coverage should not spend its battery retrying every few seconds, and a
// server having a bad afternoon should not be hammered by a fleet of phones.
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/** Queues an operation for the next /sync/push batch. Returns its client_uuid. */
export async function enqueueOperation({ operation, payload, clientUuid = null }) {
  const db = await openDb();
  const uuid = clientUuid || newClientUuid();
  await db.runAsync(
    `INSERT INTO outbox (client_uuid, kind, operation, payload, state, created_at)
     VALUES (?, 'operation', ?, ?, 'pending', ?)`,
    [uuid, operation, JSON.stringify(payload), nowIso()],
  );
  return uuid;
}

/**
 * Queues a photo upload.
 *
 * `parentClientUuid` is the inspection this photo belongs to. The upload phase
 * refuses to run until that inspection has a server id, which is how the
 * ordering constraint is enforced by data rather than by hoping the phases run
 * in the right order.
 */
export async function enqueuePhoto({ parentClientUuid, uri, mimeType, fileName, capturedAt }) {
  const db = await openDb();
  const uuid = newClientUuid();
  await db.runAsync(
    `INSERT INTO outbox (client_uuid, kind, payload, parent_client_uuid, state, created_at)
     VALUES (?, 'photo', ?, ?, 'pending', ?)`,
    [uuid, JSON.stringify({ uri, mimeType, fileName, capturedAt }), parentClientUuid, nowIso()],
  );
  return uuid;
}

/** Pending operations whose backoff has elapsed, oldest first. */
export async function claimOperations(limit) {
  const db = await openDb();
  return db.getAllAsync(
    `SELECT * FROM outbox
      WHERE kind = 'operation'
        AND state = 'pending'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at
      LIMIT ?`,
    [nowIso(), limit],
  );
}

/**
 * Pending photos whose parent inspection already has a server id.
 *
 * The join is the gate: a photo for an unconfirmed inspection simply is not
 * returned, and waits for a later cycle without any state of its own.
 */
export async function claimPhotos(limit) {
  const db = await openDb();
  return db.getAllAsync(
    `SELECT o.*, i.server_id AS parent_server_id
       FROM outbox o
       JOIN inspections i ON i.client_uuid = o.parent_client_uuid
      WHERE o.kind = 'photo'
        AND o.state = 'pending'
        AND i.server_id IS NOT NULL
        AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
      ORDER BY o.created_at
      LIMIT ?`,
    [nowIso(), limit],
  );
}

export async function markSending(clientUuids) {
  if (!clientUuids.length) return;
  const db = await openDb();
  const placeholders = clientUuids.map(() => '?').join(',');
  await db.runAsync(`UPDATE outbox SET state = 'sending' WHERE client_uuid IN (${placeholders})`, clientUuids);
}

export async function markDone(clientUuid) {
  const db = await openDb();
  await db.runAsync(
    `UPDATE outbox SET state = 'done', last_error = NULL, completed_at = ? WHERE client_uuid = ?`,
    [nowIso(), clientUuid],
  );
}

/** Server rule refusal: terminal, and never retried automatically. */
export async function markRejected(clientUuid, code, message) {
  const db = await openDb();
  await db.runAsync(
    `UPDATE outbox
        SET state = 'rejected', last_error = ?, next_attempt_at = NULL, completed_at = ?
      WHERE client_uuid = ?`,
    [`${code}: ${message}`, nowIso(), clientUuid],
  );
}

/** Returns a batch to 'pending' without counting an attempt (used when offline). */
export async function releaseToPending(clientUuids) {
  if (!clientUuids.length) return;
  const db = await openDb();
  const placeholders = clientUuids.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE outbox SET state = 'pending' WHERE state = 'sending' AND client_uuid IN (${placeholders})`,
    clientUuids,
  );
}

/**
 * Records a transient failure and schedules the next attempt.
 *
 * Returns the resulting state so the caller can report it.
 */
export async function recordFailure(clientUuid, message) {
  const db = await openDb();
  const row = await db.getFirstAsync('SELECT attempts FROM outbox WHERE client_uuid = ?', [clientUuid]);
  const attempts = (row?.attempts || 0) + 1;
  const state = stateAfterFailure(attempts, MAX_SEND_ATTEMPTS);

  if (state === 'failed') {
    await db.runAsync(
      `UPDATE outbox
          SET state = 'failed', attempts = ?, last_error = ?, next_attempt_at = NULL
        WHERE client_uuid = ?`,
      [attempts, `${message} (gave up after ${attempts} attempts)`, clientUuid],
    );
    return 'failed';
  }

  await db.runAsync(
    `UPDATE outbox
        SET state = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?
      WHERE client_uuid = ?`,
    [attempts, message, nextAttemptAt(attempts), clientUuid],
  );
  return 'pending';
}

/**
 * Returns items stuck in 'sending' to the queue.
 *
 * The app can be killed between handing a batch to fetch() and recording the
 * outcome; those rows would otherwise sit in 'sending' forever. Re-sending is
 * safe by construction — that is exactly what the client_uuid is for — so the
 * recovery is unconditional and runs at launch.
 */
export async function rehydrateStuck() {
  const db = await openDb();
  const result = await db.runAsync(`UPDATE outbox SET state = 'pending' WHERE state = 'sending'`);
  return result?.changes || 0;
}

/** Counts for the pending indicator. */
export async function queueCounts() {
  const db = await openDb();
  const row = await db.getFirstAsync(
    `SELECT
        SUM(CASE WHEN state IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state = 'rejected' THEN 1 ELSE 0 END)              AS rejected,
        SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END)                AS failed
       FROM outbox`,
  );
  return {
    pending: row?.pending || 0,
    rejected: row?.rejected || 0,
    failed: row?.failed || 0,
  };
}

/** Everything the sync screen lists, newest first. */
export async function listQueue(limit = 100) {
  const db = await openDb();
  return db.getAllAsync('SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?', [limit]);
}

/** Puts a rejected or failed item back in line, clearing its retry history. */
export async function retryItem(clientUuid) {
  const db = await openDb();
  await db.runAsync(
    `UPDATE outbox
        SET state = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, completed_at = NULL
      WHERE client_uuid = ? AND state IN ('rejected', 'failed')`,
    [clientUuid],
  );
}

/**
 * Drops an item the technician has decided to abandon.
 *
 * Photos queued against a discarded inspection go with it: without their parent
 * they could never be uploaded, and leaving them would show a permanently
 * stuck queue.
 */
export async function discardItem(clientUuid) {
  const db = await openDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('DELETE FROM outbox WHERE client_uuid = ? OR parent_client_uuid = ?', [
      clientUuid,
      clientUuid,
    ]);
    await db.runAsync(
      `DELETE FROM inspections WHERE client_uuid = ? AND server_id IS NULL`,
      [clientUuid],
    );
  });
}

/** Trims acknowledged history so the outbox does not grow without bound. */
export async function pruneCompleted() {
  const db = await openDb();
  const cutoff = new Date(Date.now() - OUTBOX_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.runAsync(`DELETE FROM outbox WHERE state = 'done' AND completed_at < ?`, [cutoff]);
}

export default {
  enqueueOperation,
  enqueuePhoto,
  claimOperations,
  claimPhotos,
  markSending,
  markDone,
  markRejected,
  releaseToPending,
  recordFailure,
  rehydrateStuck,
  queueCounts,
  listQueue,
  retryItem,
  discardItem,
  pruneCompleted,
};
