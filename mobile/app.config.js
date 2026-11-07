// Brand this app for your firm with environment variables (see mobile/README.md).
const apiBaseUrl = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8080';
const appName = process.env.EXPO_PUBLIC_APP_NAME || 'DarkLion';
const bundleId = process.env.DARKLION_BUNDLE_ID || 'com.example.darklion';
const scheme = process.env.DARKLION_URL_SCHEME || 'darklion';
const easProjectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID || process.env.EAS_PROJECT_ID || '';
const apnsEnvironment = process.env.EXPO_NOTIFICATIONS_APNS_ENV || 'production';
const icon = process.env.DARKLION_APP_ICON || './assets/darklion-icon.png';

module.exports = {
  expo: {
    name: appName,
    slug: process.env.DARKLION_EXPO_SLUG || 'darklion',
    version: '1.0.6',
    // Keep runtimeVersion equal to the native app version and bump both together
    // whenever native code changes. JS-only changes ship with eas update --channel production.
    runtimeVersion: '1.0.6',
    ...(easProjectId ? { updates: { url: 'https://u.expo.dev/' + easProjectId, checkAutomatically: 'ON_LOAD', fallbackToCacheTimeout: 0 } } : {}),
    orientation: 'portrait',
    icon,
    userInterfaceStyle: 'dark',
    newArchEnabled: true,
    splash: { image: icon, resizeMode: 'contain', backgroundColor: '#0f1117' },
    ios: {
      supportsTablet: false,
      bundleIdentifier: bundleId,
      infoPlist: {
        CFBundleDisplayName: appName,
        NSFaceIDUsageDescription: 'Use Face ID or Touch ID to securely unlock your client and staff workspace.',
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      adaptiveIcon: { foregroundImage: icon, backgroundColor: '#0f1117' },
      edgeToEdgeEnabled: true,
      predictiveBackGestureEnabled: false,
      package: bundleId,
      versionCode: 1,
    },
    web: { favicon: './assets/favicon.png' },
    plugins: ['expo-secure-store', ['expo-notifications', { mode: apnsEnvironment }]],
    scheme,
    extra: {
      apiBaseUrl,
      appName,
      ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
    },
  },
};
