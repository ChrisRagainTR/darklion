import Constants from 'expo-constants';
const extra = (Constants.expoConfig?.extra as { appName?: string } | undefined) || {};
// The open-source app is always the brandable public build.
export const isPublicApp = true;
export const appBrand = extra.appName || 'DarkLion';
