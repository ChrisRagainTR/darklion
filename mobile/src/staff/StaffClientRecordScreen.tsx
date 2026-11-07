import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon, type IconName } from '../components/Icon';
import { Tracker } from '../components/Tracker';
import { colors } from '../theme/tokens';
import { type ClientRef, fmtDate, money, staffApi, type StaffRecord, type StaffReturn } from './staffApi';
import { Dot, ErrorLine, GroupLabel, IconCircle, Initials, Loading, NavBar, SmallButton, st } from './ui';

type Props = {
  token: string;
  client: ClientRef;
  backLabel: string;
  onBack: () => void;
  onOpenClient: (ref: ClientRef) => void;
  onMessage: (personId: number, name: string) => void;
  onOpenDocuments: (ref: ClientRef) => void;
};

const FILING: Record<string, string> = { mfj: 'Married filing jointly', mfs: 'Married filing separately', single: 'Single', hoh: 'Head of household', qw: 'Qualifying surviving spouse' };
const ENTITY: Record<string, string> = { s_corp: 'S corporation', c_corp: 'C corporation', partnership: 'Partnership', llc: 'LLC', sole_prop: 'Sole proprietor', nonprofit: 'Nonprofit', trust: 'Trust' };
const STAGE_LABEL: Record<StaffReturn['stage'], string> = { waiting: 'Waiting on signatures', changes_requested: 'Changes requested', ready: 'Ready to e-file', filed: 'E-filed', accepted: 'Accepted' };

function formatPhone(raw?: string) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(raw || '');
}

function RoundAction({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [s.action, disabled && { opacity: 0.35 }, pressed && { opacity: 0.7 }]}>
      <View style={s.actionCircle}><Icon name={icon} size={22} color={colors.gold2} /></View>
      <Text style={s.actionLabel}>{label}</Text>
    </Pressable>
  );
}

