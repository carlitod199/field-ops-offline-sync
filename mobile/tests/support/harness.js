import { setSqliteDriver } from '../../src/offline/sqlite.js';
import { openDb } from '../../src/offline/db.js';
import { setSyncTransport } from '../../src/services/transport.js';
import { nodeSqliteDriver } from './nodeSqliteDriver.js';

// Shared set-up for the offline tests: install the SQLite adapter once, then
// hand each test a database with the real schema and no rows.

let installed = false;

/** Installs the driver (idempotent) and returns the opened database. */
export async function useTestDatabase() {
  if (!installed) {
    setSqliteDriver(nodeSqliteDriver());
    installed = true;
  }
  const db = await openDb();
  await resetTables(db);
  return db;
}

/**
 * Empties every table between tests.
 *
 * DELETE rather than dropping and recreating, so each test runs against the
 * schema `db.js` actually creates rather than one written out again here.
 */
export async function resetTables(db) {
  for (const table of ['outbox', 'inspections', 'assets', 'sites', 'sync_state']) {
    await db.runAsync(`DELETE FROM ${table}`);
  }
}

/**
 * A transport that records calls and replies from a script.
 *
 * Each entry is either a value to resolve with or an Error to throw. Anything
 * the test did not script causes an explicit failure rather than an undefined
 * response, so a test cannot pass by accident.
 */
export function scriptedTransport(script = {}) {
  const calls = { syncPush: [], syncPull: [], uploadInspectionPhoto: [] };

  const take = (name, args) => {
    calls[name].push(args);
    const queue = script[name];
    if (!Array.isArray(queue) || queue.length === 0) {
      throw new Error(`scriptedTransport: unscripted call to ${name}(${JSON.stringify(args)})`);
    }
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };

  const client = {
    syncPush: async (operations) => take('syncPush', operations),
    syncPull: async (cursor, limit) => take('syncPull', { cursor, limit }),
    uploadInspectionPhoto: async (inspectionId, photo) =>
      take('uploadInspectionPhoto', { inspectionId, photo }),
  };

  setSyncTransport(client);
  return { client, calls };
}

/** A /sync/pull page with sensible defaults, so tests only state what matters. */
export function pullPage(overrides = {}) {
  return {
    mode: 'full',
    next_cursor: '2026-08-25T12:00:00.000Z',
    has_more: false,
    sites: { records: [], deleted_ids: [], has_more: false },
    assets: { records: [], deleted_ids: [], has_more: false },
    inspections: { records: [], deleted_ids: [], has_more: false },
    ...overrides,
  };
}
