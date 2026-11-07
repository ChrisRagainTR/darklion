import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AppState, Image, ImageBackground, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { appBrand } from '../brand';
import { AccountSecurityScreen } from './AccountSecurityScreen';
import { apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon } from '../components/Icon';
import { Tracker } from '../components/Tracker';
import { ActionRow, Avatar, Button, LinkButton, ListRow, Notice, Quote, Section, text } from '../components/ui';
import { useRefreshOnReturn } from '../hooks/useRefreshOnReturn';
import { registerForClientNotifications, syncAppBadge } from '../notifications/clientNotifications';
import { colors, fonts } from '../theme/tokens';
import type { ClientReturn, ClientTaxStatus, FirmTeamMember, MessageContact, MobileDashboard } from '../types/api';
import { appVersionLabel } from '../utils/appVersion';
import { figuresLine, firstName as first, fmtDate, fmtDue, greeting, homeSentence, joinNames, trackerNote } from '../utils/taxText';

type Props = {
  active?: boolean;
  token: string;
  onOpenReturn: (deliveryId: number) => void;
  onOpenOrganizer: (year: string) => void;
  onOpenTab: (tab: 'taxes' | 'messages' | 'documents') => void;
  onCounts: (counts: { taxes: number; messages: number; documents: number }) => void;
  refreshKey?: number;
  biometricEnabled: boolean;
  canUseBiometrics: boolean;
  onToggleBiometrics: (enabled: boolean) => Promise<void>;
  onSignOut: () => Promise<void>;
};

type RecentDoc = { id: number; display_name?: string; created_at?: string };
type Dashboard = MobileDashboard & { recentActivity?: RecentDoc[] };

