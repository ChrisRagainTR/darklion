import Constants from 'expo-constants';
import { Dimensions, Platform } from 'react-native';

// Home-indicator inset without adding a native dependency: iPhones with a notch or island
// have a tall status bar and need about 28pt below the tab bar.
export function useSafeBottom() {
  if (Platform.OS !== 'ios') return 8;
  const tall = (Constants.statusBarHeight || 20) > 24 || Dimensions.get('window').height >= 812;
  return tall ? 28 : 8;
}
