import test from 'node:test';
import assert from 'node:assert/strict';

import { pullPage, scriptedTransport, useTestDatabase } from './support/harness.js';
import { applyPulledPage, insertLocalInspection, pruneMirror } from '../src/offline/db.js';
import { claimPhotos, enqueueOperation, enqueuePhoto, listQueue } from '../src/offline/queue.js';
import { runSync } from '../src/offline/synchronizer.js';
import { ApiError } from '../src/services/failures.js';

// The whole cycle, driven against a real local database and a scripted server.
// The transport seam in src/services/transport.js is what makes this possible;
// before it, none of the behaviour below could be exercised off a device.

const queueRow = async (db, clientUuid) =>
  db.getFirstAsync('SELECT * FROM outbox WHERE client_uuid = ?', [clientUuid]);

const inspectionRow = async (db, clientUuid) =>
  db.getFirstAsync('SELECT * FROM inspections WHERE client_uuid = ?', [clientUuid]);

/**
 * Gives the device a delta cursor.
 *
 * A device that has synced even once is in this state, and it is the state the
 * push-focused tests want: a full load would additionally prune the mirror,
 * which is covered separately below.
 */
async function seedCursor(db, cursor = '2026-08-25T09:00:00.000Z') {
  await db.runAsync("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('delta_cursor', ?)", [cursor]);
}

async function queueInspection(db, { assetId = 1 } = {}) {
  const clientUuid = await enqueueOperation({
    operation: 'inspection.create',
    payload: { asset_id: assetId, checklist_result: 'pass', performed_at: '2026-08-25T07:42:11.000Z' },
  });
  await insertLocalInspection({
    clientUuid,
    assetId,
    checklistResult: 'pass',
    readingValue: null,
    readingUnit: null,
    notes: null,
    performedAt: '2026-08-25T07:42:11.000Z',
  });
  return clientUuid;
}

/* ------------------------------------------------------------------------ */
/* The photo gate                                                            */
/* ------------------------------------------------------------------------ */

test('a photo whose parent has no server_id is not claimed', async () => {
  const db = await useTestDatabase();
  const parent = await queueInspection(db);

  await enqueuePhoto({
    parentClientUuid: parent,
    uri: 'file:///tmp/a.jpg',
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
    capturedAt: '2026-08-25T07:42:11.000Z',
  });

  assert.deepEqual(await claimPhotos(10), [], 'the parent is not confirmed yet');

  await db.runAsync('UPDATE inspections SET server_id = 5012 WHERE client_uuid = ?', [parent]);

  const claimed = await claimPhotos(10);
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].parent_server_id, 5012, 'the id the upload endpoint needs');
});

test('a photo with no parent row at all is never claimed', async () => {
  await useTestDatabase();
  await enqueuePhoto({
    parentClientUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    uri: 'file:///tmp/orphan.jpg',
    mimeType: 'image/jpeg',
    fileName: 'orphan.jpg',
    capturedAt: '2026-08-25T07:42:11.000Z',
  });

  assert.deepEqual(await claimPhotos(10), []);
});

test('a photo is not uploaded until the push that confirms its parent', async () => {
  const db = await useTestDatabase();
  await seedCursor(db);
  const parent = await queueInspection(db);
  const photo = await enqueuePhoto({
    parentClientUuid: parent,
    uri: 'file:///tmp/a.jpg',
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
    capturedAt: '2026-08-25T07:42:11.000Z',
  });

  // Cycle 1: push fails because there is no signal. Nothing may be uploaded.
  const offline = new ApiError('offline', 'No connection.', 0, 'offline');
  const first = scriptedTransport({ syncPush: [offline] });

  const firstReport = await runSync();
  assert.equal(firstReport.stopped, true);
  assert.equal(first.calls.uploadInspectionPhoto.length, 0, 'no parent id, no upload attempt');
  assert.equal((await queueRow(db, photo)).state, 'pending');

  // Cycle 2: push succeeds, so the parent gets an id, and only then does the
  // photo go.
  const second = scriptedTransport({
    syncPush: [
      {
        results: [
          {
            client_uuid: parent,
            operation: 'inspection.create',
            status: 'applied',
            entity_type: 'inspection',
            entity_id: 5012,
            error: null,
            message: null,
          },
        ],
        applied: 1,
        duplicate: 0,
        rejected: 0,
      },
    ],
    uploadInspectionPhoto: [{ id: 1, inspection_id: 5012 }],
    syncPull: [pullPage({ mode: 'delta' })],
  });

  const secondReport = await runSync();

  assert.equal(secondReport.pushed, 1);
  assert.equal(secondReport.photos, 1);
  assert.equal(second.calls.uploadInspectionPhoto.length, 1);
  assert.equal(second.calls.uploadInspectionPhoto[0].inspectionId, 5012, 'uploaded against the server id');
  assert.equal(second.calls.uploadInspectionPhoto[0].photo.clientUuid, photo, 'carries its own client_uuid');
  assert.equal((await queueRow(db, photo)).state, 'done');
  assert.equal((await inspectionRow(db, parent)).photo_count, 1);
});

