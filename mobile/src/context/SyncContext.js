import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

import { queueCounts, rehydrateStuck } from '../offline/queue';
import { lastSyncAt, runSync } from '../offline/synchronizer';
import { useAuth } from './AuthContext';

// ---------------------------------------------------------------------------
// Connectivity, the pending indicator, and when synchronisation runs.
//
// It runs on three triggers and no timer:
//
//   * signing in (or restoring a session on launch)
//   * the connection coming back
//   * the technician asking for it on the sync screen
//
// A periodic poll was considered and left out. On a handset that spends hours
// out of range it wakes the radio to fail, which is the fastest way to drain a
// battery in the field. The connection-restored event already covers the case
// a timer would catch, and covers it sooner.
// ---------------------------------------------------------------------------

const SyncContext = createContext(null);

export function SyncProvider({ children }) {
  const { isSignedIn } = useAuth();

  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [phase, setPhase] = useState(null);
  const [counts, setCounts] = useState({ pending: 0, rejected: 0, failed: 0 });
  const [lastSync, setLastSync] = useState(null);
  const [lastError, setLastError] = useState(null);

  // A ref, not state: the guard has to be readable synchronously inside the
  // callback, and a state update would not be visible to a second caller that
  // arrives in the same tick.
  const running = useRef(false);
  const wasOnline = useRef(true);
  const signedIn = useRef(isSignedIn);
  signedIn.current = isSignedIn;

  const refreshCounts = useCallback(async () => {
    setCounts(await queueCounts());
    setLastSync(await lastSyncAt());
  }, []);

  const synchronize = useCallback(async () => {
    if (running.current || !signedIn.current) return null;
    running.current = true;
    setSyncing(true);
    setLastError(null);
    try {
      const report = await runSync(setPhase);
      return report;
    } catch (error) {
      setLastError(error?.message || 'Synchronisation failed.');
      return null;
    } finally {
      running.current = false;
      setSyncing(false);
      setPhase(null);
      await refreshCounts();
    }
  }, [refreshCounts]);

  // Recover items left mid-flight by a crash, then show the current counts.
  useEffect(() => {
    rehydrateStuck()
      .then(refreshCounts)
      .catch(() => {});
  }, [refreshCounts]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state?.isConnected === true;
      setOnline(connected);
      // Only act on the transition into connectivity. NetInfo emits on any
      // interface change, and reacting to every event would start a sync on a
      // Wi-Fi channel switch. The previous value is kept in a ref rather than
      // read inside a state updater, which React may invoke more than once.
      if (connected && !wasOnline.current) synchronize();
      wasOnline.current = connected;
    });
    return () => unsubscribe();
  }, [synchronize]);

  useEffect(() => {
    if (isSignedIn) synchronize();
  }, [isSignedIn, synchronize]);

  const value = useMemo(
    () => ({
      online,
      syncing,
      phase,
      pendingCount: counts.pending,
      rejectedCount: counts.rejected,
      failedCount: counts.failed,
      lastSync,
      lastError,
      synchronize,
      refreshCounts,
    }),
    [online, syncing, phase, counts, lastSync, lastError, synchronize, refreshCounts],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync() {
  const context = useContext(SyncContext);
  if (!context) throw new Error('useSync must be used inside a SyncProvider');
  return context;
}

export default SyncContext;
