import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { apiFetch } from '../api/client';

const DEVICE_ID_KEY = 'darklion.mobileDeviceId';
const PUSH_TOKEN_KEY = 'darklion.expoPushToken';
const CLIENT_REGISTERED_DEVICE_ID_KEY = 'darklion.clientRegisteredMobileDeviceId';
const STAFF_REGISTERED_DEVICE_ID_KEY = 'darklion.staffRegisteredMobileDeviceId';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

function getEasProjectId() {
  const constants = Constants as typeof Constants & { easConfig?: { projectId?: string } };
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return constants.easConfig?.projectId || extra?.eas?.projectId || '';
}

async function getDeviceId() {
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) return existing;
  const next = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, next);
  return next;
}

export async function syncAppBadge(count: number) {
  const nextCount = Math.max(0, Math.floor(Number(count) || 0));
  try {
    await Notifications.setBadgeCountAsync(nextCount);
  } catch {
    // Badge support depends on platform permissions; failure should not block app use.
  }
}

async function registerForNotifications(token: string, endpoint: string, registeredDeviceIdKey: string) {
  if (Platform.OS === 'web' || !Device.isDevice) return { registered: false, reason: 'physical_device_required' };

  const projectId = getEasProjectId();
  if (!projectId) return { registered: false, reason: 'missing_eas_project_id' };

  const currentPermissions = await Notifications.getPermissionsAsync();
  let finalStatus = currentPermissions.status;
  if (currentPermissions.status !== 'granted') {
    const requested = await Notifications.requestPermissionsAsync({
      ios: {
        allowAlert: true,
        allowBadge: true,
        allowSound: true,
      },
    });
    finalStatus = requested.status;
  }

  if (finalStatus !== 'granted') {
    return { registered: false, reason: 'permission_denied' };
  }

  const [deviceId, expoPushToken] = await Promise.all([
    getDeviceId(),
    Notifications.getExpoPushTokenAsync({ projectId }),
  ]);
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, expoPushToken.data);

  const response = await apiFetch<{ device?: { id?: string | number } }>(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      pushToken: expoPushToken.data,
      platform: Platform.OS,
      deviceId,
      appVersion: Constants.nativeAppVersion || Constants.expoConfig?.version || '',
      deviceModel: Device.modelName || '',
      osVersion: Device.osVersion || '',
      metadata: {
        brand: Device.brand || '',
        manufacturer: Device.manufacturer || '',
      },
    }),
  }, token);

  if (response.device?.id !== undefined) {
    await SecureStore.setItemAsync(registeredDeviceIdKey, String(response.device.id));
  }
  return { registered: true };
}

async function unregisterNotifications(token: string | null, endpoint: string, registeredDeviceIdKey: string) {
  const [pushToken, deviceId, registeredDeviceId] = await Promise.all([
    SecureStore.getItemAsync(PUSH_TOKEN_KEY),
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(registeredDeviceIdKey),
  ]);

  await syncAppBadge(0);
  if (!token || (!pushToken && !deviceId && !registeredDeviceId)) return;

  try {
    await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({
        id: registeredDeviceId || undefined,
        pushToken: pushToken || undefined,
        deviceId: deviceId || undefined,
      }),
    }, token);
  } catch {
    // Sign-out must remain reliable even if the cleanup request cannot complete.
  }
}

export async function registerForClientNotifications(token: string) {
  return registerForNotifications(token, '/portal/mobile/devices', CLIENT_REGISTERED_DEVICE_ID_KEY);
}

export async function registerForStaffNotifications(token: string) {
  return registerForNotifications(token, '/api/mobile/devices', STAFF_REGISTERED_DEVICE_ID_KEY);
}

export async function unregisterClientNotifications(token: string | null) {
  return unregisterNotifications(token, '/portal/mobile/logout', CLIENT_REGISTERED_DEVICE_ID_KEY);
}

export async function unregisterStaffNotifications(token: string | null) {
  return unregisterNotifications(token, '/api/mobile/logout', STAFF_REGISTERED_DEVICE_ID_KEY);
}
