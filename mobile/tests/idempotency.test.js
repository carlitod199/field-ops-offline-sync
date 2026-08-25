import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';

import {
  CLIENT_UUID_PATTERN,
  isClientUuid,
  newClientUuid,
  setUuidGenerator,
  uuidV4FromBytes,
} from '../src/offline/idempotency.js';

test('the pattern accepts a canonical v4 UUID and rejects near misses', () => {
  assert.ok(isClientUuid('3f1c9d70-1a4e-4a2b-9c31-1b0f5a7d2e11'));

  // Version nibble is 1, not 4.
  assert.ok(!isClientUuid('3f1c9d70-1a4e-1a2b-9c31-1b0f5a7d2e11'));
  // Variant nibble is c, not 8/9/a/b.
  assert.ok(!isClientUuid('3f1c9d70-1a4e-4a2b-cc31-1b0f5a7d2e11'));
  // Structural rejections.
  assert.ok(!isClientUuid('3f1c9d70-1a4e-4a2b-9c31-1b0f5a7d2e1'), 'too short');
  assert.ok(!isClientUuid('3f1c9d701a4e4a2b9c311b0f5a7d2e11'), 'no separators');
  assert.ok(!isClientUuid('zzzzzzzz-1a4e-4a2b-9c31-1b0f5a7d2e11'), 'not hex');
  assert.ok(!isClientUuid(''), 'empty');
  assert.ok(!isClientUuid(null), 'null');
  assert.ok(!isClientUuid(12345), 'not a string');
});

test('the pattern matches the one the API enforces', () => {
  // api/core/request.php accepts /^[0-9a-f]{8}-[0-9a-f]{4}-...$/i. Anything
  // this client produces has to satisfy that, or a queued write is rejected on
  // arrival with no way to correct it.
  const serverPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (let i = 0; i < 200; i += 1) {
    const value = uuidV4FromBytes(randomBytes(16));
    assert.ok(CLIENT_UUID_PATTERN.test(value), value);
    assert.ok(serverPattern.test(value), `server would reject ${value}`);
  }
});

test('uuidV4FromBytes sets the version and variant bits', () => {
  // All-zero input: every nibble is 0 except the two the format mandates.
  const zeros = new Uint8Array(16);
  assert.equal(uuidV4FromBytes(zeros), '00000000-0000-4000-8000-000000000000');

  // All-ones input: the same two nibbles are forced down.
  const ones = new Uint8Array(16).fill(0xff);
  assert.equal(uuidV4FromBytes(ones), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});

test('uuidV4FromBytes refuses insufficient entropy', () => {
  assert.throws(() => uuidV4FromBytes(new Uint8Array(15)), /at least 16 bytes/);
  assert.throws(() => uuidV4FromBytes(null), /at least 16 bytes/);
});

test('generated identifiers are unique across a large sample', () => {
  // The property that matters: thousands of handsets minting identifiers
  // independently, all landing in one UNIQUE index on the server.
  setUuidGenerator(() => randomUUID());

  const seen = new Set();
  const sampleSize = 50_000;
  for (let i = 0; i < sampleSize; i += 1) {
    const value = newClientUuid();
    assert.ok(isClientUuid(value), `malformed: ${value}`);
    seen.add(value);
  }
  assert.equal(seen.size, sampleSize, 'a collision would mean a lost record on the server');
});

test('an injected generator is used verbatim', () => {
  setUuidGenerator(() => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  assert.equal(newClientUuid(), 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  setUuidGenerator(() => randomUUID());
});
