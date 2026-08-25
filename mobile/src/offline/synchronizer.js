import { transport } from '../services/transport';
import { ApiError } from '../services/failures';
import { PULL_MAX_PAGES, PULL_PAGE_LIMIT, PUSH_BATCH_SIZE } from '../services/config';
import {
  applyPulledPage,
  attachServerId,
  incrementPhotoCount,
  pruneMirror,
  readSyncState,
  writeSyncState,
} from './db';
import {
  claimOperations,
  claimPhotos,
  markDone,
  markRejected,
  markSending,
  pruneCompleted,
  recordFailure,
  releaseToPending,
} from './queue';

// ---------------------------------------------------------------------------
// One synchronisation cycle.
//
//   1. push queued operations
//   2. upload photos whose parent inspection is now confirmed
//   3. pull the delta
//
// The order is not arbitrary:
//
//   * push before pull, so the server's canonical version of what this device
//     just wrote comes back in the same cycle. Pulling first would show the
//     technician a list that is missing the inspection they just filed.
//
//   * photos after push, because a photo needs its parent's server id, and
//     that id only exists once push has confirmed the inspection.
//
//   * pull last, so it also carries the photo counts the upload phase just
//     produced.
//
// Losing the connection at any point stops the cycle. It does not fail it:
// every queued item is left exactly where it was, and the next cycle picks up
// from there.
// ---------------------------------------------------------------------------

const CURSOR_KEY = 'delta_cursor';
const LAST_SYNC_KEY = 'last_sync_at';

/**
 * Error codes that mean "the server considered this and refused".
 *
 * They are terminal for the queued item. Everything not on this list is
 * treated as transient and retried with backoff — the safe default, because
 * retrying a write that would have succeeded costs a request, while dropping
 * one that would have succeeded costs the technician's work.
 */
const PERMANENT_ERROR_CODES = new Set([
  'forbidden',
  'conflict',
  'inspection_not_found',
  'asset_not_found',
  'unknown_operation',
  'client_uuid_conflict',
  'invalid_client_uuid',
  'field_required',
  'invalid_value',
  'invalid_extension',
  'invalid_content',
  'file_too_large',
  'not_found',
]);

const isOffline = (error) =>
  error instanceof ApiError && (error.outcome === 'offline' || error.outcome === 'unreachable');

/** True when retrying this error unchanged could not possibly help. */
export function isPermanentFailure(error) {
  return error instanceof ApiError && error.outcome === 'refused' && PERMANENT_ERROR_CODES.has(error.code);
}

/**
 * Runs a full cycle.
 *
 * `onProgress(phase, detail)` is optional and exists so the sync screen can
 * narrate what is happening. Returns a summary the caller can show.
 */
export async function runSync(onProgress) {
  const report = { pushed: 0, rejected: 0, photos: 0, pulled: 0, stopped: false };

  onProgress?.('push');
  const pushResult = await pushOperations();
  report.pushed = pushResult.acknowledged;
  report.rejected = pushResult.rejected;
  if (pushResult.stopped) {
    report.stopped = true;
    return report;
  }

  onProgress?.('photos');
  const photoResult = await uploadPhotos();
  report.photos = photoResult.uploaded;
  if (photoResult.stopped) {
    report.stopped = true;
    return report;
  }

  onProgress?.('pull');
  const pullResult = await pullDelta();
  report.pulled = pullResult.records;
  report.stopped = pullResult.stopped;

  if (!report.stopped) {
    await writeSyncState(LAST_SYNC_KEY, new Date().toISOString());
    await pruneCompleted();
  }

  return report;
}

/* -------------------------------------------------------------------------
 * Phase 1 — push
 * ---------------------------------------------------------------------- */

/**
 * Sends queued operations in batches until the queue is drained.
 *
 * The response is matched back to the queue by client_uuid, not by position.
 * Position would work today and break the first time the server reorders,
 * merges or drops an entry — and silently mark the wrong row as sent.
 */
async function pushOperations() {
  let acknowledged = 0;
  let rejected = 0;

  for (;;) {
    const batch = await claimOperations(PUSH_BATCH_SIZE);
    if (!batch.length) break;

    const uuids = batch.map((item) => item.client_uuid);
    await markSending(uuids);

    let response;
    try {
      response = await transport().syncPush(
        batch.map((item) => ({
          client_uuid: item.client_uuid,
          operation: item.operation,
          payload: JSON.parse(item.payload),
        })),
      );
    } catch (error) {
      if (isOffline(error)) {
        // No attempt was made as far as the server is concerned. Put the batch
        // back untouched and stop: the next batch would fail identically.
        await releaseToPending(uuids);
        return { acknowledged, rejected, stopped: true };
      }
      // The request reached the server and came back wrong (a 5xx, a malformed
      // reply). Count it against each item's retry budget.
      for (const item of batch) {
        await recordFailure(item.client_uuid, error?.message || 'Send failed.');
      }
      return { acknowledged, rejected, stopped: false };
    }

    const byUuid = new Map((response.results || []).map((result) => [result.client_uuid, result]));

    for (const item of batch) {
      const result = byUuid.get(item.client_uuid);

      if (!result) {
        // The server answered but said nothing about this operation. Treat it
        // as unknown, not as success: the item goes back to the queue and the
        // idempotency ledger makes a re-send harmless if it did in fact run.
        await recordFailure(item.client_uuid, 'No result returned for this operation.');
        continue;
      }

      if (result.status === 'applied' || result.status === 'duplicate') {
        await applyPushResult(item, result);
        await markDone(item.client_uuid);
        acknowledged += 1;
        continue;
      }

      await markRejected(item.client_uuid, result.error || 'rejected', result.message || 'Rejected by the server.');
      rejected += 1;
    }

    // A short batch means the queue is empty; stop instead of polling again.
    if (batch.length < PUSH_BATCH_SIZE) break;
  }

  return { acknowledged, rejected, stopped: false };
}

