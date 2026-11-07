import { appBrand } from '../brand';
import type { ReactNode } from 'react';
import { ActivityIndicator, Image, ImageBackground, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Icon, type IconName } from '../components/Icon';
import { useSafeBottom } from '../hooks/useSafeBottom';
import { colors } from '../theme/tokens';
import type { StaffTab } from './staffApi';

export const TOP = Math.max(Constants.statusBarHeight || 0, 20);

// Brand band shown at the top of each tab's main screen.
export function StaffHeader({ initials, onPressMe }: { initials: string; onPressMe?: () => void }) {
  return (
    <ImageBackground source={require('../../assets/header-ridge.jpg')} style={st.header} imageStyle={st.headerImage}>
      <View style={st.headerShade} />
      <View style={st.brand}>
        <Text style={{color:colors.text,fontSize:23,fontWeight:"700"}}>{appBrand}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Your account" onPress={onPressMe} style={st.me} hitSlop={6}>
        <Text style={st.meText}>{initials || '·'}</Text>
      </Pressable>
    </ImageBackground>
  );
}

// Compact iOS-style bar for pushed screens: back, centered title, optional right action.
export function NavBar({ title, subtitle, onBack, backLabel = 'Back', right }: { title: string; subtitle?: string; onBack: () => void; backLabel?: string; right?: ReactNode }) {
  return (
    <View style={st.nav}>
      <Pressable accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={st.navBack} hitSlop={10}>
        <Icon name="back" size={24} color={colors.gold2} />
        <Text style={st.navBackText} numberOfLines={1}>{backLabel}</Text>
      </Pressable>
      <View style={st.navCenter} pointerEvents="none">
        <Text style={st.navTitle} numberOfLines={1}>{title}</Text>
        {!!subtitle && <Text style={st.navSub} numberOfLines={1}>{subtitle}</Text>}
      </View>
      <View style={st.navRight}>{right}</View>
    </View>
  );
}

export function PageTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <View style={st.pageHead}>
      <View style={{ flex: 1 }}>
        <Text style={st.pageTitle} numberOfLines={1}>{title}</Text>
        {!!sub && <Text style={st.pageSub}>{sub}</Text>}
      </View>
      {right}
    </View>
  );
}

export function GroupLabel({ title, count, tone }: { title: string; count?: number; tone?: 'warn' }) {
  return (
    <View style={st.groupLabel}>
      <Text style={[st.groupText, tone === 'warn' && { color: colors.amber }]}>{title.toUpperCase()}</Text>
      {typeof count === 'number' ? <Text style={st.groupCount}>{count}</Text> : null}
    </View>
  );
}

export function Initials({ name, size = 40 }: { name: string; size?: number }) {
  const letters = String(name || '').replace(/&/g, ' ').split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '·';
  return (
    <View style={[st.initials, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text style={[st.initialsText, { fontSize: Math.round(size * 0.36) }]}>{letters}</Text>
    </View>
  );
}

export function IconCircle({ name, size = 40 }: { name: IconName; size?: number }) {
  return <View style={[st.initials, { width: size, height: size, borderRadius: size / 2 }]}><Icon name={name} size={Math.round(size * 0.48)} color={colors.gold2} /></View>;
}

export function Dot({ tone }: { tone: 'wait' | 'warn' | 'gold' | 'done' | 'idle' }) {
  const color = { wait: colors.amber, warn: colors.red, gold: colors.goldBtn, done: colors.green, idle: '#5f6878' }[tone];
  return <View style={[st.dot, { backgroundColor: color }]} />;
}

export function SmallButton({ title, onPress, kind = 'outline', busy, disabled }: { title: string; onPress: () => void; kind?: 'gold' | 'outline'; busy?: boolean; disabled?: boolean }) {
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress} hitSlop={4}
      style={({ pressed }) => [st.small, kind === 'gold' ? st.smallGold : st.smallOutline, off && { opacity: 0.45 }, pressed && { opacity: 0.8 }]}>
      {busy ? <ActivityIndicator size="small" color={kind === 'gold' ? '#15171d' : colors.gold2} /> : <Text style={[st.smallText, kind === 'outline' && { color: colors.gold2 }]}>{title}</Text>}
    </Pressable>
  );
}

export function Chips<T extends string>({ options, value, onChange }: { options: Array<{ key: T; label: string; count?: number }>; value: T; onChange: (k: T) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chips} keyboardShouldPersistTaps="handled">
      {options.map(o => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(o.key)} style={[st.chip, on && st.chipOn]}>
            <Text style={[st.chipText, on && st.chipTextOn]}>{o.label}{typeof o.count === 'number' ? '  ' + o.count : ''}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: Array<{ key: T; label: string }>; value: T; onChange: (k: T) => void }) {
  return (
    <View style={st.seg}>
      {options.map(o => {
        const on = o.key === value;
        return <Pressable key={o.key} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => onChange(o.key)} style={[st.segItem, on && st.segOn]}><Text style={[st.segText, on && st.segTextOn]}>{o.label}</Text></Pressable>;
      })}
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  return <View style={st.loading}><ActivityIndicator color={colors.gold2} />{label ? <Text style={st.muted}>{label}</Text> : null}</View>;
}

export function ErrorLine({ text, onRetry }: { text: string; onRetry?: () => void }) {
  if (!text) return null;
  return (
    <View style={st.error}>
      <Text style={st.errorText}>{text}</Text>
      {onRetry ? <Pressable onPress={onRetry} hitSlop={8}><Text style={st.retry}>Try again</Text></Pressable> : null}
    </View>
  );
}

