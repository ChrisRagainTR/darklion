import { useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { appBrand } from '../brand';
import { AccountSecurityScreen } from './AccountSecurityScreen';
import { ApiError, apiFetch } from '../api/client';
import { PrimaryButton } from '../components/PrimaryButton';
import { colors, radius, spacing } from '../theme/tokens';
import type { StaffLoginResponse } from '../types/api';

type Props = {
  onBackClientLogin: () => void;
  onSignedIn: (token: string) => Promise<void>;
};

export function StaffLoginScreen({ onBackClientLogin, onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode,setMfaCode]=useState('');
  const [setupToken,setSetupToken]=useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setError('');
    setBusy(true);
    try {
      const result = await apiFetch<StaffLoginResponse>('/firms/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), password,mfaCode:mfaCode.trim() }),
      });
      if (!result.token) throw new Error('Login did not return a staff session token.');
      if(result.mfaSetupRequired){setSetupToken(result.token);return;}
      await onSignedIn(result.token);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MFA_REQUIRED') setMfaRequired(true);
      setError(err instanceof Error ? err.message : 'Could not sign in as staff.');
    } finally {
      setBusy(false);
    }
  }

  if(setupToken)return <AccountSecurityScreen token={setupToken} mode="staff" onClose={()=>setSetupToken('')} onSignOut={()=>{setSetupToken('');setMfaCode('');setError('Authenticator enabled. Sign in with a new code or a recovery code.');}}/>;
  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{flexGrow:1}}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.wrap}>
      <View style={styles.brandHeader}>
        <Text style={styles.businessName}>{appBrand}</Text>
        <Text style={styles.title}>Staff Login</Text>
      </View>
      <Text style={styles.copy}>Sign in with your DarkLion staff account.</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Staff email</Text>
        <TextInput
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          onChangeText={setEmail}
          placeholder="staff@example.com"
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
        <PrimaryButton disabled={busy || !email.trim() || !password} title={busy ? 'Signing in…' : 'Sign in as staff'} onPress={submit} />
        {busy && <ActivityIndicator color={colors.gold2} />}
        <Pressable onPress={onBackClientLogin} style={styles.clientLink}>
          <Text style={styles.clientLinkText}>Back to client login</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView></ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.sm },
  brandHeader: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  brandLogo: { width: 108, height: 108 },
  businessName: { color: colors.gold, fontSize: 13, fontWeight: '900', letterSpacing: 1.8, textAlign: 'center', textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 36, fontWeight: '900', letterSpacing: -1.2, lineHeight: 39, textAlign: 'center' },
  copy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginBottom: spacing.md, textAlign: 'center' },
  card: { borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(31,36,48,0.94)', padding: spacing.md, gap: spacing.sm },
  label: { color: colors.muted, fontSize: 13, fontWeight: '800' },
  input: { minHeight: 52, borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(5,8,14,0.46)', color: colors.text, paddingHorizontal: spacing.md, fontSize: 16 },
  error: { color: colors.red, fontSize: 13, lineHeight: 18 },
  clientLink: { minHeight: 42, alignItems: 'center', justifyContent: 'center' },
  clientLinkText: { color: colors.gold2, fontSize: 14, fontWeight: '900' },
});
