import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeBottom } from '../hooks/useSafeBottom';
import { colors } from '../theme/tokens';
import { Icon, type IconName } from './Icon';

export type ClientTab = 'home' | 'taxes' | 'messages' | 'documents';

const TABS: Array<{ key: ClientTab; label: string; icon: IconName }> = [
  { key: 'home', label: 'Home', icon: 'house' },
  { key: 'taxes', label: 'Taxes', icon: 'landmark' },
  { key: 'messages', label: 'Messages', icon: 'message' },
  { key: 'documents', label: 'Documents', icon: 'folder' },
];

type Props = { active: ClientTab; onSelect: (tab: ClientTab) => void; badges?: Partial<Record<ClientTab, number>> };

export function TabBar({ active, onSelect, badges = {} }: Props) {
  const bottom = useSafeBottom();
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(bottom, 8) }]} accessibilityRole="tablist">
      {TABS.map(tab => {
        const on = tab.key === active;
        const badge = badges[tab.key] || 0;
        return (
          <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={badge ? `${tab.label}, ${badge} new` : tab.label} onPress={() => onSelect(tab.key)} style={styles.tab}>
            <View>
              <Icon name={tab.icon} size={24} color={on ? colors.gold2 : colors.muted} />
              {badge > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text></View>}
            </View>
            <Text style={[styles.label, on && styles.on]}>{tab.label}</Text>
            <View style={[styles.indicator, on && styles.indicatorOn]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', backgroundColor: '#0b0d12', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.14)', paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 2, minHeight: 48 },
  label: { fontSize: 11.5, color: colors.muted, fontWeight: '600' },
  on: { color: colors.gold2 },
  indicator: { marginTop: 4, width: 22, height: 2, borderRadius: 1, backgroundColor: 'transparent' },
  indicatorOn: { backgroundColor: colors.gold2 },
  badge: { position: 'absolute', top: -4, right: -12, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: colors.goldBtn, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#15171d', fontSize: 11, fontWeight: '800' },
});