/** Writes back whatever the server assigned, so later phases can use it. */
async function applyPushResult(item, result) {
  if (item.operation === 'inspection.create' && result.entity_id) {
    await attachServerId(item.client_uuid, result.entity_id);
  }
}

/* -------------------------------------------------------------------------
 * Phase 2 — photos
 * ---------------------------------------------------------------------- */

/**
 * Uploads queued photos one at a time.
 *
 * Sequential rather than parallel: these are large bodies on a connection that
 * is usually the reason the app is offline in the first place, and three
 * concurrent uploads on a weak link finish later than three sequential ones
 * while making each individual failure more likely.
 */
async function uploadPhotos() {
  let uploaded = 0;

  for (;;) {
    const batch = await claimPhotos(PUSH_BATCH_SIZE);
    if (!batch.length) break;

    for (const item of batch) {
      const payload = JSON.parse(item.payload);
      await markSending([item.client_uuid]);

      try {
        await transport().uploadInspectionPhoto(item.parent_server_id, {
          uri: payload.uri,
          mimeType: payload.mimeType,
          fileName: payload.fileName,
          capturedAt: payload.capturedAt,
          clientUuid: item.client_uuid,
        });
        await markDone(item.client_uuid);
        await incrementPhotoCount(item.parent_client_uuid);
        uploaded += 1;
      } catch (error) {
        if (isOffline(error)) {
          await releaseToPending([item.client_uuid]);
          return { uploaded, stopped: true };
        }
        if (isPermanentFailure(error)) {
          await markRejected(item.client_uuid, error.code, error.message);
          continue;
        }
        await recordFailure(item.client_uuid, error?.message || 'Upload failed.');
      }
    }

    if (batch.length < PUSH_BATCH_SIZE) break;
  }

  return { uploaded, stopped: false };
}

/* -------------------------------------------------------------------------
 * Phase 3 — pull
 * ---------------------------------------------------------------------- */

/**
 * Reads pages until the server says there are no more.
 *
 * The cursor is stored only after a page has been applied. A crash between
 * receiving a page and writing it would otherwise advance the cursor past data
 * that never reached the database — the one failure mode a delta cursor cannot
 * recover from on its own.
 */
export async function pullDelta() {
  let cursor = await readSyncState(CURSOR_KEY);
  let records = 0;

  // No cursor means a first run or a reset. The mirror is NOT emptied first:
  // if a later page failed, the technician would be left with nothing until
  // the next successful sync. Instead the ids delivered are collected and,
  // only once the load has completed end to end, anything the server did not
  // send is pruned.
  const fullLoad = !cursor;
  const seen = fullLoad ? { sites: new Set(), assets: new Set(), inspections: new Set() } : null;
  let complete = false;

  for (let page = 0; page < PULL_MAX_PAGES; page += 1) {
    let data;
    try {
      data = await transport().syncPull(cursor, PULL_PAGE_LIMIT);
    } catch (error) {
      if (isOffline(error)) {
        return { records, stopped: true };
      }
      throw error;
    }

    await applyPulledPage(data);
    if (seen) collectDeliveredIds(seen, data);

    records +=
      (data.sites?.records?.length || 0) +
      (data.assets?.records?.length || 0) +
      (data.inspections?.records?.length || 0);

    cursor = data.next_cursor;

    // During a full load the cursor is held in memory until the load finishes.
    // Persisting it page by page would turn an interrupted full load into a
    // delta on the next run, and the prune below would never happen — leaving
    // rows the server has deleted on the device indefinitely. Restarting an
    // interrupted full load costs bandwidth; every page is an upsert, so it
    // costs nothing else.
    if (!fullLoad) {
      await writeSyncState(CURSOR_KEY, cursor);
    }

    if (!data.has_more) {
      complete = true;
      break;
    }
  }

  if (fullLoad && complete) {
    await writeSyncState(CURSOR_KEY, cursor);
    await pruneMirror(seen);
  }

  return { records, stopped: false };
}

/** Records which server ids a full load has delivered so far. */
function collectDeliveredIds(seen, page) {
  for (const record of page.sites?.records || []) seen.sites.add(record.id);
  for (const record of page.assets?.records || []) seen.assets.add(record.id);
  for (const record of page.inspections?.records || []) seen.inspections.add(record.id);
}

/** Timestamp of the last cycle that completed without being cut short. */
export async function lastSyncAt() {
  return readSyncState(LAST_SYNC_KEY);
}

/**
 * Forgets the cursor so the next cycle performs a full load.
 *
 * The outbox is untouched — this discards the cache, never the work.
 */
export async function resetCursor() {
  await writeSyncState(CURSOR_KEY, '');
}

export default { runSync, pullDelta, lastSyncAt, resetCursor };
