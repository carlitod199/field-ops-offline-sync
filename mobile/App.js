import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

import { setSqliteDriver } from './src/offline/sqlite';
import { setUuidGenerator } from './src/offline/idempotency';
import { setSyncTransport } from './src/services/transport';
import api from './src/services/api';
import { AuthProvider } from './src/context/AuthContext';
import { SyncProvider } from './src/context/SyncContext';
import RootNavigator from './src/navigation/RootNavigator';

// ---------------------------------------------------------------------------
// Composition root.
//
// The three dependencies the offline layer needs — a SQLite binding, a random
// source, and something that can talk to the server — are installed here, at
// the entry point, instead of being imported deep inside the modules that use
// them. That keeps `src/offline/` free of any device dependency: the outbox,
// the retry policy, the sync cycle, the delta application and the photo gate
// are ordinary JavaScript, which is why they can be tested (see mobile/tests/).
//
// All three are set at module scope, before React renders, so nothing can
// reach the database, mint a client_uuid or attempt a request before its
// dependency exists.
// ---------------------------------------------------------------------------

setSqliteDriver({
  openDatabaseAsync: (name) => SQLite.openDatabaseAsync(name),
});

setUuidGenerator(() => Crypto.randomUUID());

setSyncTransport(api);

// Provider order matters: SyncProvider reads the session from AuthProvider to
// decide when to synchronise, so it has to sit inside it.
//
// The SQLite database is not opened here. Every module that needs it calls
// openDb(), which caches the in-flight promise, so the first screen that
// actually reads data pays for opening it and the launch path stays free of a
// blocking await.
export default function App() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <SyncProvider>
          <StatusBar style="light" />
          <RootNavigator />
        </SyncProvider>
      </AuthProvider>
    </SafeAreaProvider>
  );
}
