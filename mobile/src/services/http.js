import NetInfo from '@react-native-community/netinfo';

import { API_BASE_URL, REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from './config';
import { readToken } from './authStorage';
import { ApiError, classifyResponse, classifyTransportFailure } from './failures';

// ---------------------------------------------------------------------------
// The single place that speaks HTTP.
//
// Everything above this file works with `ApiError` and plain JavaScript
// objects. Everything below it — the envelope, the bearer header, timeouts,
// the difference between "no signal" and "the server said no" — is handled
// here exactly once.
//
// The classification itself lives in ./failures.js, which is pure and tested.
// This file does the I/O and asks that module what the result means.
// ---------------------------------------------------------------------------

// Re-exported so existing callers keep importing it from the module they talk
// to; the definition lives in ./failures.js.
export { ApiError };

let onSessionExpired = null;

// AuthContext registers the callback that drops the local session. Wiring it
// this way keeps http.js free of any dependency on React state.
export function setSessionExpiredHandler(handler) {
  onSessionExpired = handler;
}

async function isConnected() {
  try {
    const state = await NetInfo.fetch();
    return state?.isConnected === true;
  } catch (_error) {
    // If NetInfo itself fails, assume offline: the safe direction is the one
    // that keeps the write queued.
    return false;
  }
}

// Wraps a fetch in an abort-based timeout. React Native's fetch has no timeout
// of its own, and a request against a captive portal can hang indefinitely.
async function withTimeout(run, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

// Turns a fetch-level failure into an ApiError. NetInfo is only consulted when
// the request was not aborted, because a timeout is classified without it.
async function transportError(error) {
  const aborted = error?.name === 'AbortError';
  const verdict = classifyTransportFailure({
    aborted,
    connected: aborted ? false : await isConnected(),
  });
  return new ApiError(verdict.code, verdict.message, 0, verdict.outcome);
}

// Unwraps the response envelope and raises ApiError on failure.
async function readEnvelope(response, authenticated) {
  let body = null;
  try {
    body = await response.json();
  } catch (_error) {
    body = null;
  }

  const verdict = classifyResponse({
    httpOk: response.ok,
    status: response.status,
    body,
    authenticated,
  });

  if (verdict.outcome === 'success') {
    return body;
  }

  if (verdict.outcome === 'session_expired') {
    try {
      onSessionExpired?.();
    } catch (_error) {
      // Never let the session-teardown callback mask the original failure.
    }
  }

  throw new ApiError(verdict.code, verdict.message, verdict.status, verdict.outcome);
}

async function authHeaders(authenticated) {
  const headers = { Accept: 'application/json' };
  if (!authenticated) return headers;
  const token = await readToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function request(method, path, body, { authenticated = true } = {}) {
  const headers = await authHeaders(authenticated);
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json';
  }

  let response;
  try {
    response = await withTimeout(
      (signal) =>
        fetch(`${API_BASE_URL}${path}`, {
          method,
          headers,
          body: body === undefined || body === null ? undefined : JSON.stringify(body),
          signal,
        }),
      REQUEST_TIMEOUT_MS,
    );
  } catch (error) {
    throw await transportError(error);
  }

  return readEnvelope(response, authenticated);
}

// Multipart upload. It bypasses `request` because the body must stay a
// FormData instance: setting Content-Type by hand would drop the multipart
// boundary that the runtime generates.
async function upload(path, formData) {
  const headers = await authHeaders(true);

  let response;
  try {
    response = await withTimeout(
      (signal) => fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers, body: formData, signal }),
      UPLOAD_TIMEOUT_MS,
    );
  } catch (error) {
    throw await transportError(error);
  }

  return readEnvelope(response, true);
}

export const http = {
  get: (path, options) => request('GET', path, null, options),
  post: (path, body, options) => request('POST', path, body, options),
  upload,
};

export default http;
