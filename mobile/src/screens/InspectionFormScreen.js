import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';

import { Badge, Button, Card, ErrorText } from '../components/ui';
import { insertLocalInspection, listInspections } from '../offline/db';
import { enqueueOperation, enqueuePhoto } from '../offline/queue';
import { newClientUuid } from '../offline/idempotency';
import { useSync } from '../context/SyncContext';
import { colors, radius, spacing } from '../theme';

// ---------------------------------------------------------------------------
// The screen that has to work with no connection at all.
//
// Saving does three things, in one place, in this order:
//
//   1. mints a client_uuid
//   2. writes the inspection to the local mirror, so it appears in the list
//      immediately
//   3. queues an `inspection.create` operation, and one `photo` entry per
//      attachment
//
// Nothing here touches the network. The synchroniser drains the queue whenever
// a connection exists, and until then the record is as real to the technician
// as any other.
// ---------------------------------------------------------------------------

const RESULTS = [
  { value: 'pass', label: 'Pass', tone: 'positive' },
  { value: 'attention', label: 'Attention', tone: 'warning' },
  { value: 'fail', label: 'Fail', tone: 'danger' },
];

export default function InspectionFormScreen({ route }) {
  const { assetId } = route.params;
  const { synchronize, online, refreshCounts } = useSync();

  const [checklistResult, setChecklistResult] = useState('pass');
  const [readingValue, setReadingValue] = useState('');
  const [readingUnit, setReadingUnit] = useState('');
  const [notes, setNotes] = useState('');
  const [photos, setPhotos] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [recent, setRecent] = useState([]);

  const loadRecent = useCallback(() => {
    listInspections(assetId)
      .then(setRecent)
      .catch(() => setRecent([]));
  }, [assetId]);

  useFocusEffect(useCallback(() => loadRecent(), [loadRecent]));

  const addPhoto = async () => {
    setError(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Camera permission is required to attach a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, exif: false });
    if (result.canceled || !result.assets?.length) return;

    const asset = result.assets[0];
    setPhotos((current) => [
      ...current,
      {
        uri: asset.uri,
        mimeType: asset.mimeType || 'image/jpeg',
        fileName: asset.fileName || `inspection-${current.length + 1}.jpg`,
      },
    ]);
  };

  const save = async () => {
    setError(null);
    setConfirmation(null);
    setSaving(true);

    try {
      const clientUuid = newClientUuid();
      // The handset clock is the source of truth for when the work happened;
      // the server records separately when it received the record.
      const performedAt = new Date().toISOString();
      const parsedReading = readingValue.trim() === '' ? null : Number(readingValue.replace(',', '.'));

      if (parsedReading !== null && Number.isNaN(parsedReading)) {
        setError('The reading must be a number.');
        return;
      }

      await insertLocalInspection({
        clientUuid,
        assetId,
        checklistResult,
        readingValue: parsedReading,
        readingUnit: readingUnit.trim() || null,
        notes: notes.trim() || null,
        performedAt,
      });

      await enqueueOperation({
        clientUuid,
        operation: 'inspection.create',
        payload: {
          asset_id: assetId,
          checklist_result: checklistResult,
          reading_value: parsedReading,
          reading_unit: readingUnit.trim() || null,
          notes: notes.trim() || null,
          performed_at: performedAt,
        },
      });

      for (const photo of photos) {
        await enqueuePhoto({
          parentClientUuid: clientUuid,
          uri: photo.uri,
          mimeType: photo.mimeType,
          fileName: photo.fileName,
          capturedAt: performedAt,
        });
      }

      setReadingValue('');
      setReadingUnit('');
      setNotes('');
      setPhotos([]);
      setChecklistResult('pass');
      setConfirmation(
        online ? 'Saved. Syncing now.' : 'Saved on this device. It will sync when you are back online.',
      );

      await refreshCounts();
      loadRecent();
      if (online) synchronize();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Checklist result</Text>
      <View style={styles.choices}>
        {RESULTS.map((option) => (
          <Button
            key={option.value}
            label={option.label}
            variant={checklistResult === option.value ? 'primary' : 'secondary'}
            onPress={() => setChecklistResult(option.value)}
          />
        ))}
      </View>

      <Text style={styles.label}>Reading</Text>
      <View style={styles.readingRow}>
        <TextInput
          style={[styles.input, styles.readingValue]}
          value={readingValue}
          onChangeText={setReadingValue}
          keyboardType="decimal-pad"
          placeholder="0.00"
          placeholderTextColor={colors.textMuted}
        />
        <TextInput
          style={[styles.input, styles.readingUnit]}
          value={readingUnit}
          onChangeText={setReadingUnit}
          autoCapitalize="none"
          placeholder="unit"
          placeholderTextColor={colors.textMuted}
        />
      </View>

      <Text style={styles.label}>Notes</Text>
      <TextInput
        style={[styles.input, styles.notes]}
        value={notes}
        onChangeText={setNotes}
        multiline
        placeholder="What did you observe?"
        placeholderTextColor={colors.textMuted}
      />

      <Text style={styles.label}>Photos ({photos.length})</Text>
      <Button label="Take a photo" variant="secondary" onPress={addPhoto} />
      <Text style={styles.hint}>
        Photos are queued with the inspection and upload after the server confirms it.
      </Text>

      <ErrorText>{error}</ErrorText>
      {confirmation ? <Text style={styles.confirmation}>{confirmation}</Text> : null}

      <View style={styles.saveRow}>
        <Button label="Save inspection" onPress={save} busy={saving} />
      </View>

      <Text style={styles.sectionTitle}>Recent inspections on this asset</Text>
      {recent.length === 0 ? (
        <Text style={styles.hint}>None recorded yet.</Text>
      ) : (
        recent.map((item) => (
          <Card key={item.client_uuid}>
            <View style={styles.recentRow}>
              <Text style={styles.recentResult}>{item.checklist_result}</Text>
              <Badge
                label={item.server_id ? 'Synced' : queueLabel(item.queue_state)}
                tone={item.server_id ? 'positive' : queueTone(item.queue_state)}
              />
            </View>
            <Text style={styles.meta}>{formatTimestamp(item.performed_at)}</Text>
            {item.reading_value !== null ? (
              <Text style={styles.meta}>
                {item.reading_value}
                {item.reading_unit ? ` ${item.reading_unit}` : ''}
              </Text>
            ) : null}
            {item.notes ? <Text style={styles.notesPreview}>{item.notes}</Text> : null}
          </Card>
        ))
      )}
    </ScrollView>
  );
}

function queueLabel(state) {
  if (state === 'rejected') return 'Rejected';
  if (state === 'failed') return 'Not sent';
  return 'Queued';
}

function queueTone(state) {
  if (state === 'rejected' || state === 'failed') return 'danger';
  return 'warning';
}

function formatTimestamp(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  label: { color: colors.textMuted, fontSize: 13, marginTop: spacing.md, marginBottom: spacing.xs },
  choices: { flexDirection: 'row', gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.sm,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    minHeight: 48,
  },
  readingRow: { flexDirection: 'row', gap: spacing.sm },
  readingValue: { flex: 2 },
  readingUnit: { flex: 1 },
  notes: { minHeight: 96, textAlignVertical: 'top' },
  hint: { color: colors.textMuted, fontSize: 12, marginTop: spacing.xs },
  confirmation: { color: colors.positive, fontSize: 14, marginTop: spacing.sm },
  saveRow: { marginTop: spacing.lg },
  sectionTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: '600',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  recentRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  recentResult: { color: colors.text, fontSize: 16, fontWeight: '600', textTransform: 'capitalize' },
  meta: { color: colors.textMuted, fontSize: 13, marginTop: 2 },
  notesPreview: { color: colors.text, fontSize: 14, marginTop: spacing.xs },
});
