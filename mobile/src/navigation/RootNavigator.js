import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import LoginScreen from '../screens/LoginScreen';
import SitesScreen from '../screens/SitesScreen';
import AssetsScreen from '../screens/AssetsScreen';
import InspectionFormScreen from '../screens/InspectionFormScreen';
import SyncStatusScreen from '../screens/SyncStatusScreen';
import { useAuth } from '../context/AuthContext';
import { useSync } from '../context/SyncContext';
import { colors, radius, spacing } from '../theme';

const Stack = createNativeStackNavigator();

const navigationTheme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

/**
 * The pending indicator, in the header of every signed-in screen.
 *
 * It is deliberately always visible rather than only when something is
 * queued: a technician needs to be able to glance at it and see "0" as an
 * answer, not to infer it from the absence of a badge.
 */
function SyncIndicator({ navigation }) {
  const { online, pendingCount, rejectedCount, failedCount, syncing } = useSync();
  const problems = rejectedCount + failedCount;

  return (
    <Pressable onPress={() => navigation.navigate('SyncStatus')} style={styles.indicator} hitSlop={8}>
      {syncing ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
      <View
        style={[
          styles.dot,
          { backgroundColor: online ? colors.positive : colors.warning },
        ]}
      />
      <Text style={[styles.indicatorText, problems > 0 && styles.indicatorProblem]}>
        {problems > 0 ? `${pendingCount} · ${problems}!` : String(pendingCount)}
      </Text>
    </Pressable>
  );
}

export default function RootNavigator() {
  const { restoring, isSignedIn } = useAuth();

  if (restoring) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTitleStyle: { color: colors.text },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        {!isSignedIn ? (
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
        ) : (
          <>
            <Stack.Screen
              name="Sites"
              component={SitesScreen}
              options={({ navigation }) => ({
                title: 'Sites',
                headerRight: () => <SyncIndicator navigation={navigation} />,
              })}
            />
            <Stack.Screen
              name="Assets"
              component={AssetsScreen}
              options={({ route, navigation }) => ({
                title: route.params?.siteName || 'Assets',
                headerRight: () => <SyncIndicator navigation={navigation} />,
              })}
            />
            <Stack.Screen
              name="InspectionForm"
              component={InspectionFormScreen}
              options={({ route, navigation }) => ({
                title: route.params?.assetName || 'Inspection',
                headerRight: () => <SyncIndicator navigation={navigation} />,
              })}
            />
            <Stack.Screen name="SyncStatus" component={SyncStatusScreen} options={{ title: 'Sync' }} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
  indicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  indicatorText: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  indicatorProblem: { color: colors.danger },
});
