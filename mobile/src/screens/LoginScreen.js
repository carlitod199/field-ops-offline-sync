import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, ErrorText } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL, ENVIRONMENT } from '../services/config';
import { colors, radius, spacing } from '../theme';

// Sign-in is the one screen that genuinely requires a connection: the device
// has no way to verify a password on its own, and caching a verifier locally
// would put an offline-crackable secret on the handset. Everything after this
// screen works without a network.

export default function LoginScreen() {
  const { signIn, signingIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);

  const submit = async () => {
    setError(null);
    try {
      await signIn(email, password);
    } catch (failure) {
      setError(failure?.message || 'Sign-in failed.');
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Field Ops</Text>
        <Text style={styles.subtitle}>Asset inspections</Text>

        <Text style={styles.label}>E-mail</Text>
        <TextInput
          style={styles.input}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          textContentType="emailAddress"
          placeholder="john@example.com"
          placeholderTextColor={colors.textMuted}
        />

        <Text style={styles.label}>Password</Text>
        <TextInput
          style={styles.input}
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          autoCapitalize="none"
          textContentType="password"
          placeholder="••••••••"
          placeholderTextColor={colors.textMuted}
          onSubmitEditing={submit}
          returnKeyType="go"
        />

        <ErrorText>{error}</ErrorText>

        <View style={styles.actions}>
          <Button label="Sign in" onPress={submit} busy={signingIn} disabled={!email || !password} />
        </View>

        {/* Which backend this build talks to. Invaluable when a tester reports
            that "the app is broken" while pointing at the wrong environment. */}
        <Text style={styles.environment}>
          {ENVIRONMENT} · {API_BASE_URL}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, paddingTop: spacing.xl * 2 },
  title: { color: colors.text, fontSize: 30, fontWeight: '700' },
  subtitle: { color: colors.textMuted, fontSize: 16, marginBottom: spacing.xl },
  label: { color: colors.textMuted, fontSize: 13, marginBottom: spacing.xs, marginTop: spacing.md },
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
  actions: { marginTop: spacing.lg },
  environment: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: spacing.xl,
    textAlign: 'center',
  },
});
