// ---------------------------------------------------------------------------
// The one place that knows a native SQLite binding exists.
//
// `db.js` used to import `expo-sqlite` directly, which meant every module
// built on top of it — the outbox, the synchroniser — could only run on a
// device. The binding is now injected once, from the composition root in
// `App.js`, and the offline logic underneath is ordinary JavaScript that runs
// anywhere.
//
// The driver only has to provide `openDatabaseAsync(name)` returning an object
// with `execAsync`, `runAsync`, `getAllAsync`, `getFirstAsync` and
// `withTransactionAsync` — the subset of the expo-sqlite API this app uses.
// ---------------------------------------------------------------------------

let driver = null;

/** Installs the SQLite driver. Called from App.js with the Expo module. */
export function setSqliteDriver(next) {
  driver = next;
}

export async function openDatabaseAsync(name) {
  if (driver === null) {
    throw new Error(
      'No SQLite driver installed. Call setSqliteDriver() before opening the database.',
    );
  }
  return driver.openDatabaseAsync(name);
}
