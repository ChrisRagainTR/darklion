import * as SecureStore from 'expo-secure-store';

export type SessionMode = 'client' | 'staff';

const TOKEN_KEYS: Record<SessionMode, string> = {
  client: 'darklion.portalToken',
  staff: 'darklion.staffToken',
};
const ACTIVE_SESSION_MODE_KEY = 'darklion.activeSessionMode';
const BIOMETRIC_ENABLED_KEY = 'darklion.biometricEnabled';

function normalizeMode(value: string | null): SessionMode | null {
  return value === 'client' || value === 'staff' ? value : null;
}

export async function getActiveSessionMode() {
  return normalizeMode(await SecureStore.getItemAsync(ACTIVE_SESSION_MODE_KEY));
}

export async function setActiveSessionMode(mode: SessionMode) {
  await SecureStore.setItemAsync(ACTIVE_SESSION_MODE_KEY, mode);
}

export async function clearActiveSessionMode() {
  await SecureStore.deleteItemAsync(ACTIVE_SESSION_MODE_KEY);
}

export async function getStoredToken(mode: SessionMode = 'client') {
  return SecureStore.getItemAsync(TOKEN_KEYS[mode]);
}

export async function setStoredToken(token: string, mode: SessionMode = 'client') {
  await SecureStore.setItemAsync(TOKEN_KEYS[mode], token);
  await setActiveSessionMode(mode);
}

export async function clearStoredToken(mode: SessionMode = 'client') {
  await SecureStore.deleteItemAsync(TOKEN_KEYS[mode]);
  const activeMode = await getActiveSessionMode();
  if (activeMode === mode) await clearActiveSessionMode();
}

export async function getBiometricEnabled() {
  return (await SecureStore.getItemAsync(BIOMETRIC_ENABLED_KEY)) === 'true';
}

export async function setBiometricEnabled(enabled: boolean) {
  await SecureStore.setItemAsync(BIOMETRIC_ENABLED_KEY, enabled ? 'true' : 'false');
}

export function isJwtExpired(token: string | null, skewMs = 30000) {
  if (!token) return true;
  try {
    const [, payload] = token.split('.');
    if (!payload) return true;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded.exp) return false;
    return decoded.exp * 1000 <= Date.now() + skewMs;
  } catch {
    return true;
  }
}
