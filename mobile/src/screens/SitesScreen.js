import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import { Card, EmptyState } from '../components/ui';
import { listSites } from '../offline/db';
import { useSync } from '../context/SyncContext';
import { colors, spacing } from '../theme';

// Reads come from the local mirror, never from the network. That is the whole
// point: the list renders identically whether or not there is a signal, and
// pulling to refresh triggers a sync rather than a fetch.

export default function SitesScreen({ navigation }) {
  const { synchronize, syncing } = useSync();
  const [sites, setSites] = useState([]);

  const load = useCallback(() => {
    listSites()
      .then(setSites)
      .catch(() => setSites([]));
  }, []);

  // Reload on focus so a background sync that finished while the technician
  // was on another screen is reflected when they come back.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const refresh = useCallback(async () => {
    await synchronize();
    load();
  }, [synchronize, load]);

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={styles.content}
      data={sites}
      keyExtractor={(item) => String(item.id)}
      refreshControl={<RefreshControl refreshing={syncing} onRefresh={refresh} tintColor={colors.textMuted} />}
      ListEmptyComponent={
        <EmptyState
          title="No sites yet"
          hint="Pull down to synchronise once you have a connection."
        />
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() => navigation.navigate('Assets', { siteId: item.id, siteName: item.name })}
        >
          <Card>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.meta}>{item.code}</Text>
            {item.address ? <Text style={styles.meta}>{item.address}</Text> : null}
          </Card>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md },
  name: { color: colors.text, fontSize: 17, fontWeight: '600' },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
});
