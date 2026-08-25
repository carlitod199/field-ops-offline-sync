import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Badge, Card, EmptyState } from '../components/ui';
import { listAssets, setAssetStatusLocally } from '../offline/db';
import { enqueueOperation } from '../offline/queue';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { colors, radius, spacing } from '../theme';

// Supervisors can change an asset's status from the field, and that change
// travels through exactly the same offline queue as an inspection: same
// client_uuid, same retry rules, same visibility on the sync screen. The role
// check below only decides whether the control is drawn — the server checks
// the permission again for every operation in the batch.

const STATUSES = [
  { value: 'operational', label: 'Operational', tone: 'positive' },
  { value: 'degraded', label: 'Degraded', tone: 'warning' },
  { value: 'out_of_service', label: 'Out of service', tone: 'danger' },
];

const statusMeta = (value) => STATUSES.find((status) => status.value === value);

export default function AssetsScreen({ route, navigation }) {
  const { siteId } = route.params;
  const { can } = useAuth();
  const { refreshCounts, online, synchronize } = useSync();
  const [assets, setAssets] = useState([]);

  const canSetStatus = can('assets.write');

  const load = useCallback(() => {
    listAssets(siteId)
      .then(setAssets)
      .catch(() => setAssets([]));
  }, [siteId]);

  useFocusEffect(useCallback(() => load(), [load]));

  const changeStatus = useCallback(
    async (asset, status) => {
      if (asset.status === status) return;
      await setAssetStatusLocally(asset.id, status);
      await enqueueOperation({
        operation: 'asset.set_status',
        payload: { asset_id: asset.id, status },
      });
      load();
      await refreshCounts();
      if (online) synchronize();
    },
    [load, refreshCounts, online, synchronize],
  );

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={assets}
      keyExtractor={(item) => String(item.id)}
      ListEmptyComponent={<EmptyState title="No assets at this site" />}
      renderItem={({ item }) => {
        const meta = statusMeta(item.status);
        return (
          <Card>
            <Pressable
              onPress={() =>
                navigation.navigate('InspectionForm', { assetId: item.id, assetName: item.name })
              }
            >
              <View style={styles.row}>
                <Text style={styles.name}>{item.name}</Text>
                <Badge label={meta?.label || item.status} tone={meta?.tone || 'neutral'} />
              </View>
              <Text style={styles.meta}>
                {item.code}
                {item.category ? ` · ${item.category}` : ''}
              </Text>
            </Pressable>

            {canSetStatus ? (
              <View style={styles.statusRow}>
                {STATUSES.map((status) => (
                  <Pressable
                    key={status.value}
                    onPress={() => changeStatus(item, status.value)}
                    style={[styles.statusChip, item.status === status.value && styles.statusChipActive]}
                  >
                    <Text style={styles.statusChipLabel}>{status.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </Card>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  name: { color: colors.text, fontSize: 17, fontWeight: '600', flexShrink: 1 },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: spacing.xs },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.md,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: spacing.sm,
  },
  statusChip: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  statusChipActive: { backgroundColor: colors.surfaceAlt, borderColor: colors.accent },
  statusChipLabel: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
});
