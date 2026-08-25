import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

// A handful of shared primitives. Not a design system — just enough to keep
// the screens readable and free of repeated StyleSheet blocks.

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Button({ label, onPress, variant = 'primary', disabled = false, busy = false }) {
  const isDisabled = disabled || busy;
  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'danger' && styles.buttonDanger,
        isDisabled && styles.buttonDisabled,
        pressed && !isDisabled && styles.buttonPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <Text style={styles.buttonLabel}>{label}</Text>
      )}
    </Pressable>
  );
}

/** Colour-coded status chip used for queue states and asset status. */
export function Badge({ label, tone = 'neutral' }) {
  return (
    <View style={[styles.badge, styles[`badge_${tone}`]]}>
      <Text style={[styles.badgeLabel, styles[`badgeLabel_${tone}`]]}>{label}</Text>
    </View>
  );
}

export function EmptyState({ title, hint }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {hint ? <Text style={styles.emptyHint}>{hint}</Text> : null}
    </View>
  );
}

/** Inline error text. Kept separate so no screen invents its own error styling. */
export function ErrorText({ children }) {
  if (!children) return null;
  return <Text style={styles.error}>{children}</Text>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: radius.sm,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonSecondary: { backgroundColor: colors.surfaceAlt },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.8 },
  buttonLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    backgroundColor: colors.surfaceAlt,
  },
  badge_neutral: { backgroundColor: colors.surfaceAlt },
  badge_positive: { backgroundColor: 'rgba(62, 207, 142, 0.16)' },
  badge_warning: { backgroundColor: 'rgba(242, 181, 68, 0.16)' },
  badge_danger: { backgroundColor: 'rgba(239, 95, 95, 0.16)' },
  badgeLabel: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  badgeLabel_neutral: { color: colors.textMuted },
  badgeLabel_positive: { color: colors.positive },
  badgeLabel_warning: { color: colors.warning },
  badgeLabel_danger: { color: colors.danger },
  empty: { padding: spacing.xl, alignItems: 'center' },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '600', marginBottom: spacing.xs },
  emptyHint: { color: colors.textMuted, fontSize: 14, textAlign: 'center' },
  error: { color: colors.danger, fontSize: 14, marginTop: spacing.sm },
});
