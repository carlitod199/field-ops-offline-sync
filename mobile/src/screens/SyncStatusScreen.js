import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Badge, Button, Card, EmptyState } from '../components/ui';
import { discardItem, listQueue, retryItem } from '../offline/queue';
import { resetCursor } from '../offline/synchronizer';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { colors, spacing } from '../theme';

// ---------------------------------------------------------------------------
// The queue, made visible.
//
// A technician who cannot see whether their work has left the device will
// re-enter it "just in case", and that is how duplicate records get created by
// people rather than by software. Showing the queue — with a state per item, a
// reason when something was refused, and an explicit retry — is what makes the
// offline behaviour trustworthy instead of merely correct.
// ---------------------------------------------------------------------------

const STATE_META = {
  pending: { label: 'Queued', tone: 'warning' },
  sending: { label: 'Sending', tone: 'warning' },
  done: { label: 'Sent', tone: 'positive' },
  rejected: { label: 'Refused', tone: 'danger' },
  failed: { label: 'Not sent', tone: 'danger' },
};

export default function SyncStatusScreen() {
  const { online, syncing, phase, pendingCount, rejectedCount, failedCount, lastSync, lastError, synchronize } =
    useSync();
  const { user, signOut } = useAuth();
  const [items, setItems] = useState([]);

  const load = useCallback(() => {
    listQueue()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  useFocusEffect(useCallback(() => load(), [load]));

  const syncNow = async () => {
    await synchronize();
    load();
  };

  const onRetry = async (clientUuid) => {
    await retryItem(clientUuid);
    load();
  };

  const onDiscard = async (clientUuid) => {
    await discardItem(clientUuid);
    load();
  };

  // Throws the delta cursor away so the next cycle performs a full load. The
  // outbox is untouched: this rebuilds the cache, it never discards work.
  const reloadEverything = async () => {
    await resetCursor();
    await synchronize();
    load();
  };

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.content}
      data={items}
      keyExtractor={(item) => item.client_uuid}
      ListHeaderComponent={
        <View>
          <Card>
            <View style={styles.row}>
              <Text style={styles.title}>Connection</Text>
              <Badge label={online ? 'Online' : 'Offline'} tone={online ? 'positive' : 'warning'} />
            </View>
            <Text style={styles.meta}>
              {pendingCount} waiting · {rejectedCount} refused · {failedCount} not sent
            </Text>
            <Text style={styles.meta}>Last completed sync: {formatTimestamp(lastSync)}</Text>
            {syncing ? <Text style={styles.meta}>Working: {phase || 'starting'}…</Text> : null}
            {lastError ? <Text style={styles.error}>{lastError}</Text> : null}
            <View style={styles.actions}>
              <Button label="Sync now" onPress={syncNow} busy={syncing} disabled={!online} />
            </View>
            <View style={styles.actions}>
              <Button
                label="Reload all data"
                variant="secondary"
                onPress={reloadEverything}
                disabled={!online || syncing}
              />
            </View>
          </Card>

          <Card>
            <Text style={styles.title}>{user?.name}</Text>
            <Text style={styles.meta}>
              {user?.email} · {user?.role}
            </Text>
            <View style={styles.actions}>
              <Button label="Sign out" variant="secondary" onPress={signOut} />
            </View>
            {pendingCount > 0 ? (
              <Text style={styles.warning}>
                {pendingCount} record{pendingCount === 1 ? '' : 's'} have not reached the server yet. Signing
                out keeps them on this device, but they will only sync once you sign in again.
              </Text>
            ) : null}
          </Card>

          <Text style={styles.sectionTitle}>Queue</Text>
        </View>
      }
      ListEmptyComponent={<EmptyState title="Nothing queued" hint="Everything on this device has been sent." />}
      renderItem={({ item }) => {
        const meta = STATE_META[item.state] || { label: item.state, tone: 'neutral' };
        const terminal = item.state === 'rejected' || item.state === 'failed';
        return (
          <Card>
            <View style={styles.row}>
              <Text style={styles.itemTitle}>{describe(item)}</Text>
              <Badge label={meta.label} tone={meta.tone} />
            </View>
            <Text style={styles.mono}>{item.client_uuid}</Text>
            <Text style={styles.meta}>Queued {formatTimestamp(item.created_at)}</Text>
            {item.attempts > 0 ? <Text style={styles.meta}>Attempts: {item.attempts}</Text> : null}
            {item.next_attempt_at && item.state === 'pending' ? (
              <Text style={styles.meta}>Next try {formatTimestamp(item.next_attempt_at)}</Text>
            ) : null}
            {item.last_error ? <Text style={styles.error}>{item.last_error}</Text> : null}
            {terminal ? (
              <View style={styles.itemActions}>
                <Button label="Try again" variant="secondary" onPress={() => onRetry(item.client_uuid)} />
                <Button label="Discard" variant="danger" onPress={() => onDiscard(item.client_uuid)} />
              </View>
            ) : null}
          </Card>
        );
      }}
    />
  );
}

function describe(item) {
  if (item.kind === 'photo') return 'Photo upload';
  if (item.operation === 'inspection.create') return 'New inspection';
  if (item.operation === 'inspection.update') return 'Inspection correction';
  if (item.operation === 'asset.set_status') return 'Asset status change';
  return item.operation || item.kind;
}

function formatTimestamp(iso) {
  if (!iso) return 'never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString();
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  title: { color: colors.text, fontSize: 16, fontWeight: '600' },
  itemTitle: { color: colors.text, fontSize: 15, fontWeight: '600', flexShrink: 1 },
  sectionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  mono: { color: colors.textMuted, fontSize: 11, marginTop: spacing.xs, fontFamily: 'monospace' },
  error: { color: colors.danger, fontSize: 13, marginTop: spacing.xs },
  warning: { color: colors.warning, fontSize: 13, marginTop: spacing.sm },
  actions: { marginTop: spacing.md },
  itemActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
});
