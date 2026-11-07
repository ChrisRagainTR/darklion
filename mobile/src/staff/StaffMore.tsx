import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { AccountSecurityScreen } from '../screens/AccountSecurityScreen';
import { apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon, type IconName } from '../components/Icon';
import { registerForStaffNotifications } from '../notifications/clientNotifications';
import { colors } from '../theme/tokens';
import { appVersionLabel } from '../utils/appVersion';
import { type ClientRef, fmtDate } from './staffApi';
import { Empty, ErrorLine, GroupLabel, Initials, Loading, NavBar, StaffHeader, st } from './ui';

type Props = {
  token: string;
  name: string;
  firmName: string;
  initials: string;
  active: boolean;
  biometricEnabled: boolean;
  canUseBiometrics: boolean;
  onToggleBiometrics: (on: boolean) => void;
  onOpen: (screen: 'myWork' | 'pipelines' | 'documents') => void;
  onSignOut: () => void;
};

function Row({ icon, title, onPress, right, danger }: { icon: IconName; title: string; onPress?: () => void; right?: React.ReactNode; danger?: boolean }) {
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={({ pressed }) => [st.row, pressed && st.pressed]}>
      <Icon name={icon} size={21} color={danger ? colors.red : colors.gold2} />
      <Text style={[s.rowTitle, danger && { color: colors.red }]}>{title}</Text>
      {right}
      {onPress && !right ? <Icon name="chevron" size={16} color={colors.muted} /> : null}
    </Pressable>
  );
}

export function StaffMoreScreen({ token, name, firmName, initials, active, biometricEnabled, canUseBiometrics, onToggleBiometrics, onOpen, onSignOut }: Props) {
  const [securityOpen,setSecurityOpen]=useState(false);
  const [workCount, setWorkCount] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    apiFetch<{ total?: number }>('/api/my-work/count', {}, token).then(r => setWorkCount(Number(r.total) || 0)).catch(() => undefined);
  }, [active, token]);

  async function notifications() {
    try {
      const r = await registerForStaffNotifications(token);
      Alert.alert(r.registered ? 'Notifications are on' : 'Notifications are off', r.registered ? 'You will get client messages and team chats on this iPhone.' : 'Turn on notifications for this app in iPhone Settings, then try again.');
    } catch (e) { Alert.alert('Could not turn on notifications', e instanceof Error ? e.message : 'Please try again.'); }
  }

  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 32 }}>
      <Modal visible={securityOpen} onRequestClose={()=>setSecurityOpen(false)}><AccountSecurityScreen token={token} mode="staff" onClose={()=>setSecurityOpen(false)} onSignOut={onSignOut}/></Modal>
      <StaffHeader initials={initials} />
      <View style={st.body}>
        <View style={s.me}>
          <Initials name={name} size={56} />
          <View style={{ flex: 1 }}><Text style={s.name}>{name}</Text><Text style={st.rowMeta}>{firmName}</Text></View>
        </View>
        <Row icon="listChecks" title="Account security & data requests" onPress={()=>setSecurityOpen(true)} />
        <GroupLabel title="Work" />
        <Row icon="listChecks" title="My Work" onPress={() => onOpen('myWork')} right={<View style={s.right}>{workCount ? <View style={s.count}><Text style={s.countText}>{workCount}</Text></View> : null}<Icon name="chevron" size={16} color={colors.muted} /></View>} />
        <Row icon="kanban" title="Pipelines" onPress={() => onOpen('pipelines')} />
        <Row icon="folder" title="Find documents" onPress={() => onOpen('documents')} />
        <GroupLabel title="This iPhone" />
        <Row icon="bell" title="Notifications" onPress={notifications} />
        {canUseBiometrics ? <Row icon="faceId" title="Face ID lock" right={<Switch value={biometricEnabled} onValueChange={onToggleBiometrics} thumbColor="#ffffff" trackColor={{ true: colors.goldBtn, false: 'rgba(255,255,255,0.2)' }} />} /> : null}
        <Row icon="logout" title="Sign out" danger onPress={() => Alert.alert('Sign out?', undefined, [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: onSignOut }])} />
        <Text style={s.version}>{appVersionLabel()}</Text>
      </View>
    </ScrollView>
  );
}

