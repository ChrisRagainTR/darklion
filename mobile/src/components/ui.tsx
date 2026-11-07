import type { ReactNode } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { colors, fonts } from '../theme/tokens';
import { Icon, type IconName } from './Icon';

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <View style={s.section}>
      <View style={s.sectionHead}><Text style={s.h2}>{title}</Text>{action}</View>
      {children}
    </View>
  );
}

export function Button({ title, onPress, kind = 'gold', disabled, busy, style }: { title: string; onPress: () => void; kind?: 'gold' | 'outline'; disabled?: boolean; busy?: boolean; style?: ViewStyle }) {
  const off = disabled || busy;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: off, busy }} disabled={off} onPress={onPress}
      style={({ pressed }) => [s.btn, kind === 'gold' ? s.btnGold : s.btnOutline, off && s.btnOff, pressed && !off && s.pressed, style]}>
      {busy ? <ActivityIndicator color={kind === 'gold' ? '#15171d' : colors.gold2} /> : <Text style={[s.btnText, kind === 'outline' && s.btnTextOutline]}>{title}</Text>}
    </Pressable>
  );
}

export function LinkButton({ title, onPress }: { title: string; onPress: () => void }) {
  return <Pressable accessibilityRole="button" onPress={onPress} style={s.link} hitSlop={8}><Text style={s.linkText}>{title}</Text></Pressable>;
}

export function ActionRow({ icon, title, sub, meta, emphasis, onPress, children }: { icon: IconName; title: string; sub?: string; meta?: string; emphasis?: boolean; onPress?: () => void; children?: ReactNode }) {
  const body = (
    <>
      <View style={s.rowTop}>
        <View style={s.rowIcon}><Icon name={icon} size={20} color={colors.gold2} /></View>
        <View style={s.rowBody}>
          <Text style={s.rowTitle}>{title}</Text>
          {!!sub && <Text style={s.rowSub}>{sub}</Text>}
          {!!meta && <Text style={s.rowMeta}>{meta}</Text>}
        </View>
        {onPress && !children ? <Icon name="chevron" size={18} color={colors.muted} /> : null}
      </View>
      {children ? <View style={s.rowChildren}>{children}</View> : null}
    </>
  );
  const style = [s.row, emphasis && s.rowEmph];
  if (onPress && !children) return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [...style, pressed && s.pressedRow]}>{body}</Pressable>;
  return <View style={style}>{body}</View>;
}

export function ListRow({ left, title, end, dot, onPress, icon }: { left?: ReactNode; title: string; end?: string; dot?: 'done' | 'now' | 'wait' | 'idle'; onPress?: () => void; icon?: IconName }) {
  const content = (
    <>
      {dot ? <View style={[s.dot, s[`dot_${dot}`]]} /> : null}
      {icon ? <View style={s.fileIcon}><Icon name={icon} size={18} color={colors.text2} /></View> : null}
      {left}
      <Text style={s.listTitle} numberOfLines={2}>{title}</Text>
      {!!end && <Text style={s.listEnd}>{end}</Text>}
      {onPress ? <Icon name="chevron" size={16} color={colors.muted} /> : null}
    </>
  );
  if (onPress) return <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [s.listRow, pressed && s.pressedRow]}>{content}</Pressable>;
  return <View style={s.listRow}>{content}</View>;
}

export function Quote({ children }: { children: string }) {
  return <View style={s.quote}><Text style={s.quoteText}>{children}</Text></View>;
}

export function Notice({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <View style={s.notice}>
      <Text style={s.noticeText}>{text}</Text>
      {action && onAction ? <LinkButton title={action} onPress={onAction} /> : null}
    </View>
  );
}

export function Avatar({ name, url, size = 48 }: { name: string; url?: string | null; size?: number }) {
  const initials = name.split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase();
  if (url) return <Image source={{ uri: url }} style={{ width: size, height: size, borderRadius: size / 2, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)' }} />;
  return <View style={[s.initials, { width: size, height: size, borderRadius: size / 2 }]}><Text style={[s.initialsText, { fontSize: size * 0.36 }]}>{initials}</Text></View>;
}

export const text = StyleSheet.create({
  h1: { fontFamily: fonts.serif, fontWeight: '700', fontSize: 27, lineHeight: 33, letterSpacing: -0.4, color: colors.text },
  h2: { fontFamily: fonts.serif, fontWeight: '600', fontSize: 20, lineHeight: 25, letterSpacing: -0.2, color: colors.text },
  lead: { color: colors.text2, fontSize: 15.5, lineHeight: 22 },
  hint: { color: colors.muted, fontSize: 13.5, lineHeight: 19 },
  body: { color: colors.text, fontSize: 15.5, lineHeight: 23 },
});

const s = StyleSheet.create({
  section: { marginTop: 26 },
  sectionHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 },
  h2: text.h2,
  btn: { minHeight: 50, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  btnGold: { backgroundColor: colors.goldBtn },
  btnOutline: { borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)' },
  btnOff: { opacity: 0.42 },
  btnText: { color: '#15171d', fontSize: 16, fontWeight: '700' },
  btnTextOutline: { color: colors.gold2 },
  pressed: { opacity: 0.85 },
  link: { minHeight: 36, justifyContent: 'center' },
  linkText: { color: colors.gold2, fontSize: 15, fontWeight: '600' },
  row: { paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  rowEmph: { borderWidth: 1, borderColor: 'rgba(201,168,76,0.32)', borderLeftWidth: 3, borderLeftColor: colors.gold, borderRadius: 12, backgroundColor: 'rgba(201,168,76,0.08)', paddingHorizontal: 14, marginBottom: 10 },
  pressedRow: { backgroundColor: 'rgba(255,255,255,0.03)' },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(201,168,76,0.1)', alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 16, fontWeight: '600', lineHeight: 21 },
  rowSub: { color: colors.text2, fontSize: 14.5, lineHeight: 20 },
  rowMeta: { color: colors.muted, fontSize: 13 },
  rowChildren: { marginTop: 12, gap: 10 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 50, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  listTitle: { flex: 1, color: colors.text, fontSize: 15.5, lineHeight: 21 },
  listEnd: { color: colors.muted, fontSize: 13.5 },
  fileIcon: { width: 34, height: 34, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dot_done: { backgroundColor: colors.green },
  dot_now: { backgroundColor: colors.goldBtn },
  dot_wait: { backgroundColor: colors.amber },
  dot_idle: { backgroundColor: '#5f6878' },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.gold, paddingLeft: 14, paddingVertical: 2, marginVertical: 8 },
  quoteText: { color: colors.text, fontSize: 15.5, lineHeight: 22 },
  notice: { borderLeftWidth: 3, borderLeftColor: colors.amber, backgroundColor: 'rgba(226,176,90,0.08)', borderRadius: 6, padding: 12, gap: 4, marginTop: 12 },
  noticeText: { color: colors.text, fontSize: 14.5, lineHeight: 20 },
  initials: { backgroundColor: 'rgba(201,168,76,0.14)', alignItems: 'center', justifyContent: 'center' },
  initialsText: { color: colors.gold2, fontWeight: '700' },
});
