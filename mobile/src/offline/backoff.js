// ---------------------------------------------------------------------------
// Retry schedule for queued writes.
//
// Pure arithmetic, kept apart from the queue so the policy can be read — and
// tested — without a database in the way.
//
// 1, 2, 4, 8, 16 minutes, then give up. A handset that drifts in and out of
// coverage must not spend its battery retrying every few seconds, and a server
// having a bad afternoon must not be hammered by a fleet of phones. The cap
// matters as much as the growth: an item that will never succeed has to stop
// consuming power and start being visible to a person instead.
// ---------------------------------------------------------------------------

/** Delay before attempt number `attempts + 1`, given `attempts` failures so far. */
export function attemptDelayMs(attempts) {
  const previous = Math.max(1, attempts);
  return 2 ** (previous - 1) * 60 * 1000;
}

/** Where an item lands after its `attempts`-th failure. */
export function stateAfterFailure(attempts, maxAttempts) {
  return attempts >= maxAttempts ? 'failed' : 'pending';
}

/** ISO timestamp of the next attempt. */
export function nextAttemptAt(attempts, now = Date.now()) {
  return new Date(now + attemptDelayMs(attempts)).toISOString();
}
