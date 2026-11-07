import { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon } from '../components/Icon';
import { colors } from '../theme/tokens';
import { type ClientRef, fmtDate, refFromHref, staffApi, type TodayData, type TodayItem } from './staffApi';
import { Dot, Empty, ErrorLine, GroupLabel, IconCircle, Initials, Loading, SmallButton, StaffHeader, st } from './ui';

type Props = { token: string; firstName: string; initials: string; active: boolean; onOpenClient: (ref: ClientRef) => void; onOpenMe: () => void };

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
function plural(n: number, one: string, many: string) { return n + ' ' + (n === 1 ? one : many); }

function sentence(d: TodayData) {
  const parts: string[] = [];
  if (d.counts.readyToEfile) parts.push(plural(d.counts.readyToEfile, 'return is', 'returns are') + ' ready to e-file');
  if (d.counts.changesRequested) parts.push(plural(d.counts.changesRequested, 'client asked', 'clients asked') + ' for changes');
  if (!parts.length && d.counts.waitingOnClients) parts.push(plural(d.counts.waitingOnClients, 'client is', 'clients are') + ' still working on their part');
  return parts.length ? parts.join(' and ') + '.' : 'Nothing needs you right now.';
}

export function StaffTodayScreen({ token, firstName, initials, active, onOpenClient, onOpenMe }: Props) {
  const [data, setData] = useState<TodayData | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (opts: { refreshing?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try { setData(await staffApi.today(token)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load Today.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token]);

  useEffect(() => { if (active) load(); }, [active, load]);
  useEffect(() => {
    const t = setInterval(() => { if (active && AppState.currentState === 'active') load(); }, 60000);
    return () => clearInterval(t);
  }, [active, load]);

  async function act(item: TodayItem, action: 'filed' | 'accepted' | 'remind') {
    const key = action + item.id;
    setBusy(key);
    try {
      if (action === 'remind') {
        const r = await staffApi.remind(token, item.id);
        Alert.alert('Reminder sent', r.emailed ? 'We emailed the people who still need to sign.' : 'A reminder was sent.');
      } else {
        await staffApi.markFiled(token, item.id, action);
      }
      await load();
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : 'Please try again.');
    } finally { setBusy(null); }
  }

  function confirm(item: TodayItem, action: 'filed' | 'accepted') {
    Alert.alert(action === 'filed' ? 'Mark e-filed?' : 'Mark accepted?', item.name + ' · ' + item.taxYear + (action === 'filed' ? '\nThe client will see that their return was filed.' : '\nThe client will see that the IRS accepted their return.'), [
      { text: 'Cancel', style: 'cancel' },
      { text: action === 'filed' ? 'Mark e-filed' : 'Mark accepted', onPress: () => act(item, action) },
    ]);
  }

  function row(item: TodayItem, sub: string, right: React.ReactNode, meta?: string) {
    const ref = refFromHref(item.href, item.name);
    return (
      <Pressable key={String(item.id)} disabled={!ref} onPress={() => ref && onOpenClient(ref)} style={({ pressed }) => [st.row, pressed && st.pressed]}>
        {item.kind === 'business' ? <IconCircle name="building" /> : <Initials name={item.name} />}
        <View style={st.rowBody}>
          <Text style={st.rowTitle} numberOfLines={1}>{item.name}</Text>
          <Text style={st.rowSub} numberOfLines={2}>{sub}</Text>
          {meta ? <View style={s.meta}><Icon name="clock" size={13} color={colors.muted} /><Text style={st.rowMeta}>{meta}</Text></View> : null}
        </View>
        {right}
      </Pressable>
    );
  }

  const c = data?.counts;
  const stats: Array<[string, number | undefined, boolean?]> = c ? [
    ['Organizers out', c.organizersOut], ['Preparing', c.preparing], ['Waiting on clients', c.waitingOnClients],
    ['Ready to e-file', c.readyToEfile, true], ['E-filed', c.filedAwaitingAcceptance], ['Accepted', c.accepted],
  ] : [];
  const nothing = data && !data.readyToEfile.total && !data.changesRequested.total && !data.waitingOnClients.total && !data.filedAwaitingAcceptance.total;
  const days = (n?: number | null) => (n == null ? undefined : n === 0 ? 'Today' : plural(n, 'day', 'days'));

  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 28 }} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
      <StaffHeader initials={initials} onPressMe={onOpenMe} />
      <View style={st.body}>
        <Text style={s.title}>{greeting()}{firstName ? ', ' + firstName : ''}</Text>
        {data ? <Text style={s.sentence}>{sentence(data)}</Text> : null}
        <ErrorLine text={error} onRetry={() => load()} />
        {!data && !error ? <Loading /> : null}
        {data ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.statsScroll} contentContainerStyle={s.stats}>
            <View style={s.stat}><Text style={s.statSeason}>{data.taxYear}</Text><Text style={s.statLabel}>season</Text></View>
            {stats.map(([label, n, gold]) => (
              <View key={label} style={s.stat}>
                <Text style={[s.statN, gold && { color: colors.gold2 }]}>{n ?? 0}</Text>
                <Text style={[s.statLabel, gold && { color: colors.gold2 }]} numberOfLines={2}>{label}</Text>
              </View>
            ))}
          </ScrollView>
        ) : null}

        {data ? <Text style={s.h2}>Needs you</Text> : null}
        {nothing ? <Empty text="Nothing needs you right now. New signatures, change requests, and returns ready to e-file will show up here." /> : null}

        {data && data.readyToEfile.total > 0 ? <GroupLabel title="Ready to e-file" count={data.readyToEfile.total} /> : null}
        {data?.readyToEfile.items.map(item => row(item,
          (item.kind === 'business' ? item.taxYear + ' business return' : item.taxYear + ' Form 1040') + (item.lastSignedAt ? ' · All signed ' + fmtDate(item.lastSignedAt) : ''),
          <SmallButton kind="gold" title="Mark e-filed" busy={busy === 'filed' + item.id} onPress={() => confirm(item, 'filed')} />))}

        {data && data.changesRequested.total > 0 ? <GroupLabel title="Changes requested" count={data.changesRequested.total} tone="warn" /> : null}
        {data?.changesRequested.items.map(item => row(item, item.note || 'Asked for changes', <Icon name="chevron" size={18} color={colors.muted} />, days(item.days)))}

        {data && data.waitingOnClients.total > 0 ? <GroupLabel title="Waiting on clients" count={data.waitingOnClients.total} /> : null}
        {data?.waitingOnClients.items.map(item => row(item, item.detail || 'Waiting on the client',
          item.kind === 'organizer' ? <Icon name="chevron" size={18} color={colors.muted} />
            : item.canRemind ? <SmallButton title="Remind" busy={busy === 'remind' + item.id} onPress={() => act(item, 'remind')} />
            : <Text style={s.reminded}>{item.remindedAt ? 'Reminded\n' + fmtDate(item.remindedAt) : ''}</Text>,
          days(item.days)))}

        {data && data.filedAwaitingAcceptance.total > 0 ? <GroupLabel title="E-filed · waiting on acceptance" count={data.filedAwaitingAcceptance.total} /> : null}
        {data?.filedAwaitingAcceptance.items.map(item => row(item, item.taxYear + (item.kind === 'business' ? ' business return' : ' Form 1040') + (item.filedAt ? ' · E-filed ' + fmtDate(item.filedAt) : ''),
          <SmallButton title="Mark accepted" busy={busy === 'accepted' + item.id} onPress={() => confirm(item, 'accepted')} />))}

        {data && data.counts.acceptedThisWeek > 0 ? (
          <View style={s.accepted}><Dot tone="done" /><Text style={st.rowSub}>{plural(data.counts.acceptedThisWeek, 'return', 'returns')} accepted this week</Text></View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.5, marginTop: 10 },
  sentence: { color: colors.text2, fontSize: 15, lineHeight: 21, marginTop: 4 },
  statsScroll: { marginTop: 16, marginHorizontal: -20 },
  stats: { paddingHorizontal: 20, gap: 0 },
  stat: { width: 92, paddingVertical: 10, paddingRight: 10, marginRight: 10, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: 'rgba(255,255,255,0.14)' },
  statN: { color: colors.text, fontSize: 26, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statSeason: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 4 },
  statLabel: { color: colors.muted, fontSize: 12, marginTop: 2, lineHeight: 15 },
  h2: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 22 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  reminded: { color: colors.muted, fontSize: 12, textAlign: 'right' },
  accepted: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18 },
});

