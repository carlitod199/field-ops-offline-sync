import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import api from '../services/api';
import { ApiError, setSessionExpiredHandler } from '../services/http';
import { clearSession, readToken, readUser, saveSession, saveUser } from '../services/authStorage';

// ---------------------------------------------------------------------------
// Session state.
//
// The rule that shapes this file: a technician on a site with no coverage must
// still be able to open the app and work. So the stored session is trusted on
// launch and the app renders immediately; the server is asked to confirm it in
// the background, and only an explicit rejection signs the user out.
//
// Doing it the other way round — verify, then render — turns every dead spot
// into a locked app, which is the single most damaging bug an offline-first
// field client can have.
// ---------------------------------------------------------------------------

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [restoring, setRestoring] = useState(true);
  const [user, setUser] = useState(null);
  const [signingIn, setSigningIn] = useState(false);

  const signOut = useCallback(async () => {
    // Tell the server if we can, but never block the local sign-out on it:
    // being unable to reach the network must not trap someone in a session.
    try {
      await api.logout();
    } catch (_error) {
      // Ignored on purpose — the token expires on its own.
    }
    await clearSession();
    setUser(null);
  }, []);

  // http.js calls this when the server reports the token is dead.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      clearSession().catch(() => {});
      setUser(null);
    });
    return () => setSessionExpiredHandler(null);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [token, storedUser] = await Promise.all([readToken(), readUser()]);
        if (cancelled || !token || !storedUser) return;

        // Render with the cached profile straight away.
        setUser(storedUser);

        // Then confirm in the background. A network failure here is expected
        // and ignored; only the session-expired path (handled above) signs out.
        try {
          const fresh = await api.me();
          if (!cancelled && fresh?.user) {
            setUser(fresh.user);
            await saveUser(fresh.user);
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
        }
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    setSigningIn(true);
    try {
      const deviceLabel = `${Platform.OS} ${Platform.Version}`;
      const session = await api.login(email.trim(), password, deviceLabel);
      await saveSession(session.token, session.user);
      setUser(session.user);
      return session.user;
    } finally {
      setSigningIn(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      restoring,
      signingIn,
      user,
      isSignedIn: user !== null,
      signIn,
      signOut,
      can: (permission) => hasPermission(user, permission),
    }),
    [restoring, signingIn, user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Mirrors the server's wildcard matching.
 *
 * This is a UI convenience only — it decides which buttons to show. The server
 * re-checks every operation, because a permission evaluated on a device the
 * user controls is a suggestion, not a control.
 */
export function hasPermission(user, permission) {
  const grants = user?.permissions || [];
  if (grants.includes('*') || grants.includes(permission)) return true;

  let prefix = '';
  for (const segment of permission.split('.')) {
    prefix = prefix === '' ? segment : `${prefix}.${segment}`;
    if (grants.includes(`${prefix}.*`)) return true;
  }
  return false;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

export default AuthContext;