/* ------------------------------------------------------------------------ */
/* Push results                                                              */
/* ------------------------------------------------------------------------ */

test('applied and duplicate both clear the outbox; rejected parks the item', async () => {
  const db = await useTestDatabase();
  await seedCursor(db);
  const applied = await queueInspection(db);
  const duplicate = await queueInspection(db);
  const rejected = await queueInspection(db);

  scriptedTransport({
    syncPush: [
      {
        results: [
          { client_uuid: applied, status: 'applied', entity_type: 'inspection', entity_id: 1, error: null, message: null },
          { client_uuid: duplicate, status: 'duplicate', entity_type: 'inspection', entity_id: 2, error: null, message: 'Already applied.' },
          { client_uuid: rejected, status: 'rejected', entity_type: null, entity_id: null, error: 'asset_not_found', message: 'gone' },
        ],
        applied: 1,
        duplicate: 1,
        rejected: 1,
      },
    ],
    syncPull: [pullPage({ mode: 'delta' })],
  });

  const report = await runSync();

  assert.equal(report.pushed, 2, 'applied + duplicate both count as acknowledged');
  assert.equal(report.rejected, 1);
  assert.equal((await queueRow(db, applied)).state, 'done');
  assert.equal((await queueRow(db, duplicate)).state, 'done');
  assert.equal((await queueRow(db, rejected)).state, 'rejected');
  assert.match((await queueRow(db, rejected)).last_error, /asset_not_found/);

  // A duplicate must still hand back the server id, or the photo phase would
  // never unblock after a lost response.
  assert.equal((await inspectionRow(db, duplicate)).server_id, 2);
});

test('an operation the server said nothing about stays queued', async () => {
  const db = await useTestDatabase();
  await seedCursor(db);
  const answered = await queueInspection(db);
  const ignored = await queueInspection(db);

  scriptedTransport({
    syncPush: [
      {
        results: [
          { client_uuid: answered, status: 'applied', entity_type: 'inspection', entity_id: 1, error: null, message: null },
        ],
        applied: 1,
        duplicate: 0,
        rejected: 0,
      },
    ],
    syncPull: [pullPage({ mode: 'delta' })],
  });

  await runSync();

  assert.equal((await queueRow(db, answered)).state, 'done');

  const missing = await queueRow(db, ignored);
  assert.equal(missing.state, 'pending', 'silence is not success');
  assert.equal(missing.attempts, 1);
  assert.match(missing.last_error, /No result returned/);
});

test('results are matched by client_uuid, not by position', async () => {
  const db = await useTestDatabase();
  await seedCursor(db);
  const first = await queueInspection(db);
  const second = await queueInspection(db);

  // The server answers in the opposite order. Matching by index would mark the
  // wrong row as sent and the other as refused.
  scriptedTransport({
    syncPush: [
      {
        results: [
          { client_uuid: second, status: 'rejected', entity_type: null, entity_id: null, error: 'conflict', message: 'no' },
          { client_uuid: first, status: 'applied', entity_type: 'inspection', entity_id: 77, error: null, message: null },
        ],
        applied: 1,
        duplicate: 0,
        rejected: 1,
      },
    ],
    syncPull: [pullPage({ mode: 'delta' })],
  });

  await runSync();

  assert.equal((await queueRow(db, first)).state, 'done');
  assert.equal((await inspectionRow(db, first)).server_id, 77);
  assert.equal((await queueRow(db, second)).state, 'rejected');
});

test('losing the connection mid-push leaves the batch exactly as it was', async () => {
  const db = await useTestDatabase();
  const uuid = await queueInspection(db);

  const offline = new ApiError('offline', 'No connection.', 0, 'offline');
  const transport = scriptedTransport({ syncPush: [offline] });

  const report = await runSync();

  assert.equal(report.stopped, true);
  assert.equal(transport.calls.syncPull.length, 0, 'a stopped cycle must not go on to pull');

  const item = await queueRow(db, uuid);
  assert.equal(item.state, 'pending');
  assert.equal(item.attempts, 0, 'being offline must not consume the retry budget');
});

