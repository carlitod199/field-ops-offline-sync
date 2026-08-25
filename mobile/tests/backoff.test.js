import test from 'node:test';
import assert from 'node:assert/strict';

import { attemptDelayMs, nextAttemptAt, stateAfterFailure } from '../src/offline/backoff.js';
import { MAX_SEND_ATTEMPTS } from '../src/services/config.js';

test('backoff doubles from one minute', () => {
  assert.equal(attemptDelayMs(1), 60_000);
  assert.equal(attemptDelayMs(2), 120_000);
  assert.equal(attemptDelayMs(3), 240_000);
  assert.equal(attemptDelayMs(4), 480_000);
  assert.equal(attemptDelayMs(5), 960_000);
});

test('backoff is strictly increasing up to the retry budget', () => {
  for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
    assert.ok(
      attemptDelayMs(attempt + 1) > attemptDelayMs(attempt),
      `delay must grow from attempt ${attempt} to ${attempt + 1}`,
    );
  }
});

test('a zero or negative attempt count still yields the base delay', () => {
  // Guards against a caller passing an uninitialised counter and getting a
  // delay of zero, which would turn the backoff into a spin.
  assert.equal(attemptDelayMs(0), 60_000);
  assert.equal(attemptDelayMs(-3), 60_000);
});

test('an item is parked once it exhausts the budget', () => {
  for (let attempt = 1; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
    assert.equal(stateAfterFailure(attempt, MAX_SEND_ATTEMPTS), 'pending', `attempt ${attempt}`);
  }
  assert.equal(stateAfterFailure(MAX_SEND_ATTEMPTS, MAX_SEND_ATTEMPTS), 'failed');
  assert.equal(stateAfterFailure(MAX_SEND_ATTEMPTS + 1, MAX_SEND_ATTEMPTS), 'failed');
});

test('nextAttemptAt is an ISO timestamp in the future', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  assert.equal(nextAttemptAt(1, now), '2026-08-25T12:01:00.000Z');
  assert.equal(nextAttemptAt(3, now), '2026-08-25T12:04:00.000Z');
});
