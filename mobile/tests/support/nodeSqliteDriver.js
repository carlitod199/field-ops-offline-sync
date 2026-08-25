import { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------------------
// A SQLite driver for the tests, built on Node's built-in `node:sqlite`.
//
// This is an adapter, not a mock. The statements the app runs — the schema in
// db.js, the outbox queries in queue.js, the upserts in applyPulledPage — are
// executed by a real SQLite engine, and their results are real. What it
// adapts is only the calling convention: `node:sqlite` is synchronous, and
// expo-sqlite's API is promise-based.
//
// The surface implemented here is exactly the surface `src/offline/` uses.
// Anything the app starts calling that is missing will throw rather than
// silently returning undefined, so the adapter cannot drift out of date
// unnoticed.
// ---------------------------------------------------------------------------

function normaliseParams(params) {
  // expo-sqlite accepts both runAsync(sql, [a, b]) and runAsync(sql, a, b).
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

/**
 * node:sqlite rejects `undefined` and JavaScript booleans as bound values.
 * expo-sqlite coerces them, so the adapter does too — otherwise the tests
 * would fail on a difference that does not exist on a device.
 */
function coerce(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

class TestDatabase {
  constructor(database) {
    this.database = database;
    this.transactionDepth = 0;
  }

  async execAsync(sql) {
    this.database.exec(sql);
  }

  async runAsync(sql, ...params) {
    const bound = normaliseParams(params).map(coerce);
    const result = this.database.prepare(sql).run(...bound);
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async getAllAsync(sql, ...params) {
    const bound = normaliseParams(params).map(coerce);
    // node:sqlite returns null-prototype objects; the app spreads and indexes
    // them, so hand back plain objects to keep behaviour identical.
    return this.database
      .prepare(sql)
      .all(...bound)
      .map((row) => ({ ...row }));
  }

  async getFirstAsync(sql, ...params) {
    const rows = await this.getAllAsync(sql, ...params);
    return rows.length > 0 ? rows[0] : null;
  }

  async withTransactionAsync(body) {
    // Nested calls are flattened, matching expo-sqlite, which would otherwise
    // fail on a second BEGIN.
    if (this.transactionDepth > 0) {
      this.transactionDepth += 1;
      try {
        await body();
      } finally {
        this.transactionDepth -= 1;
      }
      return;
    }

    this.database.exec('BEGIN');
    this.transactionDepth = 1;
    try {
      await body();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  close() {
    this.database.close();
  }
}

/** A driver backed by a fresh in-memory database per call. */
export function nodeSqliteDriver() {
  const open = new Map();

  return {
    openDatabaseAsync: async (name) => {
      if (!open.has(name)) {
        const database = new DatabaseSync(':memory:');
        // WAL is meaningless for :memory:, and PRAGMA journal_mode = WAL in
        // the app's schema is simply ignored by SQLite there.
        open.set(name, new TestDatabase(database));
      }
      return open.get(name);
    },
    closeAll: () => {
      for (const database of open.values()) database.close();
      open.clear();
    },
  };
}
