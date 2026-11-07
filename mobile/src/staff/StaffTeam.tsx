import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { apiBaseUrl, apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon } from '../components/Icon';
import { useSafeBottom } from '../hooks/useSafeBottom';
import { colors } from '../theme/tokens';
import type { TeamChatConversation, TeamChatMessage } from '../types/api';
import { chatStyles as c } from './StaffInbox';
import { fmtWhen } from './staffApi';
import { Empty, ErrorLine, GroupLabel, IconCircle, Initials, Loading, NavBar, PageTitle, StaffHeader, TOP, st } from './ui';

type StaffUser = { id: number; name?: string; display_name?: string; email?: string };
export type ConversationRef = { id: number | string; title: string; subtitle?: string };

export function conversationTitle(cv: TeamChatConversation) {
  if (cv.conversation_type === 'dm') {
    const other = (cv.members || []).find(m => String(m.id) !== String(cv.current_staff_user_id));
    return other?.name || cv.title || 'Direct message';
  }
  return cv.title || 'Group';
}
function conversationSub(cv: TeamChatConversation) {
  return cv.conversation_type === 'dm' ? 'Direct message' : (cv.members?.length || 0) + ' members';
}
function userName(u: StaffUser) { return u.display_name || u.name || u.email || 'Staff'; }

