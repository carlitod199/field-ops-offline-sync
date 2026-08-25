# NOTES.md — inventory

Factual account of what is in this repository. Everything below was checked
against the code, not written from intent. This is a **reference
implementation**, not a product: it exists to show how an offline-first write
path is built, and §7 lists what it deliberately does not do.

Stack: PHP 8.1+ with `declare(strict_types=1)` everywhere, MySQL 8.0+, PDO, no
framework, no Composer. Expo SDK 54 / React Native 0.81, JavaScript (no
TypeScript), no state library.

Design rationale lives in [`docs/architecture.md`](docs/architecture.md); this
file is the map.

---

## 1. File inventory

### Root

| Path | Contents |
|---|---|
| `.env.example` | API environment template. Placeholders only, no working credentials. Copy to `.env` at the repo root. |
| `.gitignore` | Secrets, `node_modules/`, `vendor/`, logs, `.expo/`, uploads, OS and IDE cruft. |
| `LICENSE` | MIT, 2026, Carlito Daniel. |
| `NOTES.md` | This file. |
| `docs/architecture.md` | The design document: queue model, idempotency, delta cursor and its race, conflict policy, photo ordering, rejected alternatives, the testing seams, failure table, one mermaid sequence diagram. |

### `api/`

| Path | Contents |
|---|---|
| `api/index.php` | Front controller. CORS allow-list, path extraction, the route table, and dispatch. Answers 405 when the path exists but the verb does not, 404 otherwise. |
| `api/.htaccess` | Rewrites everything to `index.php`, restores the `Authorization` header for CGI/FastCGI, denies direct access to every `.php` except `index.php` and to `.sql`/`.log`/`.md`. |
| `api/config.php` | The only place environment values are read. Returns one nested config array; `config_get('sync.page_limit')` for dotted lookup. Resolves relative `UPLOAD_DIR`/`APP_LOG_FILE` against the repo root. |
| `api/core/env.php` | Dependency-free `.env` parser (`KEY=value`, `#` comments, optional quotes). Process environment wins over the file. `api_root()` / `repo_root()` path helpers. |
| `api/core/database.php` | `Db` holder + PDO connection (`ERRMODE_EXCEPTION`, `FETCH_ASSOC`, `EMULATE_PREPARES=false`, `time_zone='+00:00'`), `db_rows`/`db_row`/`db_exec`/`db_statement`, `db_int()` for parameters MySQL needs as numeric literals, `db_use()` to install a connection, the per-request database clock `db_now()`, and the SQL↔ISO 8601 converters. |
| `api/core/response.php` | The success and failure envelopes; `respond()` sets `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. |
| `api/core/request.php` | JSON body decode plus typed, bounded field extraction (`field_string`, `field_int`, `field_float`, `field_enum`, `field_timestamp`, `field_client_uuid`). `field_timestamp` clamps future timestamps to now. |
| `api/core/errors.php` | Installs an error handler (warnings → `ErrorException`), an exception handler, and a shutdown handler for fatals. Guarantees the body is always JSON. Detail is echoed only when `APP_ENV=local`; otherwise it goes to the log file. |
| `api/core/auth.php` | Bearer token issue/verify/revoke, sliding expiry with an absolute ceiling, throttled `last_used_at`, login attempt throttling, and a constant-time dummy bcrypt verify. |
| `api/core/permissions.php` | Three roles, a fixed grant table, exact/`*`/prefix-wildcard matching. `user_can()` and `require_permission()`. |
| `api/core/idempotency.php` | `idempotent_apply()`: ledger lookup, domain write and ledger insert in one transaction, 23000 race handling, replay formatting. Refuses a `client_uuid` belonging to another user. |
| `api/core/uploads.php` | `upload_inspect()` returns a verdict; `upload_validate()` turns a verdict into a 422. Six checks: PHP error code → size read from the file → extension allow-list → `finfo` magic bytes → `getimagesize` type cross-check → non-zero dimensions. `upload_store()` writes under a generated random name, sharded by year/month. |
| `api/routes/auth.php` | `route_auth_login`, `route_auth_me`, `route_auth_logout`, `auth_public_user`. |
| `api/routes/sync.php` | `sync_normalise_cursor()` (the full-load / delta / self-heal / 422 decision), `route_sync_pull` and `route_sync_push`, the `sync_page` pager with tie-group handling, the three pull queries, the push operation registry, the three operation handlers, and the `OperationRejected` exception. |
| `api/routes/inspections.php` | `route_inspection_photo_upload`. Validates, stores, inserts, bumps `photo_count` and the parent's `updated_at`; unlinks the stored file if the transaction rolls back. |
| `api/database/schema.sql` | Eight tables. Commented with the reasoning for `DATETIME(3)`, `ON UPDATE CURRENT_TIMESTAMP(3)`, soft deletes and the delta indexes. |
| `api/database/seed_demo.sql` | Three users, three sites, seven assets, two inspections. All fictional; e-mail on `example.com`. |
| `api/tests/run.php` | Test runner. `php api/tests/run.php`; exit code 0 on success. |
| `api/tests/support/harness.php` | ~150-line harness: named cases, assertions, expected exceptions, group skipping with a stated reason. |
| `api/tests/support/sqlite.php` | In-memory PDO SQLite with `NOW()` registered, plus the table shapes the SQLite groups need. |
| `api/tests/support/fixtures.php` | Upload fixtures generated at run time with GD — a real PNG, a real GIF, a PHP script, a signature-plus-payload file, a 0x0 header, a PNG with trailing data. No binaries committed. |
| `api/tests/cases/*_test.php` | Six groups; see §6. |
| `api/storage/.htaccess` | `Require all denied`. Uploads are never served directly. |

### `mobile/`

| Path | Contents |
|---|---|
| `mobile/App.js` | Composition root: installs the SQLite driver, the UUID generator and the sync transport, then the provider tree (`SafeAreaProvider` → `AuthProvider` → `SyncProvider` → `RootNavigator`). |
| `mobile/app.json` | Expo config. Dark UI, `com.example.fieldops` identifiers, camera permission strings. |
| `mobile/babel.config.js` | `babel-preset-expo`. |
| `mobile/package.json` | Dependencies pinned to Expo SDK 54 / RN 0.81.5 / React 19.1.0. |
| `mobile/src/theme.js` | Colour, spacing and radius tokens. |
| `mobile/src/components/ui.js` | `Card`, `Button`, `Badge`, `EmptyState`, `ErrorText`. |
| `mobile/src/services/config.js` | Environment table (`localhost` and two `.invalid` placeholders), `EXPO_PUBLIC_*` overrides, timeouts, batch and page sizes, retry budget, history retention. |
| `mobile/src/services/failures.js` | Pure, dependency-free: `ApiError`, and the two classifiers (`classifyTransportFailure`, `classifyResponse`) that decide between `offline`, `unreachable`, `refused`, `server_error`, `invalid_response` and `session_expired`. |
| `mobile/src/services/http.js` | The I/O: timeout via `AbortController`, bearer injection, envelope reading, the session-expired hook. Delegates every judgement to `failures.js`; re-exports `ApiError`. |
| `mobile/src/services/transport.js` | The seam between the sync cycle and the network. `setSyncTransport()` is called once from `App.js`. |
| `mobile/src/services/api.js` | One function per endpoint: `login`, `me`, `logout`, `syncPull`, `syncPush`, `uploadInspectionPhoto`. |
| `mobile/src/services/authStorage.js` | Token and cached profile in `expo-secure-store`. |
| `mobile/src/offline/sqlite.js` | The only module that knows a native SQLite binding exists. `setSqliteDriver()` is called once from `App.js`. |
| `mobile/src/offline/db.js` | SQLite schema (mirror + outbox + `sync_state`), cached open promise, `applyPulledPage`, `pruneMirror` (+ chunked deletes), local write helpers, and the UI read queries. |
| `mobile/src/offline/backoff.js` | The retry schedule as pure arithmetic: `attemptDelayMs`, `stateAfterFailure`, `nextAttemptAt`. |
| `mobile/src/offline/idempotency.js` | `newClientUuid()` over an injected generator (`expo-crypto`'s `randomUUID` in the app), `uuidV4FromBytes()`, and the `CLIENT_UUID_PATTERN` / `isClientUuid()` contract. No native import. |
| `mobile/src/offline/queue.js` | The outbox: enqueue, claim, state transitions, exponential backoff, stuck-item recovery, counts, retry, discard, prune. |
| `mobile/src/offline/synchronizer.js` | The three-phase cycle (push → photos → pull), `isPermanentFailure()`, cursor handling, and the prune-after-a-completed-full-load rule. |
| `mobile/src/context/AuthContext.js` | Session restore, sign-in/out, the session-expired wiring, and the client-side `can()` mirror of the server's wildcard matching. |
| `mobile/src/context/SyncContext.js` | Connectivity via NetInfo, the pending/rejected/failed counts, the single-flight sync guard, and the three sync triggers. |
| `mobile/src/navigation/RootNavigator.js` | Native stack, signed-out/signed-in split, and the header `SyncIndicator`. |
| `mobile/src/screens/LoginScreen.js` | E-mail/password form. Shows which environment the build points at. |
| `mobile/src/screens/SitesScreen.js` | Site list from the local mirror; pull-to-refresh triggers a sync. |
| `mobile/src/screens/AssetsScreen.js` | Assets for a site, with status chips. Supervisors and admins get an inline status control that queues `asset.set_status`. |
| `mobile/src/screens/InspectionFormScreen.js` | The offline write path: checklist, reading, notes, camera photos, save, plus recent inspections for the asset with their queue state. |
| `mobile/src/screens/SyncStatusScreen.js` | Connection state, counts, last completed sync, the full queue with per-item state and error, retry/discard, "Sync now", "Reload all data", sign-out. |
| `mobile/tests/*.test.js` | Four files, 54 cases; see §6. |
| `mobile/tests/support/nodeSqliteDriver.js` | Adapter presenting `node:sqlite` through the expo-sqlite async API. Real SQL, real transactions. |
| `mobile/tests/support/harness.js` | Test database set-up, table reset, the scripted transport, and a `/sync/pull` page builder. |
| `mobile/tests/support/resolveExtensions.mjs` | Node resolution hook teaching the runner Metro's extensionless relative imports. |
| `mobile/tests/support/register.mjs` | Registers the hook for the runner and every spawned test file. |

---

## 2. Endpoints

Base path `/api/v1`. Every response uses the envelope; `error` is a stable
machine code and the client branches on it, never on `message`.

| Method | Path | Auth | Permission | Notes |
|---|---|---|---|---|
| `POST` | `/auth/login` | none | — | Body `{email, password, device_label}`. Returns `{token, expires_at, user}`. Throttled per (email, IP). Uniform `invalid_credentials` on every failure path. |
| `GET` | `/auth/me` | bearer | — | Returns `{user, last_login_at}`. Also slides the token's expiry. |
| `POST` | `/auth/logout` | bearer | — | Revokes only the token used for the request. |
| `GET` | `/sync/pull` | bearer | `sync.pull` | Query `updated_since` (ISO 8601, optional) and `limit`. Returns `mode`, `next_cursor`, `has_more`, and `{records, deleted_ids, has_more}` for `sites`, `assets`, `inspections`. |
| `POST` | `/sync/push` | bearer | per operation | Body `{operations:[{client_uuid, operation, payload}]}`. Returns `results[]` with `status` ∈ `applied` / `duplicate` / `rejected`, plus counts. |
| `POST` | `/inspections/{id}/photos` | bearer | `inspections.photo` | `multipart/form-data`: `photo`, `client_uuid`, optional `captured_at`. 201 on store, 200 on replay. |

Envelope:

```json
{ "ok": true,  "data": {}, "message": null, "meta": { "server_time": "2026-08-25T12:00:00.000Z" } }
{ "ok": false, "error": "invalid_cursor", "message": "…", "details": null }
```

### Push operations

| Operation | Permission | Payload | Rejections |
|---|---|---|---|
| `inspection.create` | `inspections.write` | `asset_id`, `checklist_result` (`pass`/`attention`/`fail`), `reading_value?`, `reading_unit?`, `notes?`, `performed_at?` | `asset_not_found`, `field_required`, `invalid_value` |
| `inspection.update` | `inspections.write` | `inspection_client_uuid`, `checklist_result?`, `reading_value?`, `notes?` | `inspection_not_found`, `forbidden`, `conflict` (already reviewed) |
| `asset.set_status` | `assets.write` | `asset_id`, `status` (`operational`/`degraded`/`out_of_service`) | `asset_not_found`, `invalid_value` |

The mobile client currently enqueues `inspection.create` and
`asset.set_status`. `inspection.update` is implemented and tested by hand on
the server side but has no screen in the app — there is no edit form.

### Roles

| Role | Grants |
|---|---|
| `technician` | `sync.pull`, `inspections.write`, `inspections.photo` |
| `supervisor` | `sync.pull`, `inspections.*`, `assets.write` |
| `admin` | `*` |

`inspections.review` is granted only through the supervisor's `inspections.*`.
It controls two things: pulling other people's inspections, and being allowed
to touch an inspection you did not create.

---

## 3. Tables

| Table | Purpose | Notable columns |
|---|---|---|
| `users` | Accounts. | `password_hash` (bcrypt cost 12), `role`, `is_active`, unique `email`. |
| `auth_tokens` | Device sessions. | `token_hash` (SHA-256, unique), `expires_at`, `last_used_at`, `revoked_at`. |
| `login_attempts` | Throttle ledger. | Index on `(email, ip_address, created_at)`. |
| `sites` | Domain entity 1. | `deleted_at`, index `(updated_at, id)`. |
| `assets` | Domain entity 2. | `site_id`, `status` enum, `deleted_at`, index `(updated_at, id)`. |
| `inspections` | Domain entity 3. | `client_uuid` **unique**, `server`-side `status` (`submitted`/`reviewed`), `performed_at` vs `created_at`, `photo_count`, `deleted_at`, indexes `(updated_at, id)` and `(user_id, updated_at, id)`. |
| `inspection_photos` | Media. | `client_uuid` unique, `stored_path` relative to `UPLOAD_DIR`, `sha256`, `byte_size`, dimensions. |
| `sync_operations` | Idempotency ledger. | `client_uuid` **unique**, `operation`, `entity_type`/`entity_id`, `result_json`. |

Every synchronised table uses `DATETIME(3)` with
`ON UPDATE CURRENT_TIMESTAMP(3)`, so edits made by tooling outside this API
still reach devices.

### Local SQLite (device)

| Table | Purpose |
|---|---|
| `sites`, `assets` | Mirror of server rows, keyed on the server id. |
| `inspections` | Mirror **and** local-only records, keyed on `client_uuid`; `server_id` null until confirmed, `origin` is `local` or `server`. |
| `outbox` | Queued writes: `kind` (`operation`/`photo`), `state`, `attempts`, `next_attempt_at`, `last_error`, `parent_client_uuid`, `completed_at`. |
| `sync_state` | Key/value: `delta_cursor`, `last_sync_at`. |

---

## 4. Offline mechanisms

1. **Local-first writes.** Saving inserts into the mirror and the outbox. No
   network call is attempted on that path at all.
2. **Client-generated `client_uuid`** from the platform CSPRNG, minted before
   the record leaves the device. Sole basis for replay detection.
3. **Server-side idempotency ledger.** Ledger row and domain row commit in one
   transaction; a `UNIQUE` index arbitrates concurrent replays; the original
   response body is stored and replayed verbatim.
4. **Per-operation push results.** `applied`/`duplicate` clear the outbox
   entry, `rejected` parks it, and an operation with no result at all stays
   queued.
5. **Exponential backoff** (1→16 minutes, six attempts) with two distinct
   terminal states, `rejected` and `failed`.
6. **Stuck-item recovery.** Rows left in `sending` by a crash return to
   `pending` at launch.
7. **Delta pull with a lagged cursor.** Cursor sampled from the database clock
   before any read, then moved back by `SYNC_CURSOR_OVERLAP_SECONDS`.
8. **Idempotent apply.** Every pulled row is an upsert, so the overlap's
   duplicate deliveries cost nothing.
9. **Keyset-ordered paging** on `(updated_at, id)` with tie-group protection so
   the cursor never lands inside a group sharing one millisecond.
10. **Tombstones.** Soft deletes surface as `deleted_ids` in delta mode.
11. **Future-cursor recovery.** A cursor ahead of the server clock triggers a
    full reload instead of an empty delta forever.
12. **Photo phase gated by a join** on the parent's `server_id`.
13. **Offline vs unreachable vs refused** classified once, in `http.js`.
14. **Pending indicator** in every header, and a queue screen that shows state,
    attempts, next retry time and the server's reason for a refusal.
15. **Sync triggers**: sign-in, connection restored, manual. No polling timer.
16. **Session survives offline launch**: cached profile renders first, the
    server confirms in the background.
17. **The mirror is never emptied speculatively.** A full load prunes rows the
    server did not send only after every page has arrived; an interrupted load
    stores no cursor and changes nothing.
18. **Composition root.** The SQLite driver, the UUID generator and the sync
    transport are installed once in `App.js`, so `src/offline/` carries no
    device dependency and the whole cycle is testable.

---

## 5. Running it

```bash
# database
mysql -u root -p -e "CREATE DATABASE field_ops CHARACTER SET utf8mb4"
mysql -u root -p field_ops < api/database/schema.sql
mysql -u root -p field_ops < api/database/seed_demo.sql

# api
cp .env.example .env      # then edit DB_* and set APP_ENV=local
php -S 127.0.0.1:8000 api/index.php

# mobile
cd mobile && npm install && npx expo start

# tests (no device or server required)
php api/tests/run.php
cd mobile && npm test
```

Demo accounts are listed at the top of `api/database/seed_demo.sql`. On a
physical handset `localhost` is the handset, so point the app at the LAN
address:

```bash
EXPO_PUBLIC_API_URL=http://192.168.0.10:8000/api/v1 npx expo start
```

---

## 6. Tests

Two suites. Neither needs a device, a simulator, or a running server; one
optional group needs MySQL and says so when it cannot find one.

```bash
php api/tests/run.php     # 54 cases without a database, 62 with one
cd mobile && npm test     # 54 cases
```

Both exit non-zero on failure. `npm test` needs Node >= 22.7 (`node:test`,
`node:sqlite`); the version is declared in `mobile/package.json`.

### PHP — `api/tests/`

Plain PHP with a small harness (`support/harness.php`). There is no Composer in
this project and adding a dependency manager for one purpose was not worth it.

| Group | Needs a DB | Covers |
|---|---|---|
| cursor arithmetic | no | `sql_to_iso`, `iso_to_sql` (including UTC offset conversion and rejection of relative expressions like `tomorrow`), `sql_minus_seconds`, and the property that the overlap only ever moves a cursor backwards |
| delta cursor decision | no | `sync_normalise_cursor`: empty → full load, valid → delta, unparseable → 422, ahead of the server clock → self-heal to a full load, equal to the clock → still a delta |
| permissions | no | all four roles × all five permission slugs, prefix wildcards, the global wildcard, unknown/empty roles, empty slug, and the exact grant lists the login response advertises |
| upload validation | no | real bytes: a genuine PNG; a PNG named `.jpg` (the recorded type must follow the content); a PHP script named `.jpg`; a PNG signature with a payload behind it; a header declaring a 0x0 image; a real GIF; over/at/under the size limit; an understated `size` field; `UPLOAD_ERR_INI_SIZE`, `_PARTIAL`, `_NO_FILE`; a missing temp file; and the `is_uploaded_file` guard |
| idempotency ledger | SQLite (in-memory) | first application writes both rows; a replay returns `duplicate` and creates nothing; ten replays leave exactly one row; another user's replay is refused, not answered; a rejected domain write leaves no ledger row and closes the transaction; and a real SQLSTATE 23000 collision between two connections is resolved by reading back the winner |
| delta paging | SQLite (in-memory) | a complete page advises no cursor; a truncated page reports a watermark; a page never ends inside a group sharing one timestamp; a page that *is* one tie group overflows rather than splitting; paging to exhaustion delivers every row; the cursor is exclusive; tombstones appear in a delta and not in a full load |
| MySQL integration | **MySQL/MariaDB** | `schema.sql` executes; `db_now()` format; `ON UPDATE CURRENT_TIMESTAMP(3)` moves on its own; `LIMIT` bound with `PDO::PARAM_INT`; the pager against a real server; `INTERVAL` bound as an integer via `auth_issue_token`; the sliding expiry never passing the absolute ceiling |

The MySQL group runs against `TEST_DB_NAME` (default `field_ops_test`), never
the application database, and drops and recreates the tables in it:

```bash
DB_HOST=127.0.0.1 DB_USER=… DB_PASS=… TEST_DB_NAME=field_ops_test php api/tests/run.php
```

Without a reachable server it prints the address it tried and skips; the
remaining 54 cases (159 assertions) still run and the suite still exits 0.

### JavaScript — `mobile/tests/`

`node:test`, with the app's own SQL executed by `node:sqlite` through an
adapter (`support/nodeSqliteDriver.js`) that presents the expo-sqlite async
API. The schema under test is the one `db.js` creates, not a copy.

| File | Covers |
|---|---|
| `backoff.test.js` | 1→16 minute doubling, strict growth across the budget, a zero/negative attempt count still yielding the base delay, and the transition to `failed` at the cap |
| `failures.test.js` | every branch of the classifier: timeout → `offline` regardless of connectivity; disconnected → `offline`; connected but failed → `unreachable`; 4xx → `refused`; 5xx → `server_error`; `ok:false` inside a 200; session-dead codes → `session_expired` when authenticated and ordinary refusals when not; unparseable bodies → `invalid_response`; conservative defaults |
| `idempotency.test.js` | the UUID contract against the regex the API enforces, version/variant bit placement for all-zero and all-ones input, refusal of insufficient entropy, and 50,000 generated identifiers with no collision and no malformed value |
| `outbox.test.js` | queued → sending → done; a refusal is terminal and never reclaimed; six transient failures with growing delays ending in `failed`; an item inside its backoff is not claimed; stuck-`sending` recovery at launch without consuming the retry budget; releasing a batch offline costs no attempt; retry clears history but leaves in-flight items alone; discarding takes child photos and the unsent record but not a confirmed one; history pruning spares refusals |
| `syncCycle.test.js` | the photo gate (no `server_id`, no parent row, and the full two-cycle sequence where a photo only uploads after the push that confirms its parent); `applied`/`duplicate` clearing and `rejected` parking; an operation the server did not mention staying queued; results matched by `client_uuid` rather than position; an offline push leaving the batch untouched and stopping the cycle; a 5xx counting against the budget without being terminal; a refused photo parked while a broken one retries; upsert-on-redelivery; tombstones; `pruneMirror` sparing unsent work; **an interrupted full load leaving the mirror intact and storing no cursor**; a completed full load pruning and storing its cursor; `has_more` driving another page; a delta persisting page by page; phase ordering |

### What the tests found

They were worth writing on the first run. Three real defects, all fixed:

1. **The pager trimmed too much.** `sync_page()` dropped the final timestamp
   group from every truncated page, whether or not that group straddled the
   page boundary — so a page of 4 returned 3 rows for no reason. It now trims
   only when the probe row carries the boundary timestamp.
2. **A 0x0 image passed every check.** A hand-built PNG header declaring zero
   dimensions satisfied `finfo` and `getimagesize`. `upload_inspect()` now
   requires positive dimensions.
3. **A documented claim was false.** This repository asserted that `finfo` is
   fooled by an eight-byte magic header and `getimagesize()` is what catches
   it. Measured on PHP 8.4, it is the other way round: `getimagesize()` accepts
   a signature-plus-junk file and reports nonsense dimensions, while `finfo`
   calls it `application/octet-stream`. Both the code comment and
   `docs/architecture.md` were corrected to match what a test actually
   observed.

A fourth finding was environmental rather than a defect: **MariaDB accepts a
string-bound `LIMIT` where MySQL 8 rejects it.** The integration test asserts
the behaviour of whichever engine it is pointed at rather than pretending they
agree, and the production code binds as an integer for both.

### What was actually run, and on what

- PHP 8.4.21, all 62 cases green, including the MySQL group against **MariaDB
  10.11.14** — not MySQL 8. The two differ, and the one difference this suite
  touched is called out above.
- Node 22.22.2, all 54 cases green.
- Every `.php` file passes `php -l` (24 files). Every `.js`/`.mjs` file parses
  with `@babel/parser` (33 files). An import audit reports no unused imports and
  no missing exports.

Still not run: the Expo app has never been installed, built, or launched on a
device or simulator. The offline layer beneath the UI is now covered by tests;
the React components, navigation and native module calls are not.

---

## 7. Not implemented

This is a reference implementation. The following are absent, and their absence
is deliberate rather than overlooked:

**UI tests.** The suites cover the offline layer, the classifier, the API's
pure logic and its database interactions. No screen, context or navigator is
rendered by a test — no React Testing Library, no snapshot tests, no e2e. A
mistake inside `InspectionFormScreen` or `SyncContext` would not be caught.

**The app has never been run.** No `npm install`, no Metro bundle, no device.
Runtime faults of the ordinary kind — a misremembered `expo-image-picker`
field, a React Navigation option that moved — remain possible.

**Verified against MariaDB, not MySQL 8.** The integration group ran against
MariaDB 10.11 because that is what was installable in the environment. The
schema and queries target MySQL 8; the engines are close but not identical, and
one difference already surfaced (string-bound `LIMIT`).

**Review workflow.** `inspections.status` can be `reviewed` and the conflict
policy depends on it, but nothing in this repository *sets* it. There is no
supervisor review endpoint and no back office. The state exists so the conflict
path is real and reachable; the tool that produces it does not.

**Inspection editing on the device.** The server supports `inspection.update`;
the app has no edit screen and never enqueues it.

**Photo retrieval.** Photos can be uploaded but there is no endpoint that
serves them back and no screen that displays them. `stored_path` is recorded
and the directory is denied to the web server; a real deployment needs an
authenticated download route.

**Uploads accept a valid image with appended data.** Asserted in the test suite
rather than hidden. Harmless as deployed (generated filename, outside the web
root, never served by path), but it is a real limit of content sniffing.

**Attachment cleanup.** `ON DELETE CASCADE` removes `inspection_photos` rows
when an inspection is hard-deleted, but the files on disk are not removed.
Nothing hard-deletes inspections today, so the case does not currently arise.

**`login_attempts` retention.** Rows accumulate forever. A production
deployment needs a scheduled delete; there is no cron, no scheduler, and no
migration runner in this repository.

**Migrations.** `schema.sql` is a single create-from-scratch script. There is
no versioned migration system, so there is no upgrade path from one revision of
the schema to the next.

**Refresh tokens.** The session model is a single sliding bearer token with an
absolute ceiling. There is no refresh-token rotation and no way to extend a
session past `TOKEN_ABSOLUTE_DAYS` other than signing in again.

**Rate limiting beyond login.** `/sync/push` and the photo endpoint are bounded
by batch size and file size but are not rate limited per user.

**Multi-tenancy.** Every query is single-tenant. Adding tenants would mean a
`tenant_id` on every table and in every WHERE clause, which is a different
repository.

**Conflict UI.** A rejected item shows its error code and message. There is no
diff view, no "keep mine / keep theirs", and no merge assistance.

**Background sync.** Synchronisation only runs while the app is in the
foreground. There is no `expo-task-manager` background fetch and no push-driven
wake-up.

**Photo compression.** `expo-image-picker` is asked for `quality: 0.7` and
nothing else; there is no resize step, so a modern phone camera can still
produce a file near the 8 MB server limit.

**Observability.** `log_line()` appends to a file. There is no request id, no
structured logging, no metrics, and no tracing.

**`eas.json`.** Intentionally absent. Build profiles and store credentials are
deployment concerns and do not belong in a public repository.