test('a server fault counts against the retry budget but is not terminal', async () => {
  const db = await useTestDatabase();
  const uuid = await queueInspection(db);

  await seedCursor(db);
  scriptedTransport({
    syncPush: [new ApiError('internal_error', 'Internal server error.', 500, 'server_error')],
    syncPull: [pullPage({ mode: 'delta' })],
  });

  await runSync();

  const item = await queueRow(db, uuid);
  assert.equal(item.state, 'pending', 'a 500 is transient');
  assert.equal(item.attempts, 1);
  assert.ok(item.next_attempt_at, 'and it is scheduled to try again');
});

test('a refused photo upload is parked, a broken one is retried', async () => {
  const db = await useTestDatabase();
  await seedCursor(db);

  const parent = await queueInspection(db);
  await db.runAsync('UPDATE inspections SET server_id = 900 WHERE client_uuid = ?', [parent]);
  await db.runAsync("UPDATE outbox SET state = 'done' WHERE client_uuid = ?", [parent]);

  const refusedPhoto = await enqueuePhoto({
    parentClientUuid: parent,
    uri: 'file:///tmp/a.jpg',
    mimeType: 'image/jpeg',
    fileName: 'a.jpg',
    capturedAt: '2026-08-25T07:42:11.000Z',
  });
  const brokenPhoto = await enqueuePhoto({
    parentClientUuid: parent,
    uri: 'file:///tmp/b.jpg',
    mimeType: 'image/jpeg',
    fileName: 'b.jpg',
    capturedAt: '2026-08-25T07:42:11.000Z',
  });

  scriptedTransport({
    uploadInspectionPhoto: [
      new ApiError('invalid_content', 'Not an image.', 422, 'refused'),
      new ApiError('internal_error', 'Internal server error.', 500, 'server_error'),
    ],
    syncPull: [pullPage({ mode: 'delta' })],
  });

  await runSync();

  assert.equal((await queueRow(db, refusedPhoto)).state, 'rejected', 'a bad file will never upload');
  assert.equal((await queueRow(db, brokenPhoto)).state, 'pending', 'a server fault may succeed later');
});

/* ------------------------------------------------------------------------ */
/* Pull, and the mirror                                                      */
/* ------------------------------------------------------------------------ */

test('a pulled page is upserted, so re-delivery is harmless', async () => {
  const db = await useTestDatabase();

  const page = pullPage({
    sites: {
      records: [{ id: 1, code: 'SITE-001', name: 'North Yard', address: null, updated_at: '2026-08-25T10:00:00.000Z' }],
      deleted_ids: [],
      has_more: false,
    },
  });

  await applyPulledPage(page);
  await applyPulledPage(page); // the overlap window guarantees this happens

  const sites = await db.getAllAsync('SELECT * FROM sites');
  assert.equal(sites.length, 1, 'a repeated delivery must not duplicate');
  assert.equal(sites[0].name, 'North Yard');

  // A later version of the same row replaces it in place.
  page.sites.records[0].name = 'North Yard (renamed)';
  await applyPulledPage(page);
  assert.equal((await db.getFirstAsync('SELECT name FROM sites WHERE id = 1')).name, 'North Yard (renamed)');
});

test('tombstones remove rows from the mirror', async () => {
  const db = await useTestDatabase();

  await applyPulledPage(
    pullPage({
      sites: {
        records: [
          { id: 1, code: 'SITE-001', name: 'North Yard', address: null, updated_at: '2026-08-25T10:00:00.000Z' },
          { id: 2, code: 'SITE-002', name: 'Riverside Depot', address: null, updated_at: '2026-08-25T10:00:00.000Z' },
        ],
        deleted_ids: [],
        has_more: false,
      },
    }),
  );

  await applyPulledPage(pullPage({ sites: { records: [], deleted_ids: [2], has_more: false } }));

  const ids = (await db.getAllAsync('SELECT id FROM sites ORDER BY id')).map((r) => r.id);
  assert.deepEqual(ids, [1]);
});

