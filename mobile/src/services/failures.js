// ---------------------------------------------------------------------------
// How a failed call is classified.
//
// This is the single most consequential decision an offline-first client makes,
// and it used to be buried inside `http.js` between two `fetch` calls where it
// could not be tested. It is pure: given what happened, it says what kind of
// failure it was. `http.js` performs the I/O and asks this module what the
// result means.
//
// Four outcomes, and they lead to four different behaviours:
//
//   offline       — no usable connection. The write is still valid; it stays
//                   queued and the sync cycle stops.
//   unreachable   — there *is* a network but the server did not answer: a
//                   wrong base URL, DNS that does not resolve, a TLS failure.
//                   Telling someone "you are offline" here sends them to check
//                   their signal instead of their configuration.
//   refused       — the server evaluated the request and said no (4xx).
//                   Retrying it unchanged cannot help.
//   server_error  — the server broke (5xx). Transient by default; retry.
//
// Confusing the first with the third is how a technician's work gets thrown
// away; confusing the third with the first is how a client retries forever.
// ---------------------------------------------------------------------------

/**
 * A failure the client can branch on.
 *
 * `outcome` is the classification below; `code` is the server's stable machine
 * code where there is one. Callers decide whether to retry from `outcome`,
 * never from the HTTP status.
 *
 * It lives here rather than in http.js so that modules which only need to
 * *interpret* an error — the synchroniser, for one — do not have to import the
 * networking layer to do it.
 */
export class ApiError extends Error {
  constructor(code, message, status, outcome) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status; // 0 when the request never completed
    this.outcome = outcome;
  }
}

/** Codes that mean the stored session is dead on the server. */
export const SESSION_DEAD_CODES = ['token_missing', 'token_invalid', 'token_revoked', 'token_expired'];

/**
 * Classifies a failure that happened before any response was read.
 *
 * `aborted` is true when the request hit its timeout. A timeout is treated as
 * offline: the connection exists but is unusable, which for queueing purposes
 * is the same thing as having none.
 */
export function classifyTransportFailure({ aborted = false, connected = false } = {}) {
  if (aborted) {
    return { outcome: 'offline', code: 'offline', message: 'The request timed out. The record stays queued.' };
  }
  if (connected) {
    return {
      outcome: 'unreachable',
      code: 'unreachable',
      message: 'The server could not be reached. Check the API address.',
    };
  }
  return { outcome: 'offline', code: 'offline', message: 'No connection. The record stays queued.' };
}

/**
 * Classifies a response that was received and parsed.
 *
 * `body` is the decoded envelope, or null when the payload did not parse. The
 * API's error handlers guarantee JSON even for a 500, so an unparseable body
 * means something in front of the API answered — a proxy error page, a captive
 * portal login screen — and is reported as such rather than as a server fault.
 */
export function classifyResponse({ httpOk, status, body, authenticated = true }) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      outcome: 'invalid_response',
      code: 'invalid_response',
      message: 'The server returned an unexpected response.',
      status,
    };
  }

  if (httpOk && body.ok !== false) {
    return { outcome: 'success', code: null, message: null, status };
  }

  const code = body.error || 'request_failed';

  if (authenticated && SESSION_DEAD_CODES.includes(code)) {
    return {
      outcome: 'session_expired',
      code: 'session_expired',
      message: 'Session expired. Sign in again.',
      status,
    };
  }

  return {
    outcome: status >= 500 ? 'server_error' : 'refused',
    code,
    message: body.message || 'The request could not be completed.',
    status,
  };
}
