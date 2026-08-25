import test from 'node:test';
import assert from 'node:assert/strict';

import { useTestDatabase } from './support/harness.js';
import { insertLocalInspection } from '../src/offline/db.js';
import {
  claimOperations,
  discardItem,
  enqueueOperation,
  enqueuePhoto,
  listQueue,
  markDone,
  markRejected,
  markSending,
  pruneCompleted,
  queueCounts,
  recordFailure,
  rehydrateStuck,
  releaseToPending,
  retryItem,
} from '../src/offline/queue.js';
import { MAX_SEND_ATTEMPTS } from '../src/services/config.js';

// The outbox is the only data in the app that exists nowhere else, so its
// state machine is the thing most worth pinning down. Every test below runs
// against a real SQLite database executing the app's own schema and queries.

const row = async (db, clientUuid) =>
  db.getFirstAsync('SELECT * FROM outbox WHERE client_uuid = ?', [clientUuid]);

const sampleInspection = (clientUuid) => ({
  clientUuid,
  assetId: 1,
  checklistResult: 'pass',
  readingValue: 4.2,
  readingUnit: 'bar',
  notes: 'seals dry',
  performedAt: '2026-08-25T07:42:11.000Z',
});

test('queued -> sending -> done is the happy path', async () => {
  const db = await useTestDatabase();

  const uuid = await enqueueOperation({
    operation: 'inspection.create',
    payload: { asset_id: 1, checklist_result: 'pass' },
  });

  let item = await row(db, uuid);
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 0);
  assert.equal(item.next_attempt_at, null);
  assert.equal(item.kind, 'operation');
  assert.deepEqual(JSON.parse(item.payload), { asset_id: 1, checklist_result: 'pass' });

  const claimed = await claimOperations(10);
  assert.deepEqual(
    claimed.map((c) => c.client_uuid),
    [uuid],
  );

  await markSending([uuid]);
  item = await row(db, uuid);
  assert.equal(item.state, 'sending');
  assert.deepEqual(await claimOperations(10), [], 'an in-flight item must not be claimed twice');

  await markDone(uuid);
  item = await row(db, uuid);
  assert.equal(item.state, 'done');
  assert.ok(item.completed_at, 'completed_at is what the history prune uses');
  assert.equal(item.last_error, null);

  assert.deepEqual(await queueCounts(), { pending: 0, rejected: 0, failed: 0 });
});

test('a server refusal is terminal and never reclaimed', async () => {
  const db = await useTestDatabase();
  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });

  await markSending([uuid]);
  await markRejected(uuid, 'asset_not_found', 'The asset does not exist or was removed.');

  const item = await row(db, uuid);
  assert.equal(item.state, 'rejected');
  assert.equal(item.next_attempt_at, null, 'a refusal must not schedule a retry');
  assert.match(item.last_error, /asset_not_found/);
  assert.match(item.last_error, /does not exist/);

  assert.deepEqual(await claimOperations(10), [], 'never retried automatically');
  assert.deepEqual(await queueCounts(), { pending: 0, rejected: 1, failed: 0 });
});

test('transient failures back off, then park the item as failed', async () => {
  const db = await useTestDatabase();
  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });

  const scheduled = [];
  for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
    const state = await recordFailure(uuid, 'connection reset');
    const item = await row(db, uuid);

    assert.equal(state, 'pending', `attempt ${attempt} must stay retryable`);
    assert.equal(item.attempts, attempt);
    assert.ok(item.next_attempt_at, `attempt ${attempt} must schedule a retry`);
    scheduled.push(Date.parse(item.next_attempt_at));
  }

  // The delays grow; the exact values are asserted in backoff.test.js.
  for (let i = 1; i < scheduled.length; i += 1) {
    assert.ok(scheduled[i] > scheduled[i - 1], `retry ${i} must be later than retry ${i - 1}`);
  }

  const finalState = await recordFailure(uuid, 'connection reset');
  const item = await row(db, uuid);

  assert.equal(finalState, 'failed');
  assert.equal(item.state, 'failed');
  assert.equal(item.attempts, MAX_SEND_ATTEMPTS);
  assert.equal(item.next_attempt_at, null, 'a parked item must stop waking the radio');
  assert.match(item.last_error, /gave up after 6 attempts/);
  assert.deepEqual(await queueCounts(), { pending: 0, rejected: 0, failed: 1 });
});

test('an item inside its backoff window is not claimed', async () => {
  await useTestDatabase();
  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });

  await recordFailure(uuid, 'connection reset');
  assert.deepEqual(await claimOperations(10), [], 'the backoff must actually hold it back');
});

