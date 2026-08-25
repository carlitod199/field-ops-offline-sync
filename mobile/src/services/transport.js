// ---------------------------------------------------------------------------
// The seam between the sync cycle and the network.
//
// `synchronizer.js` used to import `api.js` directly, which pulled in fetch,
// NetInfo and SecureStore — so the entire push/upload/pull cycle could only
// run on a device, and the parts of it most worth checking (what happens to a
// queued write when a response goes missing, when the parent of a photo is not
// confirmed yet, when a pull fails halfway) could not be exercised at all.
//
// The client is installed once, from `App.js`. It must provide the same four
// functions `api.js` exports: syncPull, syncPush, uploadInspectionPhoto and
// (unused here, but part of the same object) the auth calls.
// ---------------------------------------------------------------------------

let client = null;

/** Installs the transport. Called from App.js with the real API client. */
export function setSyncTransport(next) {
  client = next;
}

export function transport() {
  if (client === null) {
    throw new Error('No sync transport installed. Call setSyncTransport() during start-up.');
  }
  return client;
}
