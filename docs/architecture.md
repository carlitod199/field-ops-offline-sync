# Offline-first architecture

This document explains how `field-ops-offline-sync` keeps a mobile client
usable with no network, and how the work done during that time reaches the
server exactly once.

The domain is deliberately plain: a technician visits **sites**, each site has
**assets**, and the technician records **inspections** against an asset — a
checklist result, an optional numeric reading, notes, and photos. Nothing in
the mechanism below depends on that domain; it is the shape of the problem
that matters.

---

## 1. What "offline-first" has to mean

"Works offline" is often taken to mean the app caches reads. That is the easy
half. The hard half is writes: a technician standing in a plant room with no
signal has to be able to record an inspection, walk away, and be confident it
will arrive.

That single requirement forces almost every decision in this repository:

- A write cannot be an HTTP request. It has to be a durable local record that
  a background process later turns into a request.
- Retries are therefore not exceptional; they are the normal path. Anything
  the server does in response to a write must be safe to do twice.
- The client cannot wait for a server-assigned identifier before it considers
  a record real, so it has to be able to name records itself.
- The user has to be able to see what has and has not left the device, or they
  will re-enter work "to be safe" and create duplicates by hand.

---

## 2. Two kinds of local data

The device database (`mobile/src/offline/db.js`) holds two things that must
never be confused.

**The mirror** — `sites`, `assets`, `inspections`. A cache of server-owned
state. It is disposable: deleting it costs a full re-download and nothing
else. Reads in the UI come from here and only from here, which is what makes
every list render identically with and without a connection.

The mirror is only ever written to. Rows the server no longer has are removed
after a full load has completed end to end, never before it starts — an earlier
design emptied the mirror up front, which left the technician with a blank site
list whenever a page of that load failed, and on a field handset it regularly
does.

**The outbox** — queued writes the server has not acknowledged. This is the
only data in the app that exists nowhere else. Losing it loses the
technician's work. Every trade-off in the code favours the outbox: a full
reload clears the mirror but never the outbox, discarding an item is an
explicit user action, and a write is committed locally before any network call
is attempted.

Inspections live in the mirror table even before the server has seen them,
keyed by `client_uuid`, with `server_id` left null. The technician's list is
then a single query instead of a union of "synced" and "not yet synced", and
there is no moment where a record they just saved is invisible.

---

## 3. The write path

```
technician saves the form
        │
        ├──▶ INSERT into inspections   (server_id = NULL, origin = 'local')
        │
        └──▶ INSERT into outbox        (client_uuid, 'inspection.create', payload)
                                        state = 'pending'
```

No network call happens on this path at all — not even a "try it, and queue on
failure" attempt. Making the queue the *only* route to the server means there
is exactly one code path to reason about, and it is the one that gets
exercised on every save rather than only when the signal is bad.

The outbox states:

```
pending ──send──▶ sending ──ack────▶ done
   ▲                 │
   │                 ├──rule refusal──▶ rejected
   │                 │
   └──transient failure, backoff──┐
                                  └──attempts exhausted──▶ failed
```

`rejected` and `failed` are both terminal, and they are separate on purpose.
`rejected` means the server looked at the write and refused it — a missing
asset, an inspection somebody already reviewed. Retrying it unchanged can only
produce the same answer, so the app stops and tells the technician. `failed`
means the app never got an answer often enough to keep trying. The record may
well be fine; it just has not gone anywhere. Those two situations need
different words on screen because they need different actions from a person.

Transient failures back off exponentially from one minute (1, 2, 4, 8, 16),
giving up after six attempts. A handset drifting in and out of coverage should
not burn its battery retrying every few seconds, and a server having a bad
afternoon should not be hammered by a fleet of phones.

An item stuck in `sending` — the app was killed between handing a batch to
`fetch()` and recording the outcome — is returned to `pending` at launch. That
recovery is unconditional and needs no bookkeeping, because re-sending is safe
by construction. Which is the next section.

---

## 4. Client-generated UUIDs, and why they are the only answer

