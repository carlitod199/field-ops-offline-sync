// ---------------------------------------------------------------------------
// Build-time configuration.
//
// No real host names appear in this repository. `localhost` is the default so
// a fresh clone runs against `php -S 127.0.0.1:8000 api/index.php`, and the
// other two entries use the `.invalid` top-level domain, which RFC 2606
// reserves precisely so that placeholder host names cannot accidentally
// resolve to somebody's server.
//
// Expo inlines `process.env.EXPO_PUBLIC_*` into the bundle at build time, so
// these are compile-time constants and not runtime lookups.
// ---------------------------------------------------------------------------

const ENVIRONMENTS = {
  local: 'http://localhost:8000/api/v1',
  staging: 'https://api-staging.example.invalid/api/v1',
  production: 'https://api.example.invalid/api/v1',
};

export const ENVIRONMENT = process.env.EXPO_PUBLIC_ENVIRONMENT || 'local';

// EXPO_PUBLIC_API_URL overrides the table entirely. On a physical device
// `localhost` points at the handset, so development against a laptop needs the
// LAN address here (for example http://192.168.0.10:8000/api/v1).
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || ENVIRONMENTS[ENVIRONMENT] || ENVIRONMENTS.local;

// A field handset is regularly on a barely-working connection. The timeout has
// to be long enough that a slow-but-alive request completes, and short enough
// that the sync loop does not sit blocked while the technician waits.
export const REQUEST_TIMEOUT_MS = 15000;

// Photo uploads move far more bytes and get their own, longer budget.
export const UPLOAD_TIMEOUT_MS = 60000;

// Operations sent per /sync/push call. Small batches lose less work when a
// connection dies mid-request, and keep the server's per-request transaction
// count bounded.
export const PUSH_BATCH_SIZE = 25;

// Rows requested per entity per /sync/pull page.
export const PULL_PAGE_LIMIT = 200;

// Safety stop for the pull loop, so a server that always answers has_more
// cannot spin forever on a metered connection.
export const PULL_MAX_PAGES = 50;

// Retry budget for a queued write before it is parked for a human to look at.
export const MAX_SEND_ATTEMPTS = 6;

// Completed outbox rows are kept this long so the sync screen can show recent
// history, then pruned.
export const OUTBOX_HISTORY_DAYS = 7;
