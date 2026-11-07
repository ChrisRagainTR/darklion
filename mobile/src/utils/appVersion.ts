import Constants from 'expo-constants';

type ExpoConfigLike = {
  version?: string;
  ios?: { buildNumber?: string };
};

const expoConfig = Constants.expoConfig as ExpoConfigLike | undefined;
const constants = Constants as typeof Constants & {
  nativeAppVersion?: string;
  nativeBuildVersion?: string;
};

export function appVersionLabel() {
  const version = constants.nativeAppVersion || expoConfig?.version || '1.0.0';
  const build = constants.nativeBuildVersion || expoConfig?.ios?.buildNumber || '';
  return build ? `Version ${version} (${build})` : `Version ${version}`;
}
