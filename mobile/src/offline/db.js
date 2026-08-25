import { openDatabaseAsync } from './sqlite';

// ---------------------------------------------------------------------------
// The local database.
//
// It holds two things that must not be confused:
//
//   * a MIRROR of server-owned data (sites, assets, inspections). It is a
//     cache. It can be rebuilt from scratch by a full pull, and nothing in it
//     is authoritative.
//
//   * the OUTBOX: writes the technician has made that the server has not
//     acknowledged. This is the only data in the app that exists nowhere else,
//     so it is the only data whose loss is unrecoverable. Every design choice
//     below favours the outbox over the mirror.
//
// Inspections live in the mirror table even before the server knows about
// them, keyed by `client_uuid`, so the list a technician sees is one query
// rather than a union of "synced" and "not yet synced". `server_id` is null
// until push confirms it; `origin` says which side wrote the row last.
// ---------------------------------------------------------------------------

const DATABASE_NAME = 'field_ops.db';

let database = null;
let opening = null;

/**
 * Opens the database once.
 *
 * The in-flight promise is cached, not just the result: several modules call
 * this during launch, and without the second cache two of them would open the
 * database concurrently and race on the schema statements.
 */
export async function openDb() {
  if (database) return database;
  if (opening) return opening;
  opening = createDb();
  return opening;
}