export function StaffClientRecordScreen({ token, client, backLabel, onBack, onOpenClient, onMessage, onOpenDocuments }: Props) {
  const [rec, setRec] = useState<StaffRecord | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (opts: { refreshing?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try { setRec(await staffApi.record(token, client)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load this client.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token, client.type, client.id]);
  useEffect(() => { load(); }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    try { await fn(); if (done) Alert.alert(done); await load(); }
    catch (e) { Alert.alert('Could not update', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setBusy(null); }
  }
  function confirmFiled(r: StaffReturn, status: 'filed' | 'accepted') {
    Alert.alert(status === 'filed' ? 'Mark e-filed?' : 'Mark accepted?', (rec?.name || '') + ' · ' + r.taxYear, [
      { text: 'Cancel', style: 'cancel' },
      { text: status === 'filed' ? 'Mark e-filed' : 'Mark accepted', onPress: () => run(status + r.id, () => staffApi.markFiled(token, r.id, status)) },
    ]);
  }
  function remind(r: StaffReturn) {
    run('remind' + r.id, () => staffApi.remind(token, r.id), 'Reminder sent to the people who still need to sign.');
  }

  const title = rec?.name || client.name || '';
  const phone = rec?.phone || rec?.owners?.find(o => o.phone)?.phone || '';
  const sub = rec ? (rec.type === 'person'
    ? [FILING[rec.filingStatus || ''] || rec.filingStatus, rec.state].filter(Boolean).join(' · ')
    : [ENTITY[rec.entityType || ''] || 'Company', rec.state].filter(Boolean).join(' · ')) : '';
  const ret = rec?.tax.currentReturn || null;
  const pendingFirst = ret?.signers.filter(x => !x.signedAt).map(x => x.name.split(/\s+/)[0]) || [];

  function trackerNote() {
    if (!rec) return '';
    if (ret) return ret.summary;
    const o = rec.tax.organizer;
    if (o) {
      if (o.status === 'reopened') return 'Asked for more documents';
      if (['submitted', 'closed', 'reviewed'].includes(o.status)) return 'Organizer submitted' + (o.submittedAt ? ' ' + fmtDate(o.submittedAt) : '') + ' · preparing';
      return 'Organizer out' + (o.progress && o.progress.total ? ' · ' + o.progress.resolved + ' of ' + o.progress.total + ' items done' : '');
    }
    return '';
  }

  return (
    <View style={s.root}>
      <NavBar title="" onBack={onBack} backLabel={backLabel} />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
        <View style={st.body}>
          <Text style={s.name}>{title}</Text>
          {!!sub && <Text style={s.sub}>{sub}</Text>}
          <ErrorLine text={error} onRetry={() => load()} />
          {!rec && !error ? <Loading /> : null}
          {rec ? (
            <>
              <View style={s.actions}>
                {rec.type === 'person' ? <RoundAction icon="message" label="Message" onPress={() => onMessage(rec.id, rec.name)} /> : null}
                <RoundAction icon="phone" label="Call" disabled={!phone} onPress={() => Linking.openURL('tel:' + String(phone).replace(/[^\d+]/g, ''))} />
                <RoundAction icon="folder" label="Documents" onPress={() => onOpenDocuments({ type: rec.type, id: rec.id, name: rec.name })} />
              </View>

              <Text style={s.h2}>{rec.tax.taxYear} taxes</Text>
              {rec.tax.tracker ? (
                <View style={{ marginTop: 12 }}><Tracker steps={rec.tax.tracker} note={trackerNote()} warn={ret?.stage === 'changes_requested'} /></View>
              ) : <Text style={s.hint}>{trackerNote() || (rec.type === 'company' ? 'No ' + rec.tax.taxYear + ' return sent yet.' : 'Nothing started for ' + rec.tax.taxYear + ' yet.')}</Text>}

              {ret ? (
                <View style={s.card}>
                  <View style={s.cardHead}>
                    <Text style={s.cardTitle} numberOfLines={2}>{ret.title}</Text>
                    <Text style={[s.stage, ret.stage === 'changes_requested' && { color: colors.amber }, ret.stage === 'ready' && { color: colors.gold2 }]}>{STAGE_LABEL[ret.stage]}</Text>
                  </View>
                  {ret.sentAt ? <Text style={s.hint}>Sent {fmtDate(ret.sentAt)}</Text> : null}
                  {ret.figures.map(f => (
                    <View key={f.label} style={s.figure}>
                      <Text style={s.figureLabel}>{f.label} {f.isRefund ? 'refund' : 'balance due'}</Text>
                      <Text style={[s.figureValue, f.isRefund && { color: colors.green }]}>{money(f.amount)}</Text>
                    </View>
                  ))}
                  {ret.changeNote ? <View style={s.quote}><Text style={s.quoteText}>{ret.changeNote}</Text></View> : null}
                  <GroupLabel title="Signers" />
                  {ret.signers.map(sg => (
                    <View key={sg.name + sg.role} style={s.signer}>
                      <Dot tone={sg.signedAt ? 'done' : 'wait'} />
                      <Text style={s.signerName}>{sg.name}</Text>
                      <Text style={s.signerState}>{sg.signedAt ? 'Signed ' + fmtDate(sg.signedAt) : sg.approvedAt ? 'Approved, not signed' : 'Not signed'}</Text>
                    </View>
                  ))}
                  <View style={s.cardActions}>
                    {ret.stage === 'ready' ? <SmallButton kind="gold" title="Mark e-filed" busy={busy === 'filed' + ret.id} onPress={() => confirmFiled(ret, 'filed')} /> : null}
                    {ret.stage === 'filed' ? <SmallButton title="Mark accepted" busy={busy === 'accepted' + ret.id} onPress={() => confirmFiled(ret, 'accepted')} /> : null}
                    {ret.stage === 'waiting' && ret.canRemind ? <SmallButton title={pendingFirst.length === 1 ? 'Remind ' + pendingFirst[0] : 'Send reminder'} busy={busy === 'remind' + ret.id} onPress={() => remind(ret)} /> : null}
                    {ret.stage === 'waiting' && !ret.canRemind && ret.remindedAt ? <Text style={s.hint}>Reminded {fmtDate(ret.remindedAt)}</Text> : null}
                  </View>
                </View>
              ) : null}

              {rec.tax.pastReturns.length ? (
                <>
                  <GroupLabel title="Earlier returns" />
                  {rec.tax.pastReturns.map(r => (
                    <View key={r.id} style={st.row}>
                      <View style={st.rowBody}><Text style={s.pastTitle}>{r.title}</Text><Text style={st.rowMeta}>{r.summary}</Text></View>
                      {r.stage === 'ready' ? <SmallButton kind="gold" title="Mark e-filed" busy={busy === 'filed' + r.id} onPress={() => confirmFiled(r, 'filed')} /> : null}
                      {r.stage === 'filed' ? <SmallButton title="Mark accepted" busy={busy === 'accepted' + r.id} onPress={() => confirmFiled(r, 'accepted')} /> : null}
                    </View>
                  ))}
                </>
              ) : null}

              {rec.type === 'person' ? (
                <>
                  <GroupLabel title="Contact" />
                  {rec.email ? <ContactRow icon="mail" label={rec.email} onPress={() => Linking.openURL('mailto:' + rec.email)} /> : null}
                  {rec.phone ? <ContactRow icon="phone" label={formatPhone(rec.phone)} onPress={() => Linking.openURL('tel:' + rec.phone!.replace(/[^\d+]/g, ''))} /> : null}
                  {rec.spouseName ? <ContactRow icon="user" label={rec.spouseName + (rec.spouseEmail ? ' · ' + rec.spouseEmail : '')} onPress={rec.spousePhone ? () => Linking.openURL('tel:' + rec.spousePhone!.replace(/[^\d+]/g, '')) : undefined} /> : null}
                  {rec.companies?.length ? <GroupLabel title="Businesses" /> : null}
                  {rec.companies?.map(co => (
                    <Pressable key={co.id} onPress={() => onOpenClient({ type: 'company', id: co.id, name: co.name })} style={({ pressed }) => [st.row, pressed && st.pressed]}>
                      <IconCircle name="building" size={36} />
                      <View style={st.rowBody}><Text style={st.rowTitle}>{co.name}</Text><Text style={st.rowMeta}>{ENTITY[co.entityType] || 'Company'}</Text></View>
                      <Icon name="chevron" size={16} color={colors.muted} />
                    </Pressable>
                  ))}
                </>
              ) : (
                <>
                  {rec.owners?.length ? <GroupLabel title="People" /> : null}
                  {rec.owners?.map(o => (
                    <Pressable key={o.id} onPress={() => onOpenClient({ type: 'person', id: o.id, name: o.name })} style={({ pressed }) => [st.row, pressed && st.pressed]}>
                      <Initials name={o.name} size={36} />
                      <View style={st.rowBody}><Text style={st.rowTitle}>{o.name}</Text>{o.email ? <Text style={st.rowMeta}>{o.email}</Text> : null}</View>
                      <Icon name="chevron" size={16} color={colors.muted} />
                    </Pressable>
                  ))}
                </>
              )}
              {rec.relationship ? <Text style={[s.hint, { marginTop: 18 }]}>Household: {rec.relationship.name}</Text> : null}
            </>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function ContactRow({ icon, label, onPress }: { icon: IconName; label: string; onPress?: () => void }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={({ pressed }) => [st.row, pressed && st.pressed]}>
      <Icon name={icon} size={18} color={colors.muted} />
      <Text style={[st.rowSub, { flex: 1 }, onPress && { color: colors.text }]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  name: { color: colors.text, fontSize: 27, fontWeight: '700', letterSpacing: -0.5, marginTop: 14 },
  sub: { color: colors.text2, fontSize: 15, marginTop: 3 },
  actions: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 18, paddingBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  action: { alignItems: 'center', gap: 6, minWidth: 80 },
  actionCircle: { width: 50, height: 50, borderRadius: 25, borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)', alignItems: 'center', justifyContent: 'center' },
  actionLabel: { color: colors.text2, fontSize: 13 },
  h2: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 20 },
  hint: { color: colors.muted, fontSize: 13.5, lineHeight: 19, marginTop: 6 },
  card: { marginTop: 18, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', borderRadius: 14, padding: 14, backgroundColor: 'rgba(255,255,255,0.025)' },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '600', flex: 1 },
  stage: { color: colors.text2, fontSize: 13, fontWeight: '600', marginTop: 2 },
  figure: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 },
  figureLabel: { color: colors.text2, fontSize: 15 },
  figureValue: { color: colors.text, fontSize: 22, fontWeight: '700', fontVariant: ['tabular-nums'] },
  quote: { borderLeftWidth: 3, borderLeftColor: colors.amber, paddingLeft: 12, marginTop: 12 },
  quoteText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  signer: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.1)' },
  signerName: { color: colors.text, fontSize: 15, flex: 1 },
  signerState: { color: colors.muted, fontSize: 13 },
  cardActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginTop: 14 },
  pastTitle: { color: colors.text, fontSize: 15 },
});