type WorkItem = { kind: string; id: number | string; title: string; entity?: { type?: string; id?: number; name?: string }; pipelineName?: string | null; stageName?: string | null; priority?: string; dueDate?: string | null; link?: string; threadId?: number };

function bucket(due?: string | null) {
  if (!due) return 'No due date';
  const today = new Date().toISOString().slice(0, 10);
  if (due < today) return 'Overdue';
  if (due === today) return 'Today';
  const week = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  return due <= week ? 'This week' : 'Later';
}
const ORDER = ['Overdue', 'Today', 'This week', 'Later', 'No due date'];

export function StaffMyWorkScreen({ token, onBack, onOpenClient, onOpenThread }: { token: string; onBack: () => void; onOpenClient: (ref: ClientRef) => void; onOpenThread: (id: number, name: string) => void }) {
  const [items, setItems] = useState<WorkItem[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (opts: { refreshing?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try { const r = await apiFetch<{ items?: WorkItem[] }>('/api/my-work', {}, token); setItems(r.items || []); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load your work.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  function open(it: WorkItem) {
    if (it.kind === 'task' && it.threadId) return onOpenThread(it.threadId, it.entity?.name || 'Client');
    const type = it.entity?.type;
    if ((type === 'person' || type === 'company') && it.entity?.id) onOpenClient({ type, id: it.entity.id, name: it.entity.name });
  }

  const groups = ORDER.map(g => [g, (items || []).filter(i => bucket(i.dueDate) === g)] as const).filter(([, l]) => l.length);
  return (
    <View style={s.root}>
      <NavBar title="My Work" subtitle={items ? items.length + ' open' : undefined} onBack={onBack} backLabel="More" />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
        <View style={st.body}>
          <ErrorLine text={error} onRetry={() => load()} />
          {!items && !error ? <Loading /> : null}
          {items && !items.length ? <Empty text="Nothing is assigned to you right now." /> : null}
          {groups.map(([g, list]) => (
            <View key={g}>
              <GroupLabel title={g} count={list.length} tone={g === 'Overdue' ? 'warn' : undefined} />
              {list.map(it => (
                <Pressable key={it.kind + it.id} onPress={() => open(it)} style={({ pressed }) => [st.row, pressed && st.pressed]}>
                  <View style={st.rowBody}>
                    <Text style={st.rowTitle} numberOfLines={2}>{it.title}</Text>
                    <Text style={st.rowSub} numberOfLines={1}>{[it.entity?.name, it.pipelineName].filter(Boolean).join(' · ')}</Text>
                  </View>
                  {it.priority && ['high', 'urgent'].includes(it.priority) ? <Text style={s.flag}>{it.priority === 'urgent' ? 'Urgent' : 'High'}</Text> : null}
                  {it.dueDate ? <Text style={st.rowMeta}>{fmtDate(it.dueDate + 'T12:00:00')}</Text> : null}
                  <Icon name="chevron" size={16} color={colors.muted} />
                </Pressable>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  me: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 14 },
  name: { color: colors.text, fontSize: 22, fontWeight: '700' },
  rowTitle: { color: colors.text, fontSize: 16, flex: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  count: { minWidth: 24, height: 24, borderRadius: 12, paddingHorizontal: 7, backgroundColor: colors.goldBtn, alignItems: 'center', justifyContent: 'center' },
  countText: { color: '#15171d', fontSize: 12.5, fontWeight: '800' },
  version: { color: colors.muted, fontSize: 12, marginTop: 22, textAlign: 'center' },
  flag: { color: colors.amber, fontSize: 12, fontWeight: '700' },
});