test('pruning after a full load keeps unsent work and drops stale rows', async () => {
  const db = await useTestDatabase();

  await applyPulledPage(
    pullPage({
      sites: {
        records: [
          { id: 1, code: 'SITE-001', name: 'A', address: null, updated_at: '2026-08-25T10:00:00.000Z' },
          { id: 2, code: 'SITE-002', name: 'B', address: null, updated_at: '2026-08-25T10:00:00.000Z' },
        ],
        deleted_ids: [],
        has_more: false,
      },
    }),
  );

  // One inspection the server knows about, one still queued on the device.
  const localOnly = await queueInspection(db);
  await insertLocalInspection({
    clientUuid: 'cccccccc-dddd-4eee-8fff-000000000000',
    assetId: 1,
    checklistResult: 'pass',
    readingValue: null,
    readingUnit: null,
    notes: null,
    performedAt: '2026-08-25T07:00:00.000Z',
  });
  await db.runAsync('UPDATE inspections SET server_id = 800 WHERE client_uuid = ?', [
    'cccccccc-dddd-4eee-8fff-000000000000',
  ]);

  // A completed full load that delivered only site 1 and no inspections.
  await pruneMirror({ sites: new Set([1]), assets: new Set(), inspections: new Set() });

  const siteIds = (await db.getAllAsync('SELECT id FROM sites ORDER BY id')).map((r) => r.id);
  assert.deepEqual(siteIds, [1], 'a row the server no longer has is dropped');

  assert.ok(await inspectionRow(db, localOnly), 'an unsent record is never the server\'s to delete');
  assert.equal(
    await inspectionRow(db, 'cccccccc-dddd-4eee-8fff-000000000000'),
    null,
    'a confirmed record the load did not deliver is stale',
  );
});

test('a full load that fails halfway leaves the mirror intact', async () => {
  const db = await useTestDatabase();

  // Something already cached from a previous session.
  await applyPulledPage(
    pullPage({
      sites: {
        records: [{ id: 1, code: 'SITE-001', name: 'North Yard', address: null, updated_at: '2026-08-25T10:00:00.000Z' }],
        deleted_ids: [],
        has_more: false,
      },
    }),
  );
  await db.runAsync('DELETE FROM sync_state'); // force the next pull to be a full load

  // Page 1 arrives, page 2 never does.
  const offline = new ApiError('offline', 'No connection.', 0, 'offline');
  scriptedTransport({
    syncPull: [
      pullPage({
        has_more: true,
        next_cursor: '2026-08-25T11:00:00.000Z',
        sites: {
          records: [{ id: 2, code: 'SITE-002', name: 'Riverside Depot', address: null, updated_at: '2026-08-25T10:30:00.000Z' }],
          deleted_ids: [],
          has_more: true,
        },
      }),
      offline,
    ],
  });

  const report = await runSync();
  assert.equal(report.stopped, true);

  // This is the regression: an earlier design emptied the mirror before the
  // pull began, so an interrupted full load left the technician with an empty
  // site list until the next successful sync.
  const ids = (await db.getAllAsync('SELECT id FROM sites ORDER BY id')).map((r) => r.id);
  assert.deepEqual(ids, [1, 2], 'nothing is dropped by an incomplete load');

  // And the cursor must not have advanced, or the interrupted load would
  // silently become a delta and never prune.
  const cursor = await db.getFirstAsync("SELECT value FROM sync_state WHERE key = 'delta_cursor'");
  assert.equal(cursor, null, 'an incomplete full load persists no cursor');
});

test('a completed full load stores the cursor and prunes', async () => {
  const db = await useTestDatabase();

  await applyPulledPage(
    pullPage({
      sites: {
        records: [{ id: 99, code: 'SITE-099', name: 'Stale', address: null, updated_at: '2026-08-24T10:00:00.000Z' }],
        deleted_ids: [],
        has_more: false,
      },
    }),
  );
  await db.runAsync('DELETE FROM sync_state');

  scriptedTransport({
    syncPull: [
      pullPage({
        next_cursor: '2026-08-25T12:00:00.000Z',
        has_more: false,
        sites: {
          records: [{ id: 1, code: 'SITE-001', name: 'North Yard', address: null, updated_at: '2026-08-25T10:00:00.000Z' }],
          deleted_ids: [],
          has_more: false,
        },
      }),
    ],
  });

  const report = await runSync();

  assert.equal(report.stopped, false);
  assert.equal(report.pulled, 1);

  const ids = (await db.getAllAsync('SELECT id FROM sites ORDER BY id')).map((r) => r.id);
  assert.deepEqual(ids, [1], 'the stale row is pruned once the load completed');

  const cursor = await db.getFirstAsync("SELECT value FROM sync_state WHERE key = 'delta_cursor'");
  assert.equal(cursor.value, '2026-08-25T12:00:00.000Z');
});