test('items stuck in sending are recovered at launch', async () => {
  const db = await useTestDatabase();

  // The app was killed between handing a batch to fetch() and recording the
  // outcome. Without recovery these sit in 'sending' forever.
  const first = await enqueueOperation({ operation: 'inspection.create', payload: { n: 1 } });
  const second = await enqueueOperation({ operation: 'inspection.create', payload: { n: 2 } });
  const settled = await enqueueOperation({ operation: 'inspection.create', payload: { n: 3 } });

  await markSending([first, second, settled]);
  await markDone(settled);

  const recovered = await rehydrateStuck();
  assert.equal(recovered, 2, 'exactly the in-flight items come back');

  assert.equal((await row(db, first)).state, 'pending');
  assert.equal((await row(db, second)).state, 'pending');
  assert.equal((await row(db, settled)).state, 'done', 'a completed item must not be resurrected');

  // Recovery must not count as a failed attempt: re-sending is safe by
  // construction, so it should not consume the retry budget.
  assert.equal((await row(db, first)).attempts, 0);

  const claimed = await claimOperations(10);
  assert.deepEqual(claimed.map((c) => c.client_uuid).sort(), [first, second].sort());
});

test('releasing a batch offline costs no attempt', async () => {
  const db = await useTestDatabase();
  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });

  await markSending([uuid]);
  await releaseToPending([uuid]);

  const item = await row(db, uuid);
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 0, 'being offline is not a failure of the write');
  assert.equal(item.next_attempt_at, null, 'and must not delay the next try');
});

test('retry clears the history of a parked item', async () => {
  const db = await useTestDatabase();
  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });

  await markRejected(uuid, 'conflict', 'already reviewed');
  await retryItem(uuid);

  const item = await row(db, uuid);
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 0);
  assert.equal(item.last_error, null);
  assert.equal(item.completed_at, null);
});

test('retry does not disturb an item that is in flight', async () => {
  const db = await useTestDatabase();
  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });

  await markSending([uuid]);
  await retryItem(uuid);

  assert.equal((await row(db, uuid)).state, 'sending', 'only parked items may be retried');
});

test('discarding an item takes its photos and its unsent record with it', async () => {
  const db = await useTestDatabase();

  const inspectionUuid = await enqueueOperation({
    operation: 'inspection.create',
    payload: { asset_id: 1 },
  });
  await insertLocalInspection(sampleInspection(inspectionUuid));
  const photoUuid = await enqueuePhoto({
    parentClientUuid: inspectionUuid,
    uri: 'file:///tmp/a.jpg',
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
    capturedAt: '2026-08-25T07:42:11.000Z',
  });

  await markRejected(inspectionUuid, 'asset_not_found', 'gone');
  await discardItem(inspectionUuid);

  assert.equal(await row(db, inspectionUuid), null);
  assert.equal(await row(db, photoUuid), null, 'an orphaned photo could never upload');
  assert.equal(
    await db.getFirstAsync('SELECT * FROM inspections WHERE client_uuid = ?', [inspectionUuid]),
    null,
    'the unconfirmed local record goes too',
  );
});

test('discarding does not delete a record the server has confirmed', async () => {
  const db = await useTestDatabase();

  const uuid = await enqueueOperation({ operation: 'inspection.create', payload: {} });
  await insertLocalInspection(sampleInspection(uuid));
  await db.runAsync('UPDATE inspections SET server_id = 500 WHERE client_uuid = ?', [uuid]);

  await discardItem(uuid);

  const inspection = await db.getFirstAsync('SELECT * FROM inspections WHERE client_uuid = ?', [uuid]);
  assert.ok(inspection, 'a confirmed record is not the queue\'s to delete');
  assert.equal(inspection.server_id, 500);
});

test('history is pruned once it ages out, and only when done', async () => {
  const db = await useTestDatabase();

  const old = await enqueueOperation({ operation: 'inspection.create', payload: { n: 1 } });
  const recent = await enqueueOperation({ operation: 'inspection.create', payload: { n: 2 } });
  const refused = await enqueueOperation({ operation: 'inspection.create', payload: { n: 3 } });

  await markDone(old);
  await markDone(recent);
  await markRejected(refused, 'conflict', 'already reviewed');

  // Backdate one completed item well past the retention window.
  await db.runAsync('UPDATE outbox SET completed_at = ? WHERE client_uuid = ?', [
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    old,
  ]);
  // A refusal carries a completed_at too; it must survive, because it is the
  // only record of something the technician still has to deal with.
  await db.runAsync('UPDATE outbox SET completed_at = ? WHERE client_uuid = ?', [
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    refused,
  ]);

  await pruneCompleted();

  const remaining = (await listQueue()).map((item) => item.client_uuid);
  assert.ok(!remaining.includes(old), 'aged-out history is removed');
  assert.ok(remaining.includes(recent), 'recent history is kept');
  assert.ok(remaining.includes(refused), 'a refusal is never pruned');
});