// Tab root: one compact list of every chat, newest first. Tapping opens it full screen.
export function StaffTeamScreen({ token, initials, active, onOpen, onOpenMe, onUnread }: { token: string; initials: string; active: boolean; onOpen: (ref: ConversationRef) => void; onOpenMe: () => void; onUnread: (n: number) => void }) {
  const [list, setList] = useState<TeamChatConversation[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [composing, setComposing] = useState(false);

  const load = useCallback(async (opts: { refreshing?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try {
      const r = await apiFetch<{ conversations?: TeamChatConversation[] }>('/api/team-chat/conversations', {}, token);
      const rows = (r.conversations || []).slice().sort((a, b) => String(b.last_message_at || b.updated_at || '').localeCompare(String(a.last_message_at || a.updated_at || '')));
      setList(rows); setError('');
      onUnread(rows.reduce((n, x) => n + (Number(x.unread_count) > 0 ? 1 : 0), 0));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load team chat.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token]);
  useEffect(() => { if (active) load(); }, [active, load]);
  useEffect(() => {
    const t = setInterval(() => { if (active && AppState.currentState === 'active') load(); }, 25000);
    return () => clearInterval(t);
  }, [active, load]);

  const shown = (list || []).filter(cv => !q.trim() || conversationTitle(cv).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <ScrollView style={c.root} contentContainerStyle={{ paddingBottom: 28 }} keyboardShouldPersistTaps="handled" refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
        <StaffHeader initials={initials} onPressMe={onOpenMe} />
        <View style={st.body}>
          <PageTitle title="Team" right={<Pressable accessibilityRole="button" accessibilityLabel="New message" onPress={() => setComposing(true)} style={s.compose}><Icon name="compose" size={20} color="#15171d" /></Pressable>} />
          <View style={[st.search, { marginTop: 12 }]}>
            <Icon name="search" size={18} color={colors.muted} />
            <TextInput value={q} onChangeText={setQ} placeholder="Search chats" placeholderTextColor="rgba(153,164,180,0.7)" style={st.searchInput} clearButtonMode="while-editing" />
          </View>
          <ErrorLine text={error} onRetry={() => load()} />
          {!list && !error ? <Loading /> : null}
          {list && !shown.length ? <Empty text={q ? 'No chats match.' : 'No team chats yet. Tap the pencil to start one.'} /> : null}
          {shown.map(cv => {
            const unread = Number(cv.unread_count) || 0;
            const title = conversationTitle(cv);
            return (
              <Pressable key={String(cv.id)} onPress={() => onOpen({ id: cv.id, title, subtitle: conversationSub(cv) })} style={({ pressed }) => [st.row, pressed && st.pressed]}>
                {cv.conversation_type === 'dm' ? <Initials name={title} size={44} /> : <IconCircle name="users" size={44} />}
                <View style={st.rowBody}>
                  <View style={c.top}><Text style={[st.rowTitle, { flex: 1 }, unread > 0 && { fontWeight: '700' }]} numberOfLines={1}>{title}</Text><Text style={st.rowMeta}>{fmtWhen(cv.last_message_at || cv.updated_at)}</Text></View>
                  <Text style={[c.preview, unread > 0 && { color: colors.text }]} numberOfLines={1}>{cv.preview_text || conversationSub(cv)}</Text>
                </View>
                {unread > 0 ? <View style={s.count}><Text style={s.countText}>{unread > 9 ? '9+' : unread}</Text></View> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
      <NewMessageSheet token={token} open={composing} groups={(list || []).filter(x => x.conversation_type !== 'dm')} onClose={() => setComposing(false)}
        onPick={ref => { setComposing(false); onOpen(ref); load(); }} />
    </>
  );
}

function NewMessageSheet({ token, open, groups, onClose, onPick }: { token: string; open: boolean; groups: TeamChatConversation[]; onClose: () => void; onPick: (ref: ConversationRef) => void }) {
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    setQ('');
    apiFetch<{ users?: StaffUser[] }>('/api/team-chat/users', {}, token).then(r => setUsers(r.users || [])).catch(() => setUsers([]));
    apiFetch<{ userId?: number | string }>('/firms/me', {}, token).then(r => setMe(r.userId != null ? String(r.userId) : null)).catch(() => undefined);
  }, [open, token]);

  const needle = q.trim().toLowerCase();
  const people = (users || []).filter(u => String(u.id) !== me && (!needle || userName(u).toLowerCase().includes(needle)));
  const shownGroups = groups.filter(g => !needle || conversationTitle(g).toLowerCase().includes(needle));

  async function dm(u: StaffUser) {
    setBusy(u.id);
    try {
      const r = await apiFetch<{ conversation?: TeamChatConversation }>('/api/team-chat/conversations/dm', { method: 'POST', body: JSON.stringify({ staff_user_id: u.id }) }, token);
      if (!r.conversation) throw new Error('The chat could not be opened.');
      onPick({ id: r.conversation.id, title: userName(u), subtitle: 'Direct message' });
    } catch (e) { Alert.alert('Could not start chat', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setBusy(null); }
  }

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[c.root, { paddingTop: Platform.OS === 'ios' ? 8 : TOP }]}>
        <View style={s.sheetBar}>
          <Pressable onPress={onClose} hitSlop={10}><Text style={s.cancel}>Cancel</Text></Pressable>
          <Text style={s.sheetTitle}>New message</Text>
          <View style={{ width: 56 }} />
        </View>
        <View style={[st.search, { marginHorizontal: 20, marginTop: 8 }]}>
          <Text style={st.rowMeta}>To:</Text>
          <TextInput value={q} onChangeText={setQ} autoFocus placeholder="Search people or groups" placeholderTextColor="rgba(153,164,180,0.7)" style={st.searchInput} autoCorrect={false} />
        </View>
        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          {shownGroups.length ? <GroupLabel title="Groups" /> : null}
          {shownGroups.map(g => (
            <Pressable key={String(g.id)} onPress={() => onPick({ id: g.id, title: conversationTitle(g), subtitle: conversationSub(g) })} style={({ pressed }) => [st.row, pressed && st.pressed]}>
              <IconCircle name="users" />
              <View style={st.rowBody}><Text style={st.rowTitle}>{conversationTitle(g)}</Text><Text style={st.rowMeta}>{conversationSub(g)}</Text></View>
            </Pressable>
          ))}
          <GroupLabel title="People" />
          {!users ? <Loading /> : null}
          {people.map(u => (
            <Pressable key={u.id} disabled={busy != null} onPress={() => dm(u)} style={({ pressed }) => [st.row, pressed && st.pressed]}>
              <Initials name={userName(u)} />
              <View style={st.rowBody}><Text style={st.rowTitle}>{userName(u)}</Text>{u.email ? <Text style={st.rowMeta}>{u.email}</Text> : null}</View>
              {busy === u.id ? <ActivityIndicator color={colors.gold2} /> : null}
            </Pressable>
          ))}
          {users && !people.length ? <Empty text="No one matches." /> : null}
          <Text style={[st.rowMeta, { marginTop: 16 }]}>New group chats are set up on the web for now.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

type Picked = { uri: string; name: string; mimeType?: string };

// Full-screen team conversation.
export function StaffConversationScreen({ token, conversation, onBack }: { token: string; conversation: ConversationRef; onBack: () => void }) {
  const bottom = useSafeBottom();
  const scroll = useRef<ScrollView | null>(null);
  const [messages, setMessages] = useState<TeamChatMessage[] | null>(null);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<Picked[]>([]);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ messages?: TeamChatMessage[] }>('/api/team-chat/conversations/' + conversation.id + '/messages?limit=100', {}, token);
      const rows = r.messages || [];
      setMessages(rows); setError('');
      const last = rows[rows.length - 1];
      if (last?.id) apiFetch('/api/team-chat/conversations/' + conversation.id + '/read', { method: 'POST', body: JSON.stringify({ message_id: last.id }) }, token).catch(() => undefined);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load this chat.'); }
  }, [token, conversation.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { if (AppState.currentState === 'active' && !sending) load(); }, 12000);
    return () => clearInterval(t);
  }, [load, sending]);

  async function pick() {
    const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (r.canceled) return;
    setFiles(prev => [...prev, ...r.assets.map(a => ({ uri: a.uri, name: a.name || 'attachment', mimeType: a.mimeType || undefined }))].slice(0, 3));
  }

  async function send() {
    if (!body.trim() && !files.length) return;
    setSending(true);
    try {
      const form = new FormData();
      form.append('conversation_id', String(conversation.id));
      form.append('body', body.trim());
      form.append('client_nonce', Date.now() + '-' + Math.random().toString(16).slice(2));
      files.forEach(f => form.append('attachments', { uri: f.uri, name: f.name, type: f.mimeType || 'application/octet-stream' } as unknown as Blob));
      const res = await fetch(apiBaseUrl() + '/api/team-chat/messages/send', { method: 'POST', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof payload?.error === 'string' ? payload.error : 'Send failed (' + res.status + ')');
      setBody(''); setFiles([]);
      await load();
    } catch (e) { Alert.alert('Not sent', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setSending(false); }
  }

  async function openAttachment(id?: number | string) {
    if (!id) return;
    try {
      const r = await apiFetch<{ url?: string }>('/api/team-chat/attachments/' + id + '/download', {}, token);
      if (r.url) await Linking.openURL(r.url);
    } catch (e) { Alert.alert('Could not open', e instanceof Error ? e.message : 'Please try again.'); }
  }

  const rows = messages || [];
  const withDays = useMemo(() => rows.map((m, i) => {
    const d = new Date(m.created_at || m.date || '');
    const prev = i ? new Date(rows[i - 1].created_at || rows[i - 1].date || '') : null;
    const newDay = !Number.isNaN(d.getTime()) && (!prev || prev.toDateString() !== d.toDateString());
    return { m, day: newDay ? (d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })) : '' };
  }), [rows]);

  return (
    <KeyboardAvoidingView style={c.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <NavBar title={conversation.title} subtitle={conversation.subtitle} onBack={onBack} backLabel="Team" />
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={c.messages} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        <ErrorLine text={error} onRetry={load} />
        {!messages && !error ? <Loading /> : null}
        {messages && !messages.length ? <Empty text="No messages yet. Say hello." /> : null}
        {withDays.map(({ m, day }) => {
          const mine = Boolean(m.out || m.direction === 'outbound');
          return (
            <View key={String(m.id || m.message_id)}>
              {day ? <Text style={s.day}>{day}</Text> : null}
              <View style={[s.line, mine && { justifyContent: 'flex-end' }]}>
                {!mine ? <Initials name={m.sender_name || 'Team'} size={30} /> : null}
                <View style={[c.msgWrap, { flexShrink: 1 }, mine ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
                  <Text style={c.msgMeta}>{mine ? '' : (m.sender_name || 'Team') + ' · '}{new Date(m.created_at || m.date || '').toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</Text>
                  <View style={[c.bubble, { maxWidth: '100%' }, mine ? c.mine : c.theirs]}>
                    {!!(m.text || m.body) && <Text style={[c.msgText, mine && { color: '#15171d' }]}>{m.text || m.body}</Text>}
                    {(m.attachments || []).map(a => (
                      <Pressable key={String(a.id)} onPress={() => openAttachment(a.id)} style={c.attach}>
                        <Icon name="paperclip" size={15} color={mine ? '#15171d' : colors.text2} />
                        <Text style={[c.attachText, mine && { color: '#15171d' }]} numberOfLines={1}>{a.file_name || 'Attachment'}</Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
      <View style={[c.composer, { paddingBottom: Math.max(bottom, 10) }]}>
        {files.length ? (
          <View style={s.files}>{files.map((f, i) => (
            <Pressable key={f.uri + i} onPress={() => setFiles(prev => prev.filter((_, j) => j !== i))} style={s.file}>
              <Text style={s.fileText} numberOfLines={1}>{f.name}</Text><Icon name="close" size={14} color={colors.muted} />
            </Pressable>
          ))}</View>
        ) : null}
        <View style={c.inputRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Attach a file" onPress={pick} disabled={files.length >= 3} style={s.clip} hitSlop={6}><Icon name="paperclip" size={21} color={colors.muted} /></Pressable>
          <TextInput value={body} onChangeText={setBody} multiline placeholder={'Message ' + conversation.title} placeholderTextColor="rgba(153,164,180,0.7)" style={c.input} />
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={sending || (!body.trim() && !files.length)} onPress={send} style={[c.send, ((!body.trim() && !files.length) || sending) && { opacity: 0.4 }]}>
            {sending ? <ActivityIndicator color="#15171d" /> : <Icon name="send" size={20} color="#15171d" />}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  compose: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.goldBtn, alignItems: 'center', justifyContent: 'center' },
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.goldBtn, alignItems: 'center', justifyContent: 'center' },
  countText: { color: '#15171d', fontSize: 12, fontWeight: '800' },
  sheetBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, height: 48 },
  cancel: { color: colors.gold2, fontSize: 16 },
  sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  day: { color: colors.muted, fontSize: 12, textAlign: 'center', marginVertical: 6 },
  line: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  clip: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  files: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.07)' },
  fileText: { color: colors.text, fontSize: 12.5, flexShrink: 1 },
});