test('has_more drives another page immediately', async () => {
  const db = await useTestDatabase();
  await db.runAsync("INSERT INTO sync_state (key, value) VALUES ('delta_cursor', '2026-08-25T09:00:00.000Z')");

  const transport = scriptedTransport({
    syncPull: [
      pullPage({
        mode: 'delta',
        has_more: true,
        next_cursor: '2026-08-25T10:00:00.000Z',
        sites: {
          records: [{ id: 1, code: 'SITE-001', name: 'A', address: null, updated_at: '2026-08-25T09:30:00.000Z' }],
          deleted_ids: [],
          has_more: true,
        },
      }),
      pullPage({
        mode: 'delta',
        has_more: false,
        next_cursor: '2026-08-25T11:00:00.000Z',
        sites: {
          records: [{ id: 2, code: 'SITE-002', name: 'B', address: null, updated_at: '2026-08-25T10:30:00.000Z' }],
          deleted_ids: [],
          has_more: false,
        },
      }),
    ],
  });

  const report = await runSync();

  assert.equal(transport.calls.syncPull.length, 2);
  assert.equal(transport.calls.syncPull[0].cursor, '2026-08-25T09:00:00.000Z');
  assert.equal(transport.calls.syncPull[1].cursor, '2026-08-25T10:00:00.000Z', 'page 2 uses the returned cursor');
  assert.equal(report.pulled, 2);

  const cursor = await db.getFirstAsync("SELECT value FROM sync_state WHERE key = 'delta_cursor'");
  assert.equal(cursor.value, '2026-08-25T11:00:00.000Z');
});

test('a delta persists its cursor page by page', async () => {
  const db = await useTestDatabase();
  await db.runAsync("INSERT INTO sync_state (key, value) VALUES ('delta_cursor', '2026-08-25T09:00:00.000Z')");

  const offline = new ApiError('offline', 'No connection.', 0, 'offline');
  scriptedTransport({
    syncPull: [
      pullPage({ mode: 'delta', has_more: true, next_cursor: '2026-08-25T10:00:00.000Z' }),
      offline,
    ],
  });

  await runSync();

  // Unlike a full load, a delta has nothing to prune, so progress is kept and
  // the next cycle resumes rather than starting over.
  const cursor = await db.getFirstAsync("SELECT value FROM sync_state WHERE key = 'delta_cursor'");
  assert.equal(cursor.value, '2026-08-25T10:00:00.000Z');
});

test('a completed cycle records when it finished', async () => {
  const db = await useTestDatabase();
  scriptedTransport({ syncPull: [pullPage()] });

  await runSync();

  const stamp = await db.getFirstAsync("SELECT value FROM sync_state WHERE key = 'last_sync_at'");
  assert.ok(stamp, 'the sync screen shows this');
  assert.ok(!Number.isNaN(Date.parse(stamp.value)));
});

test('the cycle reports its phases in order', async () => {
  await useTestDatabase();
  scriptedTransport({ syncPull: [pullPage()] });

  const phases = [];
  await runSync((phase) => phases.push(phase));

  assert.deepEqual(phases, ['push', 'photos', 'pull'], 'push must precede photos, photos must precede pull');
});

test('nothing queued means no push call at all', async () => {
  await useTestDatabase();
  const transport = scriptedTransport({ syncPull: [pullPage()] });

  await runSync();

  assert.equal(transport.calls.syncPush.length, 0, 'an empty outbox must not generate a request');
  assert.equal(await listQueue().then((q) => q.length), 0);
});

test('a full load right after a push keeps the record the server just accepted', async () => {
  // The pruning path and the push path meet here. The server does return the
  // freshly created inspection on a full load, so it is in `seen` and survives;
  // this asserts that the two mechanisms compose rather than fight.
  const db = await useTestDatabase();
  const uuid = await queueInspection(db);

  scriptedTransport({
    syncPush: [
      {
        results: [
          { client_uuid: uuid, status: 'applied', entity_type: 'inspection', entity_id: 4242, error: null, message: null },
        ],
        applied: 1,
        duplicate: 0,
        rejected: 0,
      },
    ],
    syncPull: [
      pullPage({
        inspections: {
          records: [
            {
              id: 4242,
              client_uuid: uuid,
              asset_id: 1,
              user_id: 1,
              checklist_result: 'pass',
              reading_value: null,
              reading_unit: null,
              notes: null,
              performed_at: '2026-08-25T07:42:11.000Z',
              status: 'submitted',
              reviewed_at: null,
              photo_count: 0,
              updated_at: '2026-08-25T11:00:00.000Z',
            },
          ],
          deleted_ids: [],
          has_more: false,
        },
      }),
    ],
  });

  await runSync();

  const inspection = await inspectionRow(db, uuid);
  assert.ok(inspection, 'the record must survive the prune');
  assert.equal(inspection.server_id, 4242);
  assert.equal(inspection.origin, 'server', 'the pull makes the server copy authoritative');
});
