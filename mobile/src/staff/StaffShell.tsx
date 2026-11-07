import { useCallback, useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import { apiFetch } from '../api/client';
import { syncAppBadge } from '../notifications/clientNotifications';
import { StaffPipelinesScreen } from '../screens/StaffPipelinesScreen';
import { colors } from '../theme/tokens';
import type { StaffMe, StaffThread } from '../types/api';
import { StaffClientDocumentsScreen } from './StaffClientDocumentsScreen';
import { StaffClientRecordScreen } from './StaffClientRecordScreen';
import { StaffClientsScreen } from './StaffClientsScreen';
import { StaffFindDocumentsScreen } from './StaffFindDocumentsScreen';
import { StaffInboxScreen, StaffThreadScreen } from './StaffInbox';
import { StaffMoreScreen, StaffMyWorkScreen } from './StaffMore';
import { type ConversationRef, StaffConversationScreen, StaffTeamScreen } from './StaffTeam';
import { StaffTodayScreen } from './StaffTodayScreen';
import type { ClientRef, StaffTab } from './staffApi';
import { StaffTabBar } from './ui';

type Route =
  | { name: 'client'; client: ClientRef }
  | { name: 'documents'; client: ClientRef }
  | { name: 'thread'; threadId?: number | string; personId?: number; title: string }
  | { name: 'conversation'; conversation: ConversationRef }
  | { name: 'myWork' }
  | { name: 'pipelines' }
  | { name: 'findDocuments' };

const TAB_LABEL: Record<StaffTab, string> = { today: 'Today', clients: 'Clients', inbox: 'Inbox', team: 'Team', more: 'More' };
const FULL_SCREEN: Route['name'][] = ['thread', 'conversation', 'pipelines'];

type Props = { token: string; biometricEnabled: boolean; canUseBiometrics: boolean; onToggleBiometrics: (on: boolean) => void; onSignOut: () => void };

export function StaffShell({ token, biometricEnabled, canUseBiometrics, onToggleBiometrics, onSignOut }: Props) {
  const [tab, setTab] = useState<StaffTab>('today');
  const [visited, setVisited] = useState<StaffTab[]>(['today']);
  const [stacks, setStacks] = useState<Record<StaffTab, Route[]>>({ today: [], clients: [], inbox: [], team: [], more: [] });
  const [me, setMe] = useState<StaffMe | null>(null);
  const [unread, setUnread] = useState<{ inbox: number; team: number }>({ inbox: 0, team: 0 });

  const staffName = me?.userName || '';
  const firstName = staffName.split(/\s+/)[0] || '';
  const initials = staffName.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();

  function select(next: StaffTab) {
    setVisited(v => (v.includes(next) ? v : [...v, next]));
    if (next === tab) setStacks(s => ({ ...s, [next]: [] }));
    setTab(next);
  }
  const push = useCallback((route: Route, onTab?: StaffTab) => {
    const target = onTab || tab;
    if (onTab) { setVisited(v => (v.includes(onTab) ? v : [...v, onTab])); setTab(onTab); }
    setStacks(s => ({ ...s, [target]: [...s[target], route] }));
  }, [tab]);
  const pop = (t: StaffTab) => setStacks(s => ({ ...s, [t]: s[t].slice(0, -1) }));

  const refreshCounts = useCallback(async () => {
    const [threads, team] = await Promise.all([
      apiFetch<StaffThread[]>('/api/messages', {}, token).catch(() => null),
      apiFetch<{ unread_conversations?: number }>('/api/team-chat/unread-count', {}, token).catch(() => null),
    ]);
    setUnread(prev => ({
      inbox: Array.isArray(threads) ? threads.filter(t => Number(t.unreadCount) > 0).length : prev.inbox,
      team: team ? Number(team.unread_conversations) || 0 : prev.team,
    }));
  }, [token]);

  useEffect(() => {
    apiFetch<StaffMe>('/firms/me', {}, token).then(setMe).catch(() => undefined);
    refreshCounts();
    const t = setInterval(() => { if (AppState.currentState === 'active') refreshCounts(); }, 30000);
    const sub = AppState.addEventListener('change', s => { if (s === 'active') refreshCounts(); });
    return () => { clearInterval(t); sub.remove(); };
  }, [token, refreshCounts]);
  useEffect(() => { syncAppBadge(unread.inbox + unread.team).catch(() => undefined); }, [unread]);

  // Tapping a notification opens the conversation it is about.
  useEffect(() => {
    const route = (data?: Record<string, unknown>) => {
      if (!data) return;
      if (data.type === 'client_message' && data.threadId) push({ name: 'thread', threadId: Number(data.threadId), title: 'Client message' }, 'inbox');
      else if (data.type === 'team_chat' && data.conversationId) push({ name: 'conversation', conversation: { id: Number(data.conversationId), title: 'Team chat' } }, 'team');
    };
    Notifications.getLastNotificationResponseAsync()
      .then(res => { if (res) { route(res.notification.request.content.data as Record<string, unknown>); Notifications.clearLastNotificationResponseAsync?.().catch(() => undefined); } })
      .catch(() => undefined);
    const sub = Notifications.addNotificationResponseReceivedListener(res => route(res.notification.request.content.data as Record<string, unknown>));
    return () => sub.remove();
  }, []);

  function renderRoute(t: StaffTab, route: Route, index: number) {
    const back = () => pop(t);
    const prev = stacks[t][index - 1];
    const backLabel = prev ? (prev.name === 'client' ? 'Back' : 'Back') : TAB_LABEL[t];
    switch (route.name) {
      case 'client':
        return <StaffClientRecordScreen token={token} client={route.client} backLabel={backLabel} onBack={back}
          onOpenClient={ref => push({ name: 'client', client: ref })}
          onMessage={(personId, title) => push({ name: 'thread', personId, title })}
          onOpenDocuments={ref => push({ name: 'documents', client: ref })} />;
      case 'documents':
        return <StaffClientDocumentsScreen token={token} client={route.client} onBack={back} />;
      case 'thread':
        return <StaffThreadScreen token={token} threadId={route.threadId} personId={route.personId} name={route.title} onBack={() => { back(); refreshCounts(); }} />;
      case 'conversation':
        return <StaffConversationScreen token={token} conversation={route.conversation} onBack={() => { back(); refreshCounts(); }} />;
      case 'myWork':
        return <StaffMyWorkScreen token={token} onBack={back} onOpenClient={ref => push({ name: 'client', client: ref })} onOpenThread={(id, title) => push({ name: 'thread', threadId: id, title })} />;
      case 'pipelines':
        return <StaffPipelinesScreen token={token} onBackHome={back} />;
      case 'findDocuments':
        return <StaffFindDocumentsScreen token={token} onBack={back} onPick={ref => push({ name: 'documents', client: ref })} />;
    }
  }

  function renderRoot(t: StaffTab) {
    const openClient = (ref: ClientRef) => push({ name: 'client', client: ref });
    const openMe = () => select('more');
    const on = tab === t && stacks[t].length === 0;
    switch (t) {
      case 'today': return <StaffTodayScreen token={token} firstName={firstName} initials={initials} active={on} onOpenClient={openClient} onOpenMe={openMe} />;
      case 'clients': return <StaffClientsScreen token={token} initials={initials} active={on} onOpenClient={openClient} onOpenMe={openMe} />;
      case 'inbox': return <StaffInboxScreen token={token} initials={initials} active={on} onOpenMe={openMe} onUnread={n => setUnread(u => ({ ...u, inbox: n }))} onOpenThread={(id, title) => push({ name: 'thread', threadId: id, title })} />;
      case 'team': return <StaffTeamScreen token={token} initials={initials} active={on} onOpenMe={openMe} onUnread={n => setUnread(u => ({ ...u, team: n }))} onOpen={conversation => push({ name: 'conversation', conversation })} />;
      case 'more': return <StaffMoreScreen token={token} name={staffName || 'Staff'} firmName={me?.name || ''} initials={initials} active={on}
        biometricEnabled={biometricEnabled} canUseBiometrics={canUseBiometrics} onToggleBiometrics={onToggleBiometrics} onSignOut={onSignOut}
        onOpen={screen => push({ name: screen === 'documents' ? 'findDocuments' : screen })} />;
    }
  }

  const top = stacks[tab][stacks[tab].length - 1];
  const hideTabs = top ? FULL_SCREEN.includes(top.name) : false;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ flex: 1 }}>
        {visited.map(t => (
          <View key={t} style={{ flex: 1, display: tab === t ? 'flex' : 'none' }} accessibilityElementsHidden={tab !== t} importantForAccessibility={tab === t ? 'auto' : 'no-hide-descendants'}>
            <View style={{ flex: 1, display: stacks[t].length ? 'none' : 'flex' }}>{renderRoot(t)}</View>
            {stacks[t].map((route, i) => (
              <View key={i + route.name} style={{ flex: 1, display: i === stacks[t].length - 1 ? 'flex' : 'none' }}>{renderRoute(t, route, i)}</View>
            ))}
          </View>
        ))}
      </View>
      {hideTabs ? null : <StaffTabBar active={tab} onSelect={select} badges={{ inbox: unread.inbox, team: unread.team }} />}
    </View>
  );
}
