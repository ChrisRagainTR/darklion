import { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { appBrand } from '../brand';
import { ApiError, apiFetch } from '../api/client';
import { PrimaryButton } from '../components/PrimaryButton';
import { colors, radius, spacing } from '../theme/tokens';
import type { PortalLoginResponse } from '../types/api';

type Props = {
  canUseBiometricLogin?: boolean;
  onBiometricLogin?: () => Promise<void>;
  onSignedIn: (token: string) => Promise<void>;
  onOpenStaffLogin?: () => void;
};

export function LoginScreen({ canUseBiometricLogin = false, onBiometricLogin, onSignedIn, onOpenStaffLogin }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode,setMfaCode]=useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [biometricBusy, setBiometricBusy] = useState(false);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const result = await apiFetch<PortalLoginResponse>('/portal-auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password, mfaCode:mfaCode.trim() }),
      });
      if (!result.token) throw new Error('Login did not return a session token.');
      await onSignedIn(result.token);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setMfaRequired(true);
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  async function submitBiometricLogin() {
    if (!onBiometricLogin || biometricBusy) return;
    setError('');
    setBiometricBusy(true);
    try {
      await onBiometricLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Face ID login was not available.');
    } finally {
      setBiometricBusy(false);
    }
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{flexGrow:1}}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
      <View style={styles.brandHeader}>
        <Text style={styles.businessName}>{appBrand}</Text>
        <Text style={styles.title}>Client Portal</Text>
      </View>
      <Text style={styles.copy}>Sign in with the client account provided by your firm.</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Email</Text>
        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor="rgba(153,164,180,0.58)"
          style={styles.input}
          value={email}
        />
        <Text style={styles.label}>Password</Text>
        <TextInput
          autoComplete="current-password"
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor="rgba(153,164,180,0.58)"
          secureTextEntry
          style={styles.input}
          value={password}
        />
        {mfaRequired && <View><Text style={styles.label}>Authenticator or recovery code</Text><TextInput accessibilityLabel="Authenticator or recovery code" value={mfaCode} onChangeText={setMfaCode} autoCapitalize="none" autoComplete="one-time-code" style={styles.input}/></View>}
        {!!error && <Text style={styles.error}>{error}</Text>}
        {canUseBiometricLogin && (
          <Pressable disabled={biometricBusy} onPress={submitBiometricLogin} style={({ pressed }) => [styles.biometricButton, pressed && styles.biometricPressed, biometricBusy && styles.biometricDisabled]}>
            <Text style={styles.biometricIcon}>⌘</Text>
            <Text style={styles.biometricText}>{biometricBusy ? 'Checking Face ID…' : 'Log in with Face ID'}</Text>
          </Pressable>
        )}
        <PrimaryButton disabled={busy || !email.trim() || !password} title={busy ? 'Signing in…' : 'Sign in'} onPress={submit} />
        {busy && <ActivityIndicator color={colors.gold2} />}
        {!!onOpenStaffLogin && (
          <Pressable onPress={onOpenStaffLogin} style={styles.staffLink}>
            <Text style={styles.staffLinkText}>Staff login</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView></ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
  },
  brandHeader: {
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  brandLogo: {
    width: 108,
    height: 108,
  },
  businessName: { color: colors.gold, fontSize: 13, fontWeight: '900', letterSpacing: 1.8, textAlign: 'center', textTransform: 'uppercase' },
  title: {
    color: colors.text,
    fontSize: 36,
    fontWeight: '900',
    letterSpacing: -1.2,
    lineHeight: 39,
    textAlign: 'center',
  },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginBottom: spacing.md, textAlign: 'center' },
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: 'rgba(31,36,48,0.94)',
    padding: spacing.md,
    gap: spacing.sm,
  },
  label: { color: colors.muted, fontSize: 13, fontWeight: '800' },
  input: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(5,8,14,0.46)',
    color: colors.text,
    paddingHorizontal: spacing.md,
    fontSize: 16,
  },
  biometricButton: { minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(201,168,76,0.38)', backgroundColor: 'rgba(201,168,76,0.12)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 },
  biometricPressed: { backgroundColor: 'rgba(201,168,76,0.18)' },
  biometricDisabled: { opacity: 0.65 },
  biometricIcon: { color: colors.gold2, fontSize: 18, fontWeight: '900' },
  biometricText: { color: colors.gold2, fontSize: 15, fontWeight: '900' },
  error: { color: colors.red, fontSize: 13, lineHeight: 18 },
  staffLink: { minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  staffLinkText: { color: colors.gold2, fontSize: 14, fontWeight: '900' },
});