async function createDb() {
  database = await openDatabaseAsync(DATABASE_NAME);

  await database.execAsync(`
    -- WAL keeps a read (the list the technician is looking at) from blocking a
    -- write (the inspection they just saved).
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sites (
      id          INTEGER PRIMARY KEY,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      address     TEXT,
      updated_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS assets (
      id            INTEGER PRIMARY KEY,
      site_id       INTEGER NOT NULL,
      code          TEXT NOT NULL,
      name          TEXT NOT NULL,
      category      TEXT,
      status        TEXT,
      installed_on  TEXT,
      updated_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_assets_site ON assets (site_id);

    -- Keyed on client_uuid, not on the server id: a record created offline has
    -- no server id yet, and the server echoes client_uuid back on pull so both
    -- sides agree on the key.
    CREATE TABLE IF NOT EXISTS inspections (
      client_uuid       TEXT PRIMARY KEY,
      server_id         INTEGER,
      asset_id          INTEGER NOT NULL,
      checklist_result  TEXT NOT NULL,
      reading_value     REAL,
      reading_unit      TEXT,
      notes             TEXT,
      performed_at      TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'submitted',
      photo_count       INTEGER NOT NULL DEFAULT 0,
      updated_at        TEXT,
      -- 'local'  = written here, not yet confirmed by the server
      -- 'server' = last written by a pull
      origin            TEXT NOT NULL DEFAULT 'server'
    );
    CREATE INDEX IF NOT EXISTS ix_inspections_asset ON inspections (asset_id, performed_at DESC);

    -- The outbox. One row per queued write, keyed by the same client_uuid the
    -- server uses for replay detection.
    CREATE TABLE IF NOT EXISTS outbox (
      client_uuid         TEXT PRIMARY KEY,
      -- 'operation' goes into a /sync/push batch; 'photo' is a multipart
      -- upload that can only run once its parent has a server id.
      kind                TEXT NOT NULL,
      operation           TEXT,
      payload             TEXT NOT NULL,
      parent_client_uuid  TEXT,
      -- pending  : waiting to be sent (or waiting out a backoff)
      -- sending  : handed to the network, outcome unknown
      -- done     : acknowledged by the server, kept briefly as history
      -- rejected : the server refused it on a rule; retrying cannot help
      -- failed   : ran out of retry attempts; a person has to decide
      state               TEXT NOT NULL DEFAULT 'pending',
      attempts            INTEGER NOT NULL DEFAULT 0,
      next_attempt_at     TEXT,
      last_error          TEXT,
      created_at          TEXT NOT NULL,
      completed_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_outbox_state ON outbox (state, next_attempt_at);

    CREATE TABLE IF NOT EXISTS sync_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  return database;
}

/* -------------------------------------------------------------------------
 * Sync state (the delta cursor, the last successful run)
 * ---------------------------------------------------------------------- */

export async function readSyncState(key) {
  const db = await openDb();
  const row = await db.getFirstAsync('SELECT value FROM sync_state WHERE key = ?', [key]);
  return row ? row.value : null;
}

export async function writeSyncState(key, value) {
  const db = await openDb();
  await db.runAsync('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)', [key, value]);
}

/* -------------------------------------------------------------------------
 * Applying a pull
 * ---------------------------------------------------------------------- */

/**
 * Writes one page of pulled data into the mirror.
 *
 * Every statement is an upsert on the primary key, which is what makes
 * re-delivery harmless — and re-delivery is guaranteed, because the server
 * deliberately overlaps the delta window rather than risk missing a row.
 *
 * The whole page is applied in one transaction: a page interrupted halfway
 * would otherwise leave the mirror holding part of a change set while the
 * cursor had already moved past it.
 */
export async function applyPulledPage(page) {
  const db = await openDb();

  await db.withTransactionAsync(async () => {
    for (const site of page.sites?.records || []) {
      await db.runAsync(
        `INSERT INTO sites (id, code, name, address, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           code = excluded.code,
           name = excluded.name,
           address = excluded.address,
           updated_at = excluded.updated_at`,
        [site.id, site.code, site.name, site.address ?? null, site.updated_at ?? null],
      );
    }
    for (const id of page.sites?.deleted_ids || []) {
      await db.runAsync('DELETE FROM sites WHERE id = ?', [id]);
    }

    for (const asset of page.assets?.records || []) {
      await db.runAsync(
        `INSERT INTO assets (id, site_id, code, name, category, status, installed_on, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           site_id = excluded.site_id,
           code = excluded.code,
           name = excluded.name,
           category = excluded.category,
           status = excluded.status,
           installed_on = excluded.installed_on,
           updated_at = excluded.updated_at`,
        [
          asset.id,
          asset.site_id,
          asset.code,
          asset.name,
          asset.category ?? null,
          asset.status ?? null,
          asset.installed_on ?? null,
          asset.updated_at ?? null,
        ],
      );
    }
    for (const id of page.assets?.deleted_ids || []) {
      await db.runAsync('DELETE FROM assets WHERE id = ?', [id]);
    }

    for (const inspection of page.inspections?.records || []) {
      // The server's copy replaces the mirror row, including for records this
      // device created: once the server has acknowledged an inspection, its
      // version is the one that counts. Unsent edits are not lost by this,
      // because they live in the outbox and are replayed on the next push.
      await db.runAsync(
        `INSERT INTO inspections
           (client_uuid, server_id, asset_id, checklist_result, reading_value, reading_unit,
            notes, performed_at, status, photo_count, updated_at, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'server')
         ON CONFLICT(client_uuid) DO UPDATE SET
           server_id = excluded.server_id,
           asset_id = excluded.asset_id,
           checklist_result = excluded.checklist_result,
           reading_value = excluded.reading_value,
           reading_unit = excluded.reading_unit,
           notes = excluded.notes,
           performed_at = excluded.performed_at,
           status = excluded.status,
           photo_count = excluded.photo_count,
           updated_at = excluded.updated_at,
           origin = 'server'`,
        [
          inspection.client_uuid,
          inspection.id,
          inspection.asset_id,
          inspection.checklist_result,
          inspection.reading_value ?? null,
          inspection.reading_unit ?? null,
          inspection.notes ?? null,
          inspection.performed_at,
          inspection.status,
          inspection.photo_count ?? 0,
          inspection.updated_at ?? null,
        ],
      );
    }
    for (const id of page.inspections?.deleted_ids || []) {
      // Deleting by server_id only: a row that has no server id was never
      // acknowledged, so it cannot be the one the tombstone refers to.
      await db.runAsync('DELETE FROM inspections WHERE server_id = ?', [id]);
    }
  });
}

/**
 * Drops mirror rows that a *completed* full load did not deliver.
 *
 * This replaces an earlier design that emptied the mirror before the pull
 * started. That was wrong: if any page of the pull then failed — and on a
 * field handset it regularly will — the technician was left staring at an
 * empty site list until the next successful sync. The mirror is now only ever
 * written to; rows the server no longer has are removed at the end, once every
 * page has actually arrived and been applied.
 *
 * `seen` holds the server ids delivered during the load, one Set per entity.
 *
 * Two things are deliberately never touched here: the outbox, and inspections
 * with no `server_id`. A record the server has never acknowledged is not the
 * server's to delete.
 */
export async function pruneMirror(seen) {
  const db = await openDb();

  await db.withTransactionAsync(async () => {
    await pruneById(db, 'sites', seen.sites);
    await pruneById(db, 'assets', seen.assets);

    const rows = await db.getAllAsync(
      'SELECT client_uuid, server_id FROM inspections WHERE server_id IS NOT NULL',
    );
    const stale = rows.filter((row) => !seen.inspections.has(row.server_id)).map((row) => row.client_uuid);
    await deleteChunked(db, 'inspections', 'client_uuid', stale);
  });
}

/** Deletes rows of `table` whose id was not in `seen`. */
async function pruneById(db, table, seen) {
  const rows = await db.getAllAsync(`SELECT id FROM ${table}`);
  const stale = rows.filter((row) => !seen.has(row.id)).map((row) => row.id);
  await deleteChunked(db, table, 'id', stale);
}

/**
 * Deletes a list of keys in batches.
 *
 * SQLite caps the number of bound parameters in one statement (999 by
 * default), and a full load of a large site list can exceed that.
 */
async function deleteChunked(db, table, column, keys, chunkSize = 200) {
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const chunk = keys.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    await db.runAsync(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, chunk);
  }
}

/* -------------------------------------------------------------------------
 * Local writes
 * ---------------------------------------------------------------------- */

/** Inserts an inspection recorded on this device. The outbox row is separate. */
export async function insertLocalInspection(inspection) {
  const db = await openDb();
  await db.runAsync(
    `INSERT INTO inspections
       (client_uuid, server_id, asset_id, checklist_result, reading_value, reading_unit,
        notes, performed_at, status, photo_count, updated_at, origin)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'submitted', 0, ?, 'local')`,
    [
      inspection.clientUuid,
      inspection.assetId,
      inspection.checklistResult,
      inspection.readingValue ?? null,
      inspection.readingUnit ?? null,
      inspection.notes ?? null,
      inspection.performedAt,
      inspection.performedAt,
    ],
  );
}

/** Records the server id an inspection received during push. */
export async function attachServerId(clientUuid, serverId) {
  const db = await openDb();
  await db.runAsync('UPDATE inspections SET server_id = ? WHERE client_uuid = ?', [serverId, clientUuid]);
}

/**
 * Applies an asset status change locally, before the server has seen it.
 *
 * The mirror is a cache of server state, so writing to it here is a deliberate
 * exception: without it the supervisor taps a control and nothing changes
 * until the next successful sync, which on a bad connection can be an hour.
 * The queued operation remains the authoritative version of the change, and
 * the next pull overwrites this row with whatever the server decided.
 */
export async function setAssetStatusLocally(assetId, status) {
  const db = await openDb();
  await db.runAsync('UPDATE assets SET status = ? WHERE id = ?', [status, assetId]);
}

/** Bumps the local photo counter after a successful upload. */
export async function incrementPhotoCount(clientUuid) {
  const db = await openDb();
  await db.runAsync('UPDATE inspections SET photo_count = photo_count + 1 WHERE client_uuid = ?', [clientUuid]);
}

/* -------------------------------------------------------------------------
 * Reads for the UI
 * ---------------------------------------------------------------------- */

export async function listSites() {
  const db = await openDb();
  return db.getAllAsync('SELECT * FROM sites ORDER BY name');
}

export async function listAssets(siteId) {
  const db = await openDb();
  return db.getAllAsync('SELECT * FROM assets WHERE site_id = ? ORDER BY name', [siteId]);
}

export async function listInspections(assetId, limit = 20) {
  const db = await openDb();
  return db.getAllAsync(
    `SELECT i.*, o.state AS queue_state
       FROM inspections i
       LEFT JOIN outbox o ON o.client_uuid = i.client_uuid
      WHERE i.asset_id = ?
      ORDER BY i.performed_at DESC
      LIMIT ?`,
    [assetId, limit],
  );
}

export default { openDb };
