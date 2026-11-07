import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon } from '../components/Icon';
import { useSafeBottom } from '../hooks/useSafeBottom';
import { colors } from '../theme/tokens';
import type { StaffMessage, StaffThread, StaffThreadDetail } from '../types/api';
import { fmtWhen } from './staffApi';
import { Empty, ErrorLine, Initials, Loading, NavBar, PageTitle, Segmented, StaffHeader, st } from './ui';

export function threadName(t?: StaffThread | null) {
  const p = t?.person;
  return [p?.firstName, p?.lastName].filter(Boolean).join(' ').trim() || p?.email || 'Client';
}

export async function setThreadArchived(token: string, id: number | string, archived: boolean) {
  await apiFetch('/api/messages/' + id + (archived ? '/archive' : '/restore'), { method: 'PUT' }, token);
}

// Tab root: client conversations, newest first. Long-press a row to archive or restore it.
export function StaffInboxScreen({ token, initials, active, onOpenThread, onOpenMe, onUnread }: { token: string; initials: string; active: boolean; onOpenThread: (id: number | string, name: string) => void; onOpenMe: () => void; onUnread: (n: number) => void }) {
  const [threads, setThreads] = useState<StaffThread[] | null>(null);
  const [archived, setArchived] = useState<StaffThread[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState<'all' | 'unread' | 'archived'>('all');

  const load = useCallback(async (opts: { refreshing?: boolean; withArchived?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try {
      const [rows, archivedRows] = await Promise.all([
        apiFetch<StaffThread[]>('/api/messages', {}, token),
        opts.withArchived ? apiFetch<StaffThread[]>('/api/messages?view=archived', {}, token) : Promise.resolve(null),
      ]);
      const list = Array.isArray(rows) ? rows : [];
      setThreads(list); setError('');
      if (archivedRows) setArchived(Array.isArray(archivedRows) ? archivedRows : []);
      onUnread(list.reduce((n, t) => n + (Number(t.unreadCount) > 0 ? 1 : 0), 0));
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load the inbox.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token]);
  const showingArchived = view === 'archived';
  useEffect(() => { if (active) load({ withArchived: showingArchived }); }, [active, load, showingArchived]);
  useEffect(() => {
    const t = setInterval(() => { if (active && AppState.currentState === 'active') load({ withArchived: showingArchived }); }, 25000);
    return () => clearInterval(t);
  }, [active, load, showingArchived]);

  async function toggleArchive(t: StaffThread, archive: boolean) {
    const drop = (list: StaffThread[] | null) => list ? list.filter(x => String(x.id) !== String(t.id)) : list;
    if (archive) setThreads(drop); else setArchived(drop);
    try { await setThreadArchived(token, t.id, archive); }
    catch (e) { Alert.alert(archive ? 'Not archived' : 'Not restored', e instanceof Error ? e.message : 'Please try again.'); }
    load({ withArchived: true });
  }
  function confirmArchive(t: StaffThread) {
    const archive = !showingArchived;
    Alert.alert(threadName(t), t.subject || undefined, [
      { text: archive ? 'Archive' : 'Restore to Inbox', onPress: () => toggleArchive(t, archive) },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  const source = showingArchived ? archived : threads;
  const shown = (source || []).filter(t => view !== 'unread' || Number(t.unreadCount) > 0);
  const emptyText = view === 'unread' ? "You're caught up. No unread client messages." : showingArchived ? 'No archived conversations.' : 'No client conversations yet.';
  return (
    <ScrollView style={s.root} contentContainerStyle={{ paddingBottom: 28 }} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true, withArchived: showingArchived })} message="Refreshing…" />}>
      <StaffHeader initials={initials} onPressMe={onOpenMe} />
      <View style={st.body}>
        <PageTitle title="Inbox" />
        <View style={{ marginTop: 12 }}><Segmented value={view} onChange={setView} options={[{ key: 'all', label: 'All' }, { key: 'unread', label: 'Unread' }, { key: 'archived', label: 'Archived' }]} /></View>
        <ErrorLine text={error} onRetry={() => load({ withArchived: showingArchived })} />
        {!source && !error ? <Loading /> : null}
        {source && !shown.length ? <Empty text={emptyText} /> : null}
        {source && shown.length ? <Text style={s.hint}>{showingArchived ? 'Press and hold a conversation to restore it.' : 'Press and hold a conversation to archive it.'}</Text> : null}
        {shown.map(t => {
          const unread = Number(t.unreadCount) > 0;
          const name = threadName(t);
          return (
            <Pressable key={String(t.id)} onPress={() => onOpenThread(t.id, name)} onLongPress={() => confirmArchive(t)} delayLongPress={350}
              accessibilityActions={[{ name: 'archive', label: showingArchived ? 'Restore to Inbox' : 'Archive' }]}
              onAccessibilityAction={() => toggleArchive(t, !showingArchived)}
              style={({ pressed }) => [st.row, pressed && st.pressed]}>
              <Initials name={name} size={44} />
              <View style={st.rowBody}>
                <View style={s.top}><Text style={[st.rowTitle, { flex: 1 }]} numberOfLines={1}>{name}</Text><Text style={st.rowMeta}>{fmtWhen(t.lastMessageAt)}</Text></View>
                {!!t.subject && <Text style={s.subject} numberOfLines={1}>{t.subject}</Text>}
                {!!t.lastPreview && <Text style={[s.preview, unread && { color: colors.text }]} numberOfLines={2}>{t.lastPreview}</Text>}
              </View>
              {unread ? <View style={s.unread} /> : null}
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function Bubble({ m, token }: { m: StaffMessage; token: string }) {
  const mine = m.senderType === 'staff';
  async function openAttachment(docId?: string | number) {
    if (!docId) return;
    try {
      const r = await apiFetch<{ url?: string }>('/api/documents/' + docId + '/download', {}, token);
      if (r.url) await Linking.openURL(r.url);
    } catch (e) { Alert.alert('Could not open', e instanceof Error ? e.message : 'Please try again.'); }
  }
  return (
    <View style={[s.msgWrap, mine ? { alignItems: 'flex-end' } : { alignItems: 'flex-start' }]}>
      <Text style={s.msgMeta}>{m.isInternal ? 'Internal note · ' : ''}{mine ? (m.senderName || 'Staff') : (m.senderName || 'Client')} · {fmtWhen(m.createdAt)}</Text>
      <View style={[s.bubble, mine ? s.mine : s.theirs, m.isInternal && s.internal]}>
        {!!m.body && <Text style={[s.msgText, mine && !m.isInternal && { color: '#15171d' }]}>{m.body}</Text>}
        {(m.attachments || []).map((a, i) => (
          <Pressable key={String(a.id || i)} onPress={() => openAttachment(a.documentId || a.id)} style={s.attach}>
            <Icon name="file" size={16} color={mine && !m.isInternal ? '#15171d' : colors.text2} />
            <Text style={[s.attachText, mine && !m.isInternal && { color: '#15171d' }]} numberOfLines={1}>{a.displayName || 'Attachment'}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

// Full-screen client conversation. Also used to start a first conversation with a client.
export function StaffThreadScreen({ token, threadId, personId, name, onBack }: { token: string; threadId?: number | string | null; personId?: number; name: string; onBack: () => void }) {
  const bottom = useSafeBottom();
  const scroll = useRef<ScrollView | null>(null);
  const [id, setId] = useState<number | string | null>(threadId ?? null);
  const [thread, setThread] = useState<StaffThreadDetail | null>(null);
  const [resolving, setResolving] = useState(!threadId && !!personId);
  const [error, setError] = useState('');
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async (tid: number | string) => {
    try { setThread(await apiFetch<StaffThreadDetail>('/api/messages/' + tid, {}, token)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load this conversation.'); }
  }, [token]);

  useEffect(() => {
    if (id) { load(id); return; }
    if (!personId) return;
    apiFetch<Array<{ id: number }>>('/api/messages/person/' + personId, {}, token)
      .then(rows => { const first = Array.isArray(rows) ? rows[0] : null; if (first) setId(first.id); })
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load messages.'))
      .finally(() => setResolving(false));
  }, [id, personId, token, load]);
  useEffect(() => {
    if (!id) return;
    const t = setInterval(() => { if (AppState.currentState === 'active' && !sending) load(id); }, 15000);
    return () => clearInterval(t);
  }, [id, sending, load]);

  async function send() {
    const text = body.trim();
    if (!text) return;
    setSending(true);
    try {
      if (id) {
        await apiFetch('/api/messages/' + id + '/reply', { method: 'POST', body: JSON.stringify({ body: text, is_internal: internal }) }, token);
        setBody('');
        await load(id);
      } else if (personId) {
        const r = await apiFetch<{ threadId?: number }>('/api/messages', { method: 'POST', body: JSON.stringify({ person_id: personId, subject: 'Message from your team', body: text }) }, token);
        setBody('');
        if (r.threadId) setId(r.threadId);
      }
    } catch (e) { Alert.alert('Not sent', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setSending(false); }
  }

  const messages = thread?.messages || [];
  async function toggleArchive() {
    if (!id || !thread) return;
    const archive = !thread.isArchived;
    setArchiving(true);
    try {
      await setThreadArchived(token, id, archive);
      if (archive) { onBack(); return; }
      await load(id);
    } catch (e) { Alert.alert(archive ? 'Not archived' : 'Not restored', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setArchiving(false); }
  }
  const archiveAction = id && thread ? (
    <Pressable accessibilityRole="button" accessibilityLabel={thread.isArchived ? 'Restore to Inbox' : 'Archive conversation'} disabled={archiving} onPress={toggleArchive} hitSlop={10} style={archiving ? { opacity: 0.5 } : undefined}>
      {archiving ? <ActivityIndicator color={colors.gold2} /> : <Text style={s.navAction}>{thread.isArchived ? 'Restore' : 'Archive'}</Text>}
    </Pressable>
  ) : undefined;
  return (
    <KeyboardAvoidingView style={s.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <NavBar title={name} subtitle={thread?.subject || undefined} onBack={onBack} backLabel="Back" right={archiveAction} />
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={s.messages} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        <ErrorLine text={error} onRetry={id ? () => load(id) : undefined} />
        {(resolving || (id && !thread && !error)) ? <Loading /> : null}
        {!resolving && !id && !error ? <Empty text={'No conversation with ' + name + ' yet. Your first message starts one; they get an email and an app notification.'} /> : null}
        {messages.map(m => <Bubble key={String(m.id)} m={m} token={token} />)}
      </ScrollView>
      <View style={[s.composer, { paddingBottom: Math.max(bottom, 10) }]}>
        {id ? (
          <View style={s.modeRow}>
            <Pressable onPress={() => setInternal(false)} hitSlop={6}><Text style={[s.mode, !internal && s.modeOn]}>Reply to client</Text></Pressable>
            <Pressable onPress={() => setInternal(true)} hitSlop={6}><Text style={[s.mode, internal && s.modeOn]}>Internal note</Text></Pressable>
          </View>
        ) : null}
        <View style={s.inputRow}>
          <TextInput value={body} onChangeText={setBody} multiline placeholder={internal ? 'Note for the team…' : 'Message ' + name.split(/\s+/)[0] + '…'} placeholderTextColor="rgba(153,164,180,0.7)" style={[s.input, internal && { borderColor: 'rgba(226,176,90,0.5)' }]} />
          <Pressable accessibilityRole="button" accessibilityLabel="Send" disabled={sending || !body.trim()} onPress={send} style={[s.send, (!body.trim() || sending) && { opacity: 0.4 }]}>
            {sending ? <ActivityIndicator color="#15171d" /> : <Icon name="send" size={20} color="#15171d" />}
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export const chatStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subject: { color: colors.text2, fontSize: 13.5 },
  preview: { color: colors.muted, fontSize: 13.5, lineHeight: 18 },
  unread: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.goldBtn },
  hint: { color: colors.muted, fontSize: 12, marginTop: 10, marginBottom: 2 },
  navAction: { color: colors.gold2, fontSize: 16, fontWeight: '600' },
  messages: { padding: 16, paddingBottom: 12, gap: 12 },
  msgWrap: { gap: 4 },
  msgMeta: { color: colors.muted, fontSize: 11.5, marginHorizontal: 4 },
  bubble: { maxWidth: '84%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  mine: { backgroundColor: colors.goldBtn, borderBottomRightRadius: 5 },
  theirs: { backgroundColor: colors.panel2, borderBottomLeftRadius: 5 },
  internal: { backgroundColor: 'rgba(226,176,90,0.12)', borderWidth: 1, borderColor: 'rgba(226,176,90,0.4)' },
  msgText: { color: colors.text, fontSize: 15.5, lineHeight: 21 },
  attach: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 2 },
  attachText: { color: colors.text2, fontSize: 13.5, textDecorationLine: 'underline', flexShrink: 1 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.14)', paddingHorizontal: 12, paddingTop: 8, backgroundColor: '#0b0d12', gap: 8 },
  modeRow: { flexDirection: 'row', gap: 18, paddingHorizontal: 6 },
  mode: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  modeOn: { color: colors.gold2 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, minHeight: 40, maxHeight: 130, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', color: colors.text, fontSize: 15.5, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 },
  send: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.goldBtn, alignItems: 'center', justifyContent: 'center' },
});
const s = chatStyles;
