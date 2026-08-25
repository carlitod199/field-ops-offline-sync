// ---------------------------------------------------------------------------
// Client-generated identity for a write.
//
// Every record the technician creates gets a UUID *on the handset*, at the
// moment it is saved — long before the server has any idea it exists. That
// identifier is what makes the whole queue safe to retry:
//
//   1. The app sends a queued write.
//   2. The server applies it and answers.
//   3. The answer is lost — tunnel dropped, app killed, phone in a basement.
//
// From the client's side, step 3 is indistinguishable from "the request never
// arrived", so it must send again. The server recognises the repeat by its
// client_uuid and returns the original result instead of creating a second
// record. Without an identifier chosen before the write leaves the device,
// there is nothing to recognise it by: the server's own id does not exist yet,
// and de-duplicating by content would merge two genuinely identical
// inspections taken minutes apart.
//
// The UUID must come from a cryptographic random source, not Math.random().
// Not for secrecy — the values are not secret — but for collision resistance:
// several thousand handsets minting identifiers independently, all landing in
// one UNIQUE index, is precisely the situation a weak generator ruins.
//
// The generator is injected from `App.js` rather than imported here, so this
// module — and the queue that depends on it — has no native dependency and can
// be exercised off-device.
// ---------------------------------------------------------------------------

/** Canonical UUID v4: version nibble 4, variant nibble 8/9/a/b. */
export const CLIENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isClientUuid(value) {
  return typeof value === 'string' && CLIENT_UUID_PATTERN.test(value);
}

let generator = null;

/** Installs the UUID source. Called from App.js with expo-crypto's randomUUID. */
export function setUuidGenerator(next) {
  generator = next;
}

/**
 * Assembles a UUID v4 string from 16 random bytes.
 *
 * Byte 6's high nibble becomes the version (4) and byte 8's top two bits
 * become the variant (10xx). Getting those wrong produces a string that looks
 * like a UUID and is not one, which is the kind of defect that only surfaces
 * when something downstream starts validating.
 */
export function uuidV4FromBytes(bytes) {
  if (!bytes || bytes.length < 16) {
    throw new Error('uuidV4FromBytes needs at least 16 bytes.');
  }
  const octets = Array.from(bytes.slice(0, 16));
  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;

  const hex = octets.map((byte) => byte.toString(16).padStart(2, '0'));
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * Resolves a generator from the platform when none was injected.
 *
 * Both branches are cryptographic. Web Crypto is present in modern runtimes;
 * `App.js` installs expo-crypto's generator explicitly so the app never has to
 * depend on that being true on every React Native version.
 */
function platformGenerator() {
  const webCrypto = globalThis.crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return () => webCrypto.randomUUID();
  }
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    return () => uuidV4FromBytes(webCrypto.getRandomValues(new Uint8Array(16)));
  }
  throw new Error(
    'No cryptographic random source available. Call setUuidGenerator() during start-up.',
  );
}

export function newClientUuid() {
  if (generator === null) {
    generator = platformGenerator();
  }
  return generator();
}

export default { newClientUuid, isClientUuid };
