import { useEffect, useRef, useState } from 'react';
import { AppState, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon } from '../components/Icon';
import { Tracker } from '../components/Tracker';
import { Button, ListRow, Notice, Section, text } from '../components/ui';
import { useRefreshOnReturn } from '../hooks/useRefreshOnReturn';
import { colors } from '../theme/tokens';
import type { ClientReturn, ClientTaxStatus } from '../types/api';
import { figuresLine, filedPhrase, fmtDate, fmtDue, returnStatusText, returnTracker, trackerNote } from '../utils/taxText';
import { ReturnFlow } from './ReturnFlow';

type Props = {
  active?: boolean;
  token: string;
  requestedDeliveryId: number | null;
  onRequestHandled: () => void;
  onOpenOrganizer: (year: string) => void;
  onMessageTeam: () => void;
  onChanged: () => void;
};

export function TaxesScreen({ active = true, token, requestedDeliveryId, onRequestHandled, onOpenOrganizer, onMessageTeam, onChanged }: Props) {
  const [status, setStatus] = useState<ClientTaxStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const loading = useRef(false);

  async function load(opts: { refreshing?: boolean } = {}) {
    if (loading.current) return;
    loading.current = true;
    if (opts.refreshing) setRefreshing(true);
    try {
      const next = await apiFetch<ClientTaxStatus>('/portal/tax-status', {}, token);
      if (next && Array.isArray(next.actions)) setStatus(next);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Your tax status could not load.');
    } finally {
      loading.current = false;
      if (opts.refreshing) setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);
  useRefreshOnReturn(active, () => { if (!openId) load(); });
  useEffect(() => {
    if (!active || openId) return;
    const sub = AppState.addEventListener('change', st => { if (st === 'active') load(); });
    return () => sub.remove();
  }, [active, openId]);
  useEffect(() => {
    if (requestedDeliveryId) { setOpenId(requestedDeliveryId); onRequestHandled(); }
  }, [requestedDeliveryId]);

  if (openId) {
    return <ReturnFlow token={token} deliveryId={openId} onClose={() => { setOpenId(null); load(); }} onChanged={() => { load(); onChanged(); }} onMessageTeam={onMessageTeam} />;
  }

  const s = status;
  const returns = s ? ([s.personalReturn, ...s.businessReturns].filter(Boolean) as ClientReturn[]) : [];

  function returnBlock(r: ClientReturn) {
    const acting = r.stage === 'review' || r.stage === 'sign';
    const figures = figuresLine(r);
    return (
      <View key={r.id} style={styles.block}>
        <View style={styles.blockHead}>
          <Icon name={r.kind === 'business' ? 'building' : 'file'} size={20} color={colors.gold2} />
          <Text style={styles.blockTitle}>{r.kind === 'business' ? r.companyName : 'Personal tax return'}</Text>
        </View>
        <View style={{ marginTop: 14 }}><Tracker steps={returnTracker(r)} /></View>
        <Text style={styles.status}>{returnStatusText(r)}</Text>
        {figures ? <Text style={text.hint}>{figures}</Text> : null}
        <Button kind={acting ? 'gold' : 'outline'} title={acting ? (r.stage === 'sign' ? 'Sign now' : 'Review & sign') : 'View return'} onPress={() => setOpenId(r.id)} style={{ marginTop: 14 }} />
      </View>
    );
  }

  function organizerBlock() {
    const o = s?.organizer;
    if (!s || !o) return null;
    let line = 'Not started', label = 'Start organizer', kind: 'gold' | 'outline' = 'gold';
    if (s.stage === 'organizer_in_progress') { line = o.progress.resolved + ' of ' + o.progress.total + ' items done'; label = 'Continue organizer'; }
    else if (s.stage === 'more_documents') { line = 'Your team asked for ' + (o.requestedItems.length || 'more') + ' more document' + (o.requestedItems.length === 1 ? '' : 's'); label = 'Upload documents'; }
    else if (o.submittedAt || ['submitted', 'closed', 'reviewed'].includes(o.status)) { line = 'Submitted' + (o.submittedAt ? ' ' + fmtDate(o.submittedAt, true) : ''); label = 'View organizer'; kind = 'outline'; }
    return (
      <View style={styles.block}>
        <View style={styles.blockHead}><Icon name="clipboard" size={20} color={colors.gold2} /><Text style={styles.blockTitle}>{s.taxYear} tax organizer</Text></View>
        {!s.personalReturn && s.tracker ? <View style={{ marginTop: 14 }}><Tracker steps={s.tracker} note={trackerNote(s)} warn={s.stage === 'more_documents'} /></View> : null}
        <Text style={styles.status}>{line}</Text>
        <Button kind={kind} title={label} onPress={() => onOpenOrganizer(s.taxYear)} style={{ marginTop: 14 }} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
      <Text style={text.h1}>Taxes</Text>
      <Text style={[text.lead, { marginTop: 4 }]}>{s ? 'Your ' + s.taxYear + ' returns and organizer.' : ' '}</Text>
      {error ? <Notice text={error} action="Try again" onAction={() => load()} /> : null}
      {s ? (
        <>
          {organizerBlock()}
          {returns.map(returnBlock)}
          {!s.organizer && !returns.length ? (
            <View style={styles.block}>
              <View style={styles.blockHead}><Icon name="circleCheck" size={20} color={colors.gold2} /><Text style={styles.blockTitle}>Nothing in progress for {s.taxYear}</Text></View>
              <Text style={styles.status}>When we start your return, you'll follow its progress here.</Text>
            </View>
          ) : null}
          {s.estimatedPayments.length ? (
            <Section title="Estimated payment reminders">
              {s.estimatedPayments.map(p => <ListRow key={p.jurisdiction + p.dueDate} icon="calendar" title={p.jurisdiction + (p.quarter ? ' · ' + p.quarter + ' quarter' : '') + ' · ' + p.amount} end={fmtDue(p)} />)}
              <Text style={[text.hint, { marginTop: 8 }]}>From your most recent return. Pay federal estimates at irs.gov/payments.</Text>
            </Section>
          ) : null}
          {s.pastReturns.length ? (
            <Section title="Past years">
              {s.pastReturns.map(r => <ListRow key={r.id} title={r.taxYear + ' · ' + (r.kind === 'business' ? r.companyName : 'Personal return')} end={r.acceptedAt ? 'Accepted ' + fmtDate(r.acceptedAt, true) : r.filedAt ? filedPhrase(r, true) : 'Signed'} onPress={() => setOpenId(r.id)} />)}
            </Section>
          ) : null}
        </>
      ) : !error ? <View style={styles.skeleton} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { padding: 20, paddingTop: Math.max(Constants.statusBarHeight || 0, 20) + 16, paddingBottom: 40 },
  block: { paddingVertical: 20, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  blockHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  blockTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '600' },
  status: { color: colors.text2, fontSize: 14.5, lineHeight: 20, marginTop: 12 },
  skeleton: { height: 160, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', marginTop: 20 },
});