export function HomeScreen({ active = true, token, onOpenReturn, onOpenOrganizer, onOpenTab, onCounts, refreshKey = 0, biometricEnabled, canUseBiometrics, onToggleBiometrics, onSignOut }: Props) {
  const [status, setStatus] = useState<ClientTaxStatus | null>(null);
  const [contacts, setContacts] = useState<MessageContact[]>([]);
  const [team, setTeam] = useState<FirmTeamMember[]>([]);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [securityOpen,setSecurityOpen]=useState(false);
  const loadingRef = useRef(false);
  const latest = useRef<{ status: ClientTaxStatus | null; contacts: MessageContact[]; dashboard: Dashboard | null }>({ status: null, contacts: [], dashboard: null });

  // Each section loads on its own; a failure keeps the last good copy and says which part is stale.
  async function load(opts: { refreshing?: boolean } = {}) {
    if (loadingRef.current) return;
    loadingRef.current = true;
    if (opts.refreshing) setRefreshing(true);
    const miss: string[] = [];
    const keep = (label: string) => (err: unknown) => {
      if ((err as { status?: number })?.status === 401) throw err;
      if (label) miss.push(label);
      return null;
    };
    try {
      const [tax, msgs, firm, dash] = await Promise.all([
        apiFetch<ClientTaxStatus>('/portal/tax-status', {}, token).catch(keep('your tax status')),
        apiFetch<MessageContact[]>('/portal/messages', {}, token).catch(keep('messages')),
        apiFetch<FirmTeamMember[]>('/portal/firm-team', {}, token).catch(keep('')),
        apiFetch<Dashboard>('/portal/mobile/dashboard', {}, token).catch(keep('documents')),
      ]);
      if (tax && Array.isArray(tax.actions)) { setStatus(tax); latest.current.status = tax; }
      if (msgs) { const list = Array.isArray(msgs) ? msgs : []; setContacts(list); latest.current.contacts = list; }
      if (firm) setTeam(Array.isArray(firm) ? firm : []);
      if (dash) { setDashboard(dash); latest.current.dashboard = dash; }
      setFailed(miss);
      const cur = latest.current;
      const unread = cur.contacts.reduce((n, c) => n + (Number(c.unreadCount) || 0), 0);
      const taxActions = cur.status?.actions.length || 0;
      const docs = cur.dashboard?.counts?.unviewedDocuments || 0;
      onCounts({ taxes: taxActions, messages: unread, documents: docs });
      syncAppBadge(unread + taxActions + docs).catch(() => undefined);
    } catch {
      // An expired session is handled by the app-wide sign-out.
    } finally {
      loadingRef.current = false;
      setLoaded(true);
      if (opts.refreshing) setRefreshing(false);
    }
  }

  useEffect(() => { load(); }, []);
  useEffect(() => { if (refreshKey) load(); }, [refreshKey]);
  useRefreshOnReturn(active, () => { load(); });
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => { if (AppState.currentState === 'active' && !settingsOpen) load(); }, 25000);
    const sub = AppState.addEventListener('change', st => { if (st === 'active') load(); });
    return () => { clearInterval(interval); sub.remove(); };
  }, [active, settingsOpen, token]);

  const s = status;
  const r = s?.personalReturn || null;
  const displayName = s?.firstName || dashboard?.profile?.firstName || '';
  const unread = contacts.filter(c => Number(c.unreadCount) > 0);
  const recent = (dashboard?.recentActivity || []).slice(0, 3);
  const warn = s ? ['more_documents', 'changes_requested'].includes(s.stage) : false;

  function attention() {
    const items: ReactElement[] = [];
    if (s) {
      const returns = [s.personalReturn, ...s.businessReturns].filter(Boolean) as ClientReturn[];
      for (const a of s.actions) {
        if (a.type === 'tax_return') {
          const ret = returns.find(x => x.id === a.deliveryId);
          if (!ret) continue;
          items.push(
            <ActionRow key={'r' + ret.id} icon="signature" emphasis
              title={ret.kind === 'business' ? 'Review and sign the ' + ret.taxYear + ' return for ' + ret.companyName : 'Review and sign your ' + ret.taxYear + ' return'}
              sub={figuresLine(ret) || undefined} meta={ret.dueText ? 'Due ' + ret.dueText : undefined}>
              <Button title={a.stage === 'sign' ? 'Sign now' : 'Review & sign'} onPress={() => onOpenReturn(ret.id)} />
            </ActionRow>,
          );
        } else if (a.type === 'organizer' && s.organizer) {
          const started = a.stage === 'organizer_in_progress';
          const o = s.organizer;
          items.push(
            <ActionRow key="org" icon="clipboard" emphasis title={(started ? 'Finish' : 'Complete') + ' your ' + s.taxYear + ' tax organizer'}
              sub={started ? o.progress.resolved + ' of ' + o.progress.total + ' items done. Your answers save as you go.' : o.progress.total + ' documents based on last year. You can save and come back.'}>
              <Button title={started ? 'Continue organizer' : 'Start organizer'} onPress={() => onOpenOrganizer(s.taxYear)} />
            </ActionRow>,
          );
        } else if (a.type === 'organizer_requests' && s.organizer) {
          const o = s.organizer;
          items.push(
            <View key="req" style={styles.request}>
              <View style={styles.requestHead}><Icon name="message" size={18} color={colors.amber} /><Text style={styles.requestTitle}>Your team asked for more documents</Text></View>
              {!!o.reopenNote && <Quote>{o.reopenNote}</Quote>}
              {o.requestedItems.map(i => <ListRow key={i.id} icon="file" title={i.name} />)}
              <Button title="Upload documents" onPress={() => onOpenOrganizer(s.taxYear)} style={{ marginTop: 12 }} />
              <LinkButton title="Reply to your team" onPress={() => onOpenTab('messages')} />
            </View>,
          );
        }
      }
    }
    if (unread.length) {
      const total = unread.reduce((n, c) => n + Number(c.unreadCount), 0);
      items.push(<ActionRow key="msg" icon="message" onPress={() => onOpenTab('messages')}
        title={total === 1 ? 'New message from ' + unread[0].name : total + ' new messages from ' + joinNames(unread.map(c => first(c.name)))}
        sub={unread[0].lastPreview || undefined} />);
    }
    const newDocs = dashboard?.counts?.unviewedDocuments || 0;
    if (newDocs) items.push(<ActionRow key="docs" icon="file" onPress={() => onOpenTab('documents')} title={newDocs === 1 ? 'A new document is ready' : newDocs + ' new documents are ready'} />);
    return items;
  }
  const items = attention();

  return (
    <>
      <Modal visible={securityOpen} onRequestClose={()=>setSecurityOpen(false)}><AccountSecurityScreen token={token} mode="client" onClose={()=>setSecurityOpen(false)} onSignOut={()=>{setSecurityOpen(false);void onSignOut();}}/></Modal>
      <SettingsSheet onSecurity={()=>{setSettingsOpen(false);setSecurityOpen(true);}} open={settingsOpen} onClose={() => setSettingsOpen(false)} token={token} biometricEnabled={biometricEnabled} canUseBiometrics={canUseBiometrics} onToggleBiometrics={onToggleBiometrics} onSignOut={onSignOut} />
      <ScrollView style={styles.root} contentContainerStyle={styles.content} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
        <ImageBackground source={require('../../assets/header-ridge.jpg')} style={styles.header} imageStyle={styles.headerImage}>
          <View style={styles.headerShade} />
          <View style={styles.brand}>
            <Image source={require('../../assets/darklion-icon.png')} style={styles.logo} resizeMode="contain" />
            <Text style={{color:colors.text,fontSize:24,fontWeight:"700"}}>{appBrand}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Settings and sign out" onPress={() => setSettingsOpen(true)} style={styles.me}>
            <Icon name="settings" size={20} color={colors.gold2} />
          </Pressable>
        </ImageBackground>

        <View style={styles.body}>
          <Text style={text.h1}>{greeting()}{displayName ? ', ' + displayName : ''}</Text>
          {s ? <Text style={[text.lead, styles.sentence]}>{homeSentence(s)}</Text> : null}
          {s?.tracker ? <View style={styles.tracker}><Tracker steps={s.tracker} note={trackerNote(s)} warn={warn} /></View> : null}
          {s && !s.tracker && s.lastFiledReturn?.acceptedAt ? <Text style={[text.hint, styles.tracker]}>Your {s.lastFiledReturn.taxYear} return was accepted {fmtDate(s.lastFiledReturn.acceptedAt, true)}.</Text> : null}
          {failed.length ? <Notice text={"Some information didn't load (" + failed.join(', ') + '). The rest is up to date.'} action="Try again" onAction={() => load()} /> : null}

          <Section title="Needs your attention">
            {!loaded ? <View style={styles.skeleton} /> : items.length ? items : (
              <ActionRow icon="check" title="Nothing to do right now" sub="We'll let you know here, by email, and with a notification when something needs you." />
            )}
          </Section>

          {r && ['review', 'sign', 'signed_waiting', 'with_other_signers'].includes(r.stage) && r.signers.length > 0 ? (
            <Section title="Who needs to sign">
              {r.signers.map(sg => <ListRow key={sg.name + sg.role} dot={sg.signedAt ? 'done' : sg.approvedAt ? 'wait' : 'idle'} title={sg.name + (sg.isMe ? ' (you)' : '')} end={sg.signedAt ? 'Signed ' + fmtDate(sg.signedAt) : 'Not signed yet'} />)}
              {r.signers.length > 1 ? <Text style={[text.hint, { marginTop: 8 }]}>Each of you signs from your own login.</Text> : null}
            </Section>
          ) : null}

          {r?.stage === 'changes_requested' && r.changeRequest ? (
            <Section title="Your change request">
              <Text style={text.hint}>{(r.changeRequest.by || 'You') + (r.changeRequest.at ? ' · ' + fmtDate(r.changeRequest.at) : '')}</Text>
              <Quote>{r.changeRequest.note}</Quote>
              <LinkButton title="Message your team" onPress={() => onOpenTab('messages')} />
            </Section>
          ) : null}

          {s && (s.stage === 'preparing' || s.stage === 'more_documents') ? (
            <Section title={'Your ' + s.taxYear + ' return'}>
              {s.organizer?.submittedAt ? <ListRow dot="done" title="Organizer submitted" end={fmtDate(s.organizer.submittedAt)} /> : null}
              <ListRow dot="now" title="Return in preparation" end="Now" />
            </Section>
          ) : null}

          {s && s.estimatedPayments.length ? (
            <Section title="Coming up">
              {s.estimatedPayments.slice(0, 2).map(p => <ListRow key={p.jurisdiction + p.dueDate} icon="calendar" title={p.jurisdiction + ' estimated payment ' + p.amount} end={fmtDue(p)} />)}
            </Section>
          ) : null}

          {recent.length ? (
            <Section title="Recently added" action={<LinkButton title="All documents" onPress={() => onOpenTab('documents')} />}>
              {recent.map(d => <ListRow key={d.id} icon="file" title={d.display_name || 'Document'} end={fmtDate(d.created_at)} onPress={() => onOpenTab('documents')} />)}
            </Section>
          ) : null}

          {team.length ? (
            <Section title="Your advisory team" action={<LinkButton title="Message" onPress={() => onOpenTab('messages')} />}>
              <View style={styles.team}>
                {team.slice(0, 2).map(m => (
                  <View key={m.id} style={styles.person}>
                    <Avatar name={m.name} url={m.avatar_url} size={48} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.personName} numberOfLines={1}>{m.name.replace(/,\s*[A-Z\/]+$/, '')}</Text>
                      {!!m.credentials && <Text style={styles.personCred} numberOfLines={1}>{m.credentials}</Text>}
                    </View>
                  </View>
                ))}
              </View>
            </Section>
          ) : null}
        </View>
      </ScrollView>
    </>
  );
}