export function Empty({ text }: { text: string }) {
  return <Text style={st.empty}>{text}</Text>;
}

const TABS: Array<{ key: StaffTab; label: string; icon: IconName }> = [
  { key: 'today', label: 'Today', icon: 'house' },
  { key: 'clients', label: 'Clients', icon: 'user' },
  { key: 'inbox', label: 'Inbox', icon: 'message' },
  { key: 'team', label: 'Team', icon: 'users' },
  { key: 'more', label: 'More', icon: 'more' },
];

export function StaffTabBar({ active, onSelect, badges }: { active: StaffTab; onSelect: (t: StaffTab) => void; badges: Partial<Record<StaffTab, number>> }) {
  const bottom = useSafeBottom();
  return (
    <View style={[st.bar, { paddingBottom: Math.max(bottom, 8) }]} accessibilityRole="tablist">
      {TABS.map(tab => {
        const on = tab.key === active;
        const badge = badges[tab.key] || 0;
        return (
          <Pressable key={tab.key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={badge ? tab.label + ', ' + badge + ' unread' : tab.label} onPress={() => onSelect(tab.key)} style={st.tab}>
            <View>
              <Icon name={tab.icon} size={24} color={on ? colors.gold2 : colors.muted} />
              {badge > 0 && <View style={st.badge}><Text style={st.badgeText}>{badge > 9 ? '9+' : badge}</Text></View>}
            </View>
            <Text style={[st.tabLabel, on && { color: colors.gold2 }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export const st = StyleSheet.create({
  header: { height: TOP + 56, paddingTop: TOP + 4, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  headerImage: { resizeMode: 'cover' },
  headerShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15,17,23,0.2)' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { width: 32, height: 32 },
  wordmark: { width: 88, height: 22 },
  me: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,17,23,0.55)' },
  meText: { color: colors.gold2, fontSize: 14, fontWeight: '700' },
  nav: { paddingTop: TOP + 2, height: TOP + 50, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)', backgroundColor: colors.bg },
  navBack: { flexDirection: 'row', alignItems: 'center', minWidth: 90, maxWidth: 120, height: 44 },
  navBackText: { color: colors.gold2, fontSize: 16, marginLeft: -2 },
  navCenter: { position: 'absolute', left: 110, right: 110, top: TOP + 2, height: 48, alignItems: 'center', justifyContent: 'center' },
  navTitle: { color: colors.text, fontSize: 16.5, fontWeight: '600' },
  navSub: { color: colors.muted, fontSize: 12, marginTop: 1 },
  navRight: { flex: 1, alignItems: 'flex-end', paddingRight: 8 },
  pageHead: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  pageTitle: { color: colors.text, fontSize: 30, fontWeight: '700', letterSpacing: -0.6 },
  pageSub: { color: colors.text2, fontSize: 15, marginTop: 4, lineHeight: 21 },
  groupLabel: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  groupText: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.1 },
  groupCount: { color: colors.gold2, fontSize: 12, fontWeight: '700' },
  initials: { backgroundColor: 'rgba(201,168,76,0.14)', alignItems: 'center', justifyContent: 'center' },
  initialsText: { color: colors.gold2, fontWeight: '700' },
  dot: { width: 9, height: 9, borderRadius: 5 },
  small: { minHeight: 36, borderRadius: 10, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  smallGold: { backgroundColor: colors.goldBtn },
  smallOutline: { borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)' },
  smallText: { color: '#15171d', fontSize: 14, fontWeight: '700' },
  chips: { gap: 8, paddingVertical: 2 },
  chip: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', borderRadius: 18, paddingHorizontal: 13, height: 34, justifyContent: 'center' },
  chipOn: { backgroundColor: colors.goldBtn, borderColor: colors.goldBtn },
  chipText: { color: colors.text2, fontSize: 13.5, fontWeight: '600' },
  chipTextOn: { color: '#15171d' },
  seg: { flexDirection: 'row', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 10, padding: 3 },
  segItem: { flex: 1, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.goldBtn },
  segText: { color: colors.text2, fontSize: 14, fontWeight: '600' },
  segTextOn: { color: '#15171d' },
  loading: { paddingVertical: 40, alignItems: 'center', gap: 10 },
  muted: { color: colors.muted, fontSize: 14 },
  error: { marginTop: 12, borderLeftWidth: 3, borderLeftColor: colors.red, backgroundColor: 'rgba(255,107,107,0.08)', borderRadius: 6, padding: 12, gap: 6 },
  errorText: { color: colors.text, fontSize: 14, lineHeight: 20 },
  retry: { color: colors.gold2, fontSize: 14, fontWeight: '600' },
  empty: { color: colors.muted, fontSize: 14.5, paddingVertical: 18, lineHeight: 20 },
  bar: { flexDirection: 'row', backgroundColor: '#0b0d12', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.14)', paddingTop: 8 },
  tab: { flex: 1, alignItems: 'center', gap: 3, minHeight: 48 },
  tabLabel: { fontSize: 11, color: colors.muted, fontWeight: '600' },
  badge: { position: 'absolute', top: -4, right: -12, minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: colors.goldBtn, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#15171d', fontSize: 11, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  rowSub: { color: colors.text2, fontSize: 14, lineHeight: 19 },
  rowMeta: { color: colors.muted, fontSize: 12.5 },
  pressed: { backgroundColor: 'rgba(255,255,255,0.04)' },
  body: { paddingHorizontal: 20 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 42, borderRadius: 11, borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', backgroundColor: 'rgba(255,255,255,0.04)', paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.text, fontSize: 15.5, paddingVertical: 0 },
});

