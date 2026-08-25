import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_DEAD_CODES,
  classifyResponse,
  classifyTransportFailure,
} from '../src/services/failures.js';

// The classification decides whether a technician's work is retried or thrown
// away, so every branch is asserted, including the ones that look obvious.

test('a timeout is offline, whatever the radio says', () => {
  // The connection exists but is unusable. For queueing purposes that is the
  // same as having none, and consulting NetInfo here would only produce a
  // "you are online" message next to a request that did not work.
  const verdict = classifyTransportFailure({ aborted: true, connected: true });
  assert.equal(verdict.outcome, 'offline');
  assert.equal(verdict.code, 'offline');
});

test('a failure with no connectivity is offline', () => {
  const verdict = classifyTransportFailure({ aborted: false, connected: false });
  assert.equal(verdict.outcome, 'offline');
  assert.match(verdict.message, /stays queued/);
});

test('a failure while connected is unreachable, not offline', () => {
  // A wrong base URL, DNS that does not resolve, a TLS failure. Reporting this
  // as "offline" sends people to check their signal instead of the address.
  const verdict = classifyTransportFailure({ aborted: false, connected: true });
  assert.equal(verdict.outcome, 'unreachable');
  assert.match(verdict.message, /API address/);
});

test('defaults are the conservative ones', () => {
  // Called with nothing known, the answer must be the one that keeps the write.
  assert.equal(classifyTransportFailure().outcome, 'offline');
  assert.equal(classifyTransportFailure({}).outcome, 'offline');
});

test('a successful envelope is a success', () => {
  const verdict = classifyResponse({
    httpOk: true,
    status: 200,
    body: { ok: true, data: { id: 1 }, message: null },
  });
  assert.equal(verdict.outcome, 'success');
  assert.equal(verdict.code, null);
});

test('ok:false in a 200 body is still a failure', () => {
  // The envelope is authoritative. A proxy that rewrites the status must not
  // be able to turn a refusal into a success.
  const verdict = classifyResponse({
    httpOk: true,
    status: 200,
    body: { ok: false, error: 'asset_not_found', message: 'gone' },
  });
  assert.equal(verdict.outcome, 'refused');
  assert.equal(verdict.code, 'asset_not_found');
  assert.equal(verdict.message, 'gone');
});

test('a 4xx is refused', () => {
  const verdict = classifyResponse({
    httpOk: false,
    status: 409,
    body: { ok: false, error: 'conflict', message: 'already reviewed' },
  });
  assert.equal(verdict.outcome, 'refused');
  assert.equal(verdict.code, 'conflict');
  assert.equal(verdict.status, 409);
});

test('a 5xx is a server error, which is retryable', () => {
  // The difference that matters to the queue: `refused` is terminal, a server
  // fault is not. Collapsing them would either park good writes forever or
  // retry rejected ones forever.
  const verdict = classifyResponse({
    httpOk: false,
    status: 500,
    body: { ok: false, error: 'internal_error', message: 'Internal server error.' },
  });
  assert.equal(verdict.outcome, 'server_error');
  assert.equal(verdict.code, 'internal_error');
});

test('every session-dead code becomes session_expired when authenticated', () => {
  for (const code of SESSION_DEAD_CODES) {
    const verdict = classifyResponse({
      httpOk: false,
      status: 401,
      body: { ok: false, error: code, message: 'nope' },
      authenticated: true,
    });
    assert.equal(verdict.outcome, 'session_expired', code);
    assert.equal(verdict.code, 'session_expired', code);
  }
});

test('session codes on an unauthenticated call are ordinary refusals', () => {
  // Sign-in is unauthenticated. Treating a token error there as an expired
  // session would tear down a session that was never established.
  const verdict = classifyResponse({
    httpOk: false,
    status: 401,
    body: { ok: false, error: 'token_expired', message: 'nope' },
    authenticated: false,
  });
  assert.equal(verdict.outcome, 'refused');
  assert.equal(verdict.code, 'token_expired');
});

test('an unparseable body is invalid_response, not a server error', () => {
  // The API guarantees JSON even for a 500, so a body that did not parse means
  // something in front of the API answered: a proxy page, a captive portal.
  for (const body of [null, undefined, 'a string', [1, 2, 3]]) {
    const verdict = classifyResponse({ httpOk: false, status: 502, body });
    assert.equal(verdict.outcome, 'invalid_response', JSON.stringify(body));
  }
});

test('a failure with no error code still produces a usable one', () => {
  const verdict = classifyResponse({ httpOk: false, status: 400, body: { ok: false } });
  assert.equal(verdict.code, 'request_failed');
  assert.ok(verdict.message.length > 0);
});
