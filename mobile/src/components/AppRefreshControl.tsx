import { ActivityIndicator, RefreshControl, RefreshControlProps, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { colors } from '../theme/tokens';

type Props = Partial<Omit<RefreshControlProps, 'onRefresh' | 'refreshing'>> & {
  message?: string;
  onRefresh: () => void;
  refreshing: boolean;
};

const REFRESH_TOP_OFFSET = Math.max(88, Constants.statusBarHeight + 64);

// Extra props pass through because some platforms wrap the scroll view inside the refresh control.
export function AppRefreshControl({ message = 'Checking for updates...', onRefresh, refreshing, ...rest }: Props) {
  return (
    <RefreshControl
      {...rest}
      refreshing={refreshing}
      onRefresh={onRefresh}
      progressViewOffset={REFRESH_TOP_OFFSET}
      tintColor={colors.gold2}
      title={refreshing ? message : 'Pull to refresh'}
      titleColor="rgba(234,237,242,0.82)"
    />
  );
}

export function AppRefreshOverlay({ message = 'Checking for updates...', refreshing }: Pick<Props, 'message' | 'refreshing'>) {
  if (!refreshing) return null;
  return (
    <View pointerEvents="none" style={styles.overlay}>
      <View style={styles.pill}>
        <ActivityIndicator color={colors.gold2} size="small" />
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: Math.max(70, Constants.statusBarHeight + 18),
    left: 0,
    right: 0,
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(15,17,23,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.35)',
  },
  text: {
    color: 'rgba(234,237,242,0.9)',
    fontSize: 13,
    fontWeight: '700',
  },
});