Every record gets a UUID on the handset, at the moment it is saved, from the
platform CSPRNG (`expo-crypto`'s `randomUUID()`). That identifier is the
record's identity for the rest of its life, and it is what the server uses to
recognise a retry.

The situation it exists for:

1. The app sends a queued write.
2. The server applies it and answers.
3. The answer is lost — the tunnel drops, the process is killed, the phone
   goes into a basement.

From the client's side, step 3 is **indistinguishable** from "the request
never arrived". It must send again. So the server must be able to tell that
the second request is the same operation as the first.

Nothing else can play that role:

- *The server's id* does not exist when the record is created, which is
  precisely the window that needs covering.
- *A content hash* would collapse two genuinely identical inspections recorded
  five minutes apart — a real and common event on a round of similar assets.
- *A sequence number per device* needs a device registry, survives neither a
  reinstall nor a restore from backup, and collides across devices.

Only the client can name the operation before it exists, so only a
client-generated identifier works.

On the server (`api/core/idempotency.php`) the UUID lands in
`sync_operations`, which has a `UNIQUE` index on it, and — critically — **the
ledger row is written inside the same transaction as the domain row**. That is
what makes the pair atomic. There is no instant at which an inspection exists
without its ledger entry, and therefore no window in which a retry could
insert a second copy. If two copies of the same batch are in flight at once,
the unique index arbitrates: one insert wins, the other gets a 23000, reads
back the winner's stored result, and reports `duplicate`.

The stored `result_json` is the exact response body produced the first time,
so a replay is *answered* identically rather than recomputed.

---

## 5. A write that happens offline, and later syncs

```mermaid
sequenceDiagram
    autonumber
    actor Tech as Technician
    participant UI as Inspection form
    participant DB as SQLite (mirror + outbox)
    participant Sync as Synchronizer
    participant API as PHP API
    participant MySQL as MySQL

    Note over Tech,MySQL: No connection

    Tech->>UI: Save inspection (+ 1 photo)
    UI->>UI: newClientUuid() → 8b7a2c14-…
    UI->>DB: INSERT inspections (server_id NULL, origin 'local')
    UI->>DB: INSERT outbox (8b7a2c14…, 'inspection.create', pending)
    UI->>DB: INSERT outbox (photo, parent 8b7a2c14…, pending)
    UI-->>Tech: "Saved on this device"

    Note over Tech,MySQL: Signal returns — NetInfo fires

    Sync->>DB: claim pending operations
    Sync->>API: POST /sync/push [{client_uuid 8b7a2c14…, …}]
    API->>MySQL: BEGIN
    API->>MySQL: INSERT inspections
    API->>MySQL: INSERT sync_operations (same transaction)
    API->>MySQL: COMMIT
    API-->>Sync: results[0] = applied, entity_id 5012

    Note over Sync,API: Response lost on a bad link — Sync sees a timeout

    Sync->>DB: recordFailure → pending, retry in 1 min
    Sync->>API: POST /sync/push (same client_uuid)
    API->>MySQL: SELECT sync_operations WHERE client_uuid = 8b7a2c14…
    MySQL-->>API: row exists (entity_id 5012)
    API-->>Sync: results[0] = duplicate, entity_id 5012
    Note right of API: No second inspection is created

    Sync->>DB: attachServerId(8b7a2c14…, 5012); mark done

    Sync->>DB: claim photos WHERE parent server_id IS NOT NULL
    Sync->>API: POST /inspections/5012/photos (multipart)
    API->>MySQL: INSERT inspection_photos; photo_count + 1
    API-->>Sync: 201 created
    Sync->>DB: mark photo done

    Sync->>API: GET /sync/pull?updated_since=<cursor>
    API-->>Sync: changed rows + next_cursor
    Sync->>DB: upsert mirror; store next_cursor
    Sync-->>Tech: pending count → 0
```

---

## 6. The delta cursor

Reads are incremental. The client stores one cursor, sends it as
`updated_since`, receives every row whose `updated_at` is strictly greater,
and stores the cursor the server returns.

### The race

```
T0  request arrives; server reads the clock              → 12:00:00.000
T1  another connection's transaction stamps updated_at    → 12:00:00.001
T2  this request SELECTs — that row is not committed yet,
    so it is not returned
T3  the other transaction commits
T4  client stores the cursor and asks again
```

If the cursor had been sampled *after* the SELECT, it would already be past
`12:00:00.001`. The row from T1 is not in this response, and it will never be
in a future one either, because it is no longer `> cursor`. It is lost
silently and permanently — the worst class of bug in a sync system, because
nothing anywhere reports an error.

Two defences, and both are needed:

**1. Sample the cursor before any read.** `db_now()` in
`api/core/database.php` is memoised per request for exactly this reason. A row
written after the cursor was taken is by definition ahead of the cursor, and
is picked up next time.

**2. Move the cursor backwards by an overlap window.**
`SYNC_CURSOR_OVERLAP_SECONDS` (default 5) is subtracted from the sampled
value. MySQL stamps `updated_at` when the *statement* runs, not when the
transaction *commits*, so a write that started at 11:59:59.900 and commits at
12:00:00.400 carries a timestamp older than a cursor sampled at T0. The
overlap has to exceed the longest write transaction in the system; nothing
below the application layer enforces that, which is why it is a documented,
tunable setting rather than a constant buried in code.

The price is that a few rows are delivered twice on every pull. That costs
nothing, because the client applies every row as an upsert keyed on the server
id (`applyPulledPage` in `mobile/src/offline/db.js`). **Making the read side
idempotent is far cheaper than making it exact.**

### Clock ownership

The cursor is compared against `updated_at`, which MySQL stamps with *its*
clock. So the cursor must come from the database, never from PHP. Those two
clocks live on different hosts and can be minutes — or, on a misconfigured
managed database, hours — apart. A cursor taken from PHP that runs ahead of
the database hides new rows until real time catches up.

For the same reason the connection pins `SET time_zone = '+00:00'` and every
column is `DATETIME(3)` rather than `TIMESTAMP`: `TIMESTAMP`'s implicit
session-timezone conversion moves the comparison whenever a connection comes
up with a different time zone.

The client defends against the remaining case: if it presents a cursor that is
ahead of the server clock — after a clock correction on either side — the
server ignores it and performs a full load rather than serving an empty delta
forever.

### Paging, and the tie group

Each entity is read `ORDER BY updated_at, id LIMIT n+1`. `updated_at` alone is
not a total order, and an unstable sort makes paging both skip and repeat rows
at page boundaries.

Truncating a page raises a subtler problem. If the page ends in the middle of
a group of rows that share one `updated_at` value, and the cursor is set to
that value, the rest of the group is stranded: they are not `> cursor`, so
they are never delivered. `sync_page()` handles this by trimming the trailing
tie group off the page and setting the watermark to the last row *before* it.
If the entire page turns out to be one tie group — a bulk import landing in a
single millisecond — the group is re-read in full and the page is allowed to
overflow. Correctness wins over the page limit there.

Because the three entities are paged independently, the cursor returned when
any of them is truncated is the **lowest** watermark among the truncated ones.
Rows already delivered past that point simply arrive again on the next page.
Same trade as the overlap window, same reason it is acceptable.

### Deletes

Rows are soft-deleted (`deleted_at`). A hard delete leaves nothing for a delta
to report, so every device that cached the row keeps it forever. Soft deletion
turns a removal into an update, which the delta already knows how to deliver —
in delta mode, rows with `deleted_at` set come back as `deleted_ids` and the
client removes them locally. A full load simply excludes them.

---

## 7. Conflict resolution

The policy is deliberately narrow, because a general merge strategy is a
research project and this is a system that needs to be explainable to the
people using it.

**Server state wins for the mirror.** A pull overwrites the local copy of any
record, including records this device created. Once the server has
acknowledged an inspection, its version is the one that counts. Unsent edits
are not lost by this, because they live in the outbox and are replayed on the
next push — the mirror is display state, the outbox is truth.

**Client writes win over stored values, field by field, until a human
disagrees.** `inspection.update` applies only the fields present in the
payload (`COALESCE(:field, field)`), so a partial update never blanks columns
it did not intend to touch.

**A review is a hard stop.** If a supervisor has already reviewed an
inspection, a queued client update to it is rejected with `conflict` and never
retried. The reviewer made a decision about the data as it stood; silently
overwriting it would erase that decision with nobody noticing. The technician
sees the item marked as refused, with the reason, and decides what to do —
which is the only correct place for that decision.

**Last-writer-wins on assets.** `asset.set_status` is a small, idempotent state
change with no merge semantics worth inventing. The last write to arrive wins,
and the arrival order is the queue order.

What this policy explicitly does not attempt: three-way merges, vector clocks,
CRDTs, or per-field version tracking. They are correct answers to a harder
question than this system asks. Field inspections are append-mostly and edited
by one person, so the cost of that machinery buys almost nothing here.

---

## 8. Photos upload after the parent confirms

A photo is queued alongside its inspection but cannot be sent until the
inspection has a server id. The queue enforces that with a join rather than
with ordering:

```sql
SELECT o.*, i.server_id AS parent_server_id
  FROM outbox o
  JOIN inspections i ON i.client_uuid = o.parent_client_uuid
 WHERE o.kind = 'photo' AND i.server_id IS NOT NULL
```

A photo whose parent is unconfirmed is simply not returned, and waits for a
later cycle without needing a state of its own.

Three reasons the media is a separate endpoint and a separate phase rather
than a base64 field inside the push batch:

- **Size.** A push batch is JSON the server buffers and parses whole. One 4 MB
  photo becomes ~5.4 MB of base64 and drags every unrelated operation in the
  batch down with it. On a marginal connection the batch never completes and
  *nothing* syncs.
- **Failure isolation.** A photo that fails to upload must not stop the
  inspection from being recorded. The text record — the part with the
  operational value — lands first.
- **Ordering.** The photo needs a parent to attach to, and the client only
  learns the parent's server id when push confirms it.

Uploads run sequentially, not in parallel. These are large bodies on the
connection that was probably the reason the app was offline in the first
place, and three concurrent uploads on a weak link finish later than three
sequential ones while making each individual failure more likely.

Upload validation is content-based (`api/core/uploads.php`): PHP's own upload
error code, then size read from the file itself, then an extension allow-list,
then `finfo` on the magic bytes, then `getimagesize()` to confirm the file
decodes as the type it claims and has real dimensions.

The last two are not redundant, and the reason is the opposite of the intuitive
one. Measured (and asserted in `api/tests/cases/uploads_test.php`): a file that
is nothing but the PNG signature followed by arbitrary bytes is *accepted* by
`getimagesize()`, which reports nonsense dimensions and claims `IMAGETYPE_PNG`;
`finfo` is the one that rejects it, as `application/octet-stream`. Conversely,
`getimagesize()` is what catches a header whose declared type disagrees with
the detected one, or which declares a 0x0 image. Each check covers a case the
other misses.

Neither catches a genuinely valid image with bytes appended after the image
data — that file really is an image. It is harmless here because stored files
get a generated random name in a directory outside the web root and are never
served by path; the client's filename is kept for display and never used to
build one. The limitation is asserted in the test suite so that it stays
visible rather than being assumed away.

---

## 9. Sessions

The bearer token is opaque — 32 random bytes as 64 hex characters — and not a
JWT. A field handset stays signed in for weeks, so being able to revoke one
device immediately is worth more than stateless verification, and a stateless
token cannot be revoked without building the very lookup table the JWT was
supposed to avoid.

Only the SHA-256 of the token is stored, so a dump of `auth_tokens` yields no
usable sessions. SHA-256 rather than bcrypt is correct here precisely because
the token has 256 bits of entropy: there is no dictionary to slow down, and
the digest sits on the hot path of every request.

The lifetime slides — each authenticated call may push `expires_at` out by
`TOKEN_TTL_DAYS` — but never past `created_at + TOKEN_ABSOLUTE_DAYS`. A device
that is never signed out still has to re-authenticate eventually. `last_used_at`
is written at most once a minute so a busy sync loop does not turn every read
into a write.

On the device the token lives in `expo-secure-store` (iOS Keychain, Android
EncryptedSharedPreferences), not in AsyncStorage, which is a plain file
readable by anything that can read the app sandbox or a backup.

On launch the app trusts the stored session and renders immediately, then
confirms with `GET /auth/me` in the background. Only an explicit
`token_*` rejection signs the user out. Verifying before rendering would turn
every dead spot into a locked app — the single most damaging bug an
offline-first field client can have.

No PHP session is ever started, no cookie is set, and CSRF is therefore not
applicable: it is a token API consumed by a native client.

---

## 10. Alternatives considered and rejected

**A commit-ordered change sequence instead of a timestamp cursor.** A single
`change_seq` counter assigned at commit time removes the delta race entirely —
no overlap window, no clock ownership question, no tie groups. It was rejected
because assigning it correctly means either a serialising counter table (a
write hotspot on every domain write) or database-specific machinery
(`GTID`/logical replication positions) that ties the API to one deployment. A
five-second overlap plus an idempotent client applies the same guarantee at a
fraction of the cost. On a system with a higher write rate or stricter
delivery requirements, this is the first thing to revisit.

**Sending each queued write as its own request.** Simpler to reason about, and
much worse on a bad link: N round trips instead of one, N TLS handshakes if
connections are not reused, and N chances to fail halfway. Batching with
per-operation results keeps the granularity of individual failures without the
round-trip cost.

**A full-batch transaction on push.** Rejected because one bad operation would
roll back good ones, and the client would then have to choose between
re-sending known-good writes and dropping unknown ones. Per-operation
transactions cost more `BEGIN`/`COMMIT` pairs and are worth it.

**Server-side de-duplication by payload hash.** Rejected: see §4. It cannot
distinguish a retry from a genuinely repeated observation.

**A background timer that syncs every N minutes.** Rejected. On a handset that
spends hours out of range it wakes the radio only to fail, which is the
fastest way to flatten a battery in the field. The three triggers actually
used — sign-in, connection restored, manual — cover the same ground and the
connection-restored event fires sooner than any poll would.

**AsyncStorage for the token.** Rejected: a multi-week credential in plaintext
on the device. See §9.

**A last-write-wins merge with per-field timestamps.** Rejected as
disproportionate. See §7.

---

## 11. Testing, and the seams that made it possible

A repository about idempotency and cursor correctness has to demonstrate them,
not assert them. Two suites do, and neither needs a device or a running server:

```
php api/tests/run.php     # PHP: 62 cases
cd mobile && npm test     # JavaScript: 54 cases
```

Three refactors were needed to get the offline layer under test, and each one
improved the design independently of testing:

**A composition root.** `App.js` now installs the three things the offline
layer depends on — a SQLite binding (`setSqliteDriver`), a random source
(`setUuidGenerator`) and something that can reach the server
(`setSyncTransport`) — instead of each module importing its own native
dependency. `src/offline/` is consequently plain JavaScript with no device
dependency at all, and the dependencies are visible in one place rather than
scattered through the tree.

**The failure classifier moved out of the network layer.**
`src/services/failures.js` is pure: given what happened, it says what kind of
failure it was. `http.js` performs the I/O and asks. The decision that governs
whether a technician's work is retried or discarded is now readable on its own
and asserted branch by branch.

**Upload validation returns a verdict instead of ending the request.**
`upload_inspect()` reports what it found; `upload_validate()` is the wrapper
that turns a verdict into a 422. Real image bytes can therefore be fed to the
real checks.

The tests run against real engines, not mocks: the JavaScript suite drives the
app's own SQL through `node:sqlite`, and the PHP suite drives the pager and the
ledger — including a genuine `UNIQUE` collision between two connections —
through PDO SQLite. A further group runs against MySQL and skips with a stated
reason when none is reachable, because `ON UPDATE CURRENT_TIMESTAMP(3)` and
integer-bound `LIMIT`/`INTERVAL` parameters cannot be verified anywhere else.

Writing them was worth it on the first run. The suite found three real defects:
the pager trimmed a whole timestamp group off every truncated page, not just
one that straddled the boundary; a crafted header declaring a 0x0 image passed
every check; and the claim in this document that `finfo` is fooled by an
eight-byte magic header was simply wrong — it is `getimagesize()` that is
fooled, which is documented correctly in §8 now because a test measured it.

## 12. Known failure modes

| Situation | What happens |
|---|---|
| No signal when saving | Record is committed locally; queue drains later. Nothing is lost. |
| Response lost after the server applied a write | Retry returns `duplicate` from the ledger. No second record. |
| App killed mid-send | Item is stuck in `sending`; returned to `pending` at next launch and re-sent safely. |
| Server refuses a write on a rule | Item goes to `rejected` with the reason; the technician retries or discards explicitly. |
| Six failed attempts | Item goes to `failed` and stops consuming battery; visible on the sync screen. |
| Device clock wrong | `performed_at` in the future is clamped server-side; a cursor ahead of the server triggers a full reload. |
| Rows written during the pull window | Covered by the overlap; delivered again next pull and upserted. |
| More than one page of changes | `has_more` drives an immediate next page; the cursor advances only as far as is safe. |
| A full load interrupted partway | No cursor is stored and nothing is pruned, so the next cycle restarts the load. The mirror keeps serving the previous data throughout. |
| Photo queued for an inspection that is later discarded | Discarding an item removes its child photo entries too — without a parent they could never upload. |
