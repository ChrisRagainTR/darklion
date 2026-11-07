import { appBrand } from './src/brand';
import { useEffect, useRef, useState } from 'react';
import { Alert, AppState, ImageBackground, StyleSheet, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { LoginScreen } from './src/screens/LoginScreen';
import { StaffLoginScreen } from './src/screens/StaffLoginScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { StaffShell } from './src/staff/StaffShell';
import { MessagesScreen } from './src/screens/MessagesScreen';
import { TaxesScreen } from './src/screens/TaxesScreen';
import { DocumentsScreen } from './src/screens/DocumentsScreen';
import { TabBar, type ClientTab } from './src/components/TabBar';
import { WebSheet } from './src/components/WebSheet';
import { registerForClientNotifications, registerForStaffNotifications, unregisterClientNotifications, unregisterStaffNotifications } from './src/notifications/clientNotifications';
import {
  clearStoredToken,
  getActiveSessionMode,
  getBiometricEnabled,
  getStoredToken,
  isJwtExpired,
  type SessionMode,
  setBiometricEnabled,
  setStoredToken,
} from './src/storage/session';
import { colors } from './src/theme/tokens';
import { apiBaseUrl, setUnauthorizedHandler } from './src/api/client';

const BIOMETRIC_LOCK_GRACE_MS = 15 * 60 * 1000;

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [sessionMode, setSessionMode] = useState<SessionMode | null>(null);
  const [loginMode, setLoginMode] = useState<SessionMode>('client');
  const [booting, setBooting] = useState(true);
  const [unlocked, setUnlocked] = useState(false);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const [canUseBiometricLogin, setCanUseBiometricLogin] = useState(false);
  const [activeScreen, setActiveScreen] = useState<ClientTab>('home');
  const [visitedScreens, setVisitedScreens] = useState<string[]>(['home']);
  const [tabBadges, setTabBadges] = useState<Partial<Record<ClientTab, number>>>({});
  const [requestedDeliveryId, setRequestedDeliveryId] = useState<number | null>(null);
  const [organizerYear, setOrganizerYear] = useState<string | null>(null);
  const [homeRefreshKey, setHomeRefreshKey] = useState(0);
  function openClientScreen(screen: typeof activeScreen) {
    setVisitedScreens(prev => prev.includes(screen) ? prev : [...prev, screen]);
    setActiveScreen(screen);
  }
  function openReturn(deliveryId: number) {
    setRequestedDeliveryId(deliveryId);
    openClientScreen('taxes');
  }
  const appStateRef = useRef(AppState.currentState);
  const inactiveSinceRef = useRef<number | null>(null);

  async function refreshBiometricState() {
    const [enabled, hasHardware, isEnrolled] = await Promise.all([
      getBiometricEnabled(),
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    setBiometricEnabledState(enabled);
    setCanUseBiometrics(hasHardware && isEnrolled);
    return { enabled, canUse: hasHardware && isEnrolled };
  }

  async function refreshBiometricLoginAvailability(enabled = biometricEnabled, canUse = canUseBiometrics, mode = loginMode) {
    const storedToken = await getStoredToken(mode);
    setCanUseBiometricLogin(Boolean(enabled && canUse && storedToken && !isJwtExpired(storedToken)));
  }

  async function unlockIfPossible(preferredMode?: SessionMode) {
    const mode = preferredMode || await getActiveSessionMode() || loginMode;
    setLoginMode(mode);
    const storedToken = await getStoredToken(mode);
    if (!storedToken || isJwtExpired(storedToken)) {
      await clearStoredToken(mode);
      setToken(null);
      setSessionMode(null);
      setUnlocked(false);
      setCanUseBiometricLogin(false);
      return;
    }

    const { enabled, canUse } = await refreshBiometricState();
    if (enabled && canUse) {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock '+appBrand,
        fallbackLabel: 'Use passcode',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (!result.success) {
        setToken(null);
        setSessionMode(null);
        setUnlocked(false);
        setCanUseBiometricLogin(true);
        return;
      }
    }

    setToken(storedToken);
    setSessionMode(mode);
    setLoginMode(mode);
    setUnlocked(true);
    setCanUseBiometricLogin(Boolean(enabled && canUse));
    registerNotificationsForMode(storedToken, mode);
  }

  function registerNotificationsForMode(nextToken: string, mode: SessionMode) {
    const register = mode === 'client' ? registerForClientNotifications : registerForStaffNotifications;
    register(nextToken).catch(() => undefined);
  }

  useEffect(() => {
    unlockIfPossible()
      .catch((err) => Alert.alert('Unlock failed', err instanceof Error ? err.message : 'Please sign in again.'))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      const wasActive = appStateRef.current === 'active';
      appStateRef.current = nextState;

      if ((nextState === 'background' || nextState === 'inactive') && wasActive) {
        inactiveSinceRef.current = Date.now();
        return;
      }

      if (nextState === 'active' && token && sessionMode) {
        const inactiveMs = inactiveSinceRef.current ? Date.now() - inactiveSinceRef.current : 0;
        inactiveSinceRef.current = null;
        if (biometricEnabled && canUseBiometrics && inactiveMs >= BIOMETRIC_LOCK_GRACE_MS) {
          setUnlocked(false);
          unlockIfPossible(sessionMode).catch(() => undefined);
          return;
        }
        setUnlocked(true);
      }
    });
    return () => sub.remove();
  }, [biometricEnabled, canUseBiometrics, token, unlocked, sessionMode]);

  async function handleSignedIn(nextToken: string, mode: SessionMode) {
    await setStoredToken(nextToken, mode);
    setToken(nextToken);
    setSessionMode(mode);
    setLoginMode(mode);
    setUnlocked(true);
    setVisitedScreens(['home']);
    setActiveScreen('home');
    const { enabled, canUse } = await refreshBiometricState();
    await refreshBiometricLoginAvailability(enabled, canUse, mode);
    registerNotificationsForMode(nextToken, mode);
    if (!enabled && canUse) {
      Alert.alert(
        'Use Face ID?',
        'You can unlock '+appBrand+' faster next time with Face ID or Touch ID.',
        [
          { text: 'Not Now', style: 'cancel' },
          { text: 'Use Face ID', onPress: () => updateBiometricPreference(true) },
        ],
      );
    }
  }

  async function updateBiometricPreference(enabled: boolean) {
    if (enabled) {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      if (!hasHardware || !isEnrolled) {
        setCanUseBiometrics(false);
        Alert.alert('Face ID unavailable', 'Set up Face ID, Touch ID, or a device passcode in iOS Settings first.');
        return;
      }
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Enable Face ID for '+appBrand,
        fallbackLabel: 'Use passcode',
        cancelLabel: 'Cancel',
        disableDeviceFallback: false,
      });
      if (!result.success) return;
    }
    await setBiometricEnabled(enabled);
    setBiometricEnabledState(enabled);
    const nextCanUse = enabled ? true : canUseBiometrics;
    setCanUseBiometrics(nextCanUse);
    await refreshBiometricLoginAvailability(enabled, nextCanUse, sessionMode || loginMode);
  }

  async function handleSignOut() {
    const mode = sessionMode || loginMode;
    if (mode === 'client') await unregisterClientNotifications(token);
    else await unregisterStaffNotifications(token);
    await clearStoredToken(mode);
    setToken(null);
    setSessionMode(null);
    setUnlocked(false);
    setCanUseBiometricLogin(false);
    setVisitedScreens(['home']);
    setActiveScreen('home');
    setLoginMode('client');
  }

  // An expired saved session returns the client to sign-in once, instead of leaving every screen showing errors.
  // Tapping a notification opens the matching screen once the client is signed in.
  useEffect(() => {
    if (sessionMode !== 'client' || !unlocked) return;
    const route = (data: Record<string, unknown> | undefined) => {
      if (!data) return;
      const deliveryId = Number(data.deliveryId);
      if (data.type === 'tax_delivery' && deliveryId) openReturn(deliveryId);
      else if (data.type === 'message') openClientScreen('messages');
      else if (data.type === 'document') openClientScreen('documents');
    };
    Notifications.getLastNotificationResponseAsync()
      .then(res => { if (res) { route(res.notification.request.content.data as Record<string, unknown>); Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined); } })
      .catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(res => route(res.notification.request.content.data as Record<string, unknown>));
    return () => sub.remove();
  }, [sessionMode, unlocked]);

  const expiringTokenRef = useRef<string | null>(null);
  useEffect(() => {
    setUnauthorizedHandler((expiredToken) => {
      if (!token || expiredToken !== token || expiringTokenRef.current === token) return;
      expiringTokenRef.current = token;
      handleSignOut()
        .then(() => Alert.alert('Please sign in again', 'Your secure session expired.'))
        .catch(() => undefined);
    });
    return () => setUnauthorizedHandler(null);
  }, [token, sessionMode]);

  function renderLogin() {
    if (loginMode === 'staff') {
      return <StaffLoginScreen onBackClientLogin={() => setLoginMode('client')} onSignedIn={(nextToken) => handleSignedIn(nextToken, 'staff')} />;
    }
    return <LoginScreen canUseBiometricLogin={canUseBiometricLogin} onBiometricLogin={() => unlockIfPossible('client')} onOpenStaffLogin={() => setLoginMode('staff')} onSignedIn={(nextToken) => handleSignedIn(nextToken, 'client')} />;
  }

  function renderAuthedApp() {
    if (!token || !unlocked || !sessionMode) return renderLogin();
    if (sessionMode === 'staff') {
      return <StaffShell key={token} token={token} biometricEnabled={biometricEnabled} canUseBiometrics={canUseBiometrics} onToggleBiometrics={updateBiometricPreference} onSignOut={handleSignOut} />;
    }
    return <View key={token} style={{ flex: 1 }}>
      <WebSheet
        url={organizerYear ? `${apiBaseUrl()}/organizer.html?year=${encodeURIComponent(organizerYear)}` : null}
        title={`${organizerYear || ''} tax organizer`}
        portalToken={token}
        onNavigate={(url) => {
          // The organizer's "Back to portal" link returns to the app instead of the desktop portal.
          if (/\/portal(\?|#|$)/.test(url.replace(/^https?:\/\/[^/]+/, ''))) { setOrganizerYear(null); setHomeRefreshKey(k => k + 1); return false; }
          return true;
        }}
        onClose={() => { setOrganizerYear(null); setHomeRefreshKey(k => k + 1); }}
      />
      <View style={{ flex: 1 }}>
        {visitedScreens.map(screen => <View key={screen} style={{ flex: 1, display: activeScreen === screen ? 'flex' : 'none' }} accessibilityElementsHidden={activeScreen !== screen} importantForAccessibility={activeScreen === screen ? 'auto' : 'no-hide-descendants'}>
          {screen === 'messages' && <MessagesScreen token={token} active={activeScreen === screen} />}
          {screen === 'taxes' && <TaxesScreen token={token} active={activeScreen === screen} requestedDeliveryId={requestedDeliveryId} onRequestHandled={() => setRequestedDeliveryId(null)} onOpenOrganizer={setOrganizerYear} onMessageTeam={() => openClientScreen('messages')} onChanged={() => setHomeRefreshKey(k => k + 1)} />}
          {screen === 'documents' && <DocumentsScreen token={token} active={activeScreen === screen} />}
          {screen === 'home' && <HomeScreen refreshKey={homeRefreshKey} token={token} active={activeScreen === screen} biometricEnabled={biometricEnabled} canUseBiometrics={canUseBiometrics} onToggleBiometrics={updateBiometricPreference} onOpenReturn={openReturn} onOpenOrganizer={setOrganizerYear} onOpenTab={openClientScreen} onCounts={counts => setTabBadges(counts)} onSignOut={handleSignOut} />}
        </View>)}
      </View>
      <TabBar active={activeScreen} onSelect={openClientScreen} badges={tabBadges} />
    </View>;
  }

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ImageBackground source={undefined} style={styles.bg}>
        {booting ? <View style={styles.blank} /> : renderAuthedApp()}
      </ImageBackground>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  bg: { flex: 1, backgroundColor: colors.bg },
  blank: { flex: 1 },
});