function SettingsSheet({ onSecurity, open, onClose, token, biometricEnabled, canUseBiometrics, onToggleBiometrics, onSignOut }: {
  onSecurity: () => void; open: boolean; onClose: () => void; token: string; biometricEnabled: boolean; canUseBiometrics: boolean;
  onToggleBiometrics: (enabled: boolean) => Promise<void>; onSignOut: () => Promise<void>;
}) {
  const [busyBio, setBusyBio] = useState(false);
  const [busyNote, setBusyNote] = useState(false);
  const [note, setNote] = useState('');
  async function toggleBio(v: boolean) {
    setBusyBio(true);
    try { await onToggleBiometrics(v); } finally { setBusyBio(false); }
  }
  async function enableNotifications() {
    setBusyNote(true); setNote('');
    try {
      const res = await registerForClientNotifications(token);
      setNote(res.registered ? 'Notifications are on.' : 'Turn on notifications for this app in iPhone Settings, then try again.');
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not turn on notifications.');
    } finally { setBusyNote(false); }
  }
  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.sheetHead}>
          <Text style={text.h1}>Settings</Text>
          <LinkButton title="Done" onPress={onClose} />
        </View>
        <View style={styles.sheetRow}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.sheetTitle}>Face ID unlock</Text>
            <Text style={text.hint}>{canUseBiometrics ? 'Ask for Face ID, Touch ID, or your passcode when you reopen the app.' : 'Set up Face ID, Touch ID, or a passcode on this iPhone to use quick unlock.'}</Text>
          </View>
          <Switch disabled={!canUseBiometrics || busyBio} value={biometricEnabled} onValueChange={toggleBio}
            trackColor={{ false: 'rgba(255,255,255,0.16)', true: 'rgba(201,168,76,0.46)' }} thumbColor={biometricEnabled ? colors.gold2 : '#f4f3f4'} />
        </View>
        <View style={styles.sheetRow}>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={styles.sheetTitle}>Notifications</Text>
            <Text style={text.hint}>Messages, documents, and tax return updates on this iPhone.</Text>
            {!!note && <Text style={text.hint}>{note}</Text>}
          </View>
          <Button kind="outline" title="Turn on" busy={busyNote} onPress={enableNotifications} />
        </View>
        <Text style={[text.hint, { marginTop: 18 }]}>Version {appVersionLabel()}</Text>
        <Button kind="outline" title="Account security & data requests" onPress={onSecurity} />
        <Button kind="outline" title="Sign out" onPress={() => { onClose(); onSignOut().catch(() => undefined); }} style={styles.signOut} />
      </View>
    </Modal>
  );
}

const TOP = Math.max(Constants.statusBarHeight || 0, 20);
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: 32 },
  header: { height: TOP + 60, paddingTop: TOP + 6, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  headerImage: { resizeMode: 'cover' },
  headerShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(15,17,23,0.2)' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { width: 34, height: 34 },
  wordmark: { width: 92, height: 24 },
  me: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,17,23,0.55)' },
  body: { paddingHorizontal: 20, paddingTop: 12 },
  sentence: { marginTop: 6 },
  tracker: { marginTop: 18 },
  skeleton: { height: 76, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)' },
  request: { borderWidth: 1, borderColor: 'rgba(226,176,90,0.35)', borderLeftWidth: 3, borderLeftColor: colors.amber, borderRadius: 12, padding: 14, marginBottom: 10 },
  requestHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  requestTitle: { color: colors.text, fontSize: 16, fontWeight: '600', flex: 1 },
  team: { flexDirection: 'row', gap: 12, paddingTop: 6 },
  person: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  personName: { color: colors.text, fontSize: 15, fontWeight: '600' },
  personCred: { color: colors.muted, fontSize: 13 },
  sheet: { flex: 1, backgroundColor: colors.bg, padding: 22, paddingTop: 28 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  signOut: { marginTop: 28 },
});
