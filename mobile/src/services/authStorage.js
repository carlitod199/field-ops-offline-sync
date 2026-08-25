import * as SecureStore from 'expo-secure-store';

// ---------------------------------------------------------------------------
// Where the session lives on the device.
//
// The bearer token is long-lived (weeks) because a field handset cannot be
// asked to sign in again on a site with no coverage. A token with that
// lifetime does not belong in AsyncStorage, which is a plain file readable by
// anything that can read the app sandbox — on a rooted or jailbroken device,
// or through a backup. SecureStore puts it in the iOS Keychain and in Android's
// EncryptedSharedPreferences, backed by the hardware keystore where present.
//
// The cached user profile lives next to it. It is not secret, but keeping both
// in one store means one call clears the whole session with no chance of
// leaving half of it behind.
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'field_ops_token';
const USER_KEY = 'field_ops_user';

export async function saveSession(token, user) {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function readToken() {
  return SecureStore.getItemAsync(TOKEN_KEY);
}

export async function readUser() {
  const raw = await SecureStore.getItemAsync(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_error) {
    // A corrupted entry is treated as "no session" rather than crashing the
    // launch path; the next sign-in overwrites it.
    return null;
  }
}

export async function saveUser(user) {
  await SecureStore.setItemAsync(USER_KEY, JSON.stringify(user));
}

export async function clearSession() {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
  await SecureStore.deleteItemAsync(USER_KEY);
}
