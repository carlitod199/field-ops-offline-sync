import http from './http';
import { PULL_PAGE_LIMIT } from './config';

// ---------------------------------------------------------------------------
// One function per endpoint. This layer knows the API's shape; nothing above
// it does. Callers receive the `data` object from the envelope, never the
// envelope itself.
// ---------------------------------------------------------------------------

export async function login(email, password, deviceLabel) {
  const body = await http.post(
    '/auth/login',
    { email, password, device_label: deviceLabel },
    { authenticated: false },
  );
  return body.data; // { token, expires_at, user }
}

export async function me() {
  const body = await http.get('/auth/me');
  return body.data; // { user, last_login_at }
}

export async function logout() {
  await http.post('/auth/logout', null);
}

/**
 * Delta read.
 *
 * `cursor` is whatever the server handed back last time, or null for the very
 * first synchronisation of a fresh install. The server decides what "since
 * null" means (a full load); the client never tries to invent a starting
 * timestamp of its own, because a device clock is not comparable with the
 * server's.
 */
export async function syncPull(cursor, limit = PULL_PAGE_LIMIT) {
  const params = new URLSearchParams();
  if (cursor) params.set('updated_since', cursor);
  params.set('limit', String(limit));
  const body = await http.get(`/sync/pull?${params.toString()}`);
  return body.data;
}

/**
 * Queued writes.
 *
 * `operations` is an array of { client_uuid, operation, payload }. The reply
 * carries one result per operation so the caller can clear exactly what
 * succeeded — see offline/synchronizer.js.
 */
export async function syncPush(operations) {
  const body = await http.post('/sync/push', { operations });
  return body.data; // { results, applied, duplicate, rejected }
}

/**
 * Photo upload for an already-confirmed inspection.
 *
 * `inspectionServerId` is the id the server assigned during push. There is no
 * way to call this before the parent is confirmed, which is the intended
 * constraint and not an inconvenience.
 */
export async function uploadInspectionPhoto(inspectionServerId, photo) {
  const form = new FormData();
  form.append('photo', {
    uri: photo.uri,
    name: photo.fileName || 'photo.jpg',
    type: photo.mimeType || 'image/jpeg',
  });
  form.append('client_uuid', photo.clientUuid);
  if (photo.capturedAt) form.append('captured_at', photo.capturedAt);

  const body = await http.upload(`/inspections/${inspectionServerId}/photos`, form);
  return body.data;
}

export default { login, me, logout, syncPull, syncPush, uploadInspectionPhoto };
