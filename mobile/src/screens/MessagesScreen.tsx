import { useEffect, useMemo, useRef, useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { apiFetch } from '../api/client';
import { AppRefreshControl, AppRefreshOverlay } from '../components/AppRefreshControl';
import { colors, radius, spacing } from '../theme/tokens';
import type { MessageContact, MessageThreadResponse, PortalMessage } from '../types/api';
import { useRefreshOnReturn } from '../hooks/useRefreshOnReturn';

type Props = {
  active?: boolean;
  token: string;
  onBackHome?: () => void;
};

type ThreadListItem = {
  message: PortalMessage;
  day: string;
};

type SelectedAttachment = {
  uri: string;
  name: string;
  mimeType?: string;
  size?: number;
};

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
}

function formatMessageTime(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date);
}

function messageDayLabel(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

function staffTitleText(contact: MessageContact) {
  return (contact.credentials || 'Your team').replace(/\s+/g, ' ').trim();
}

type AvatarProps = {
  name: string;
  url?: string | null;
  size?: number;
};

function StaffAvatar({ name, url, size = 52 }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const dimensionStyle = { width: size, height: size, borderRadius: size / 2 };
  if (url && !failed) {
    return (
      <View style={[styles.avatar, dimensionStyle]}>
        <Image source={{ uri: url }} onError={() => setFailed(true)} style={[styles.avatarImage, dimensionStyle]} />
      </View>
    );
  }
  return <View style={[styles.avatar, dimensionStyle]}><Text style={styles.avatarText}>{initials(name)}</Text></View>;
}

export function MessagesScreen({ active = true, token, onBackHome }: Props) {
  const [contacts, setContacts] = useState<MessageContact[]>([]);
  const [selectedContact, setSelectedContact] = useState<MessageContact | null>(null);
  const [messages, setMessages] = useState<PortalMessage[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [loadingThread, setLoadingThread] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [body, setBody] = useState('');
  const [search, setSearch] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<SelectedAttachment[]>([]);
  const [error, setError] = useState('');
  const [deliveryNotice, setDeliveryNotice] = useState('');
  useEffect(() => {
    if (!deliveryNotice) return undefined;
    const timer = setTimeout(() => setDeliveryNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [deliveryNotice]);
  const selectedIdRef = useRef<string | null>(null);
  const contactsRequest = useRef(0);
  const threadRequest = useRef(0);
  const sendLock = useRef(false);
  const listRef = useRef<FlatList<ThreadListItem>>(null);
  const scrollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const forceScrollAfterSend = useRef(false);
  const shouldFollowThreadRef = useRef(true);
  const pendingThreadScrollRef = useRef(false);
  const lastThreadMessageKeyRef = useRef<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  function scrollThreadToBottom(animated = false, extended = false) {
    requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated }));
    scrollTimers.current.forEach(clearTimeout);
    scrollTimers.current = (extended ? [80, 220, 420, 700, 1000, 1400] : [80, 220, 420, 700]).map((delay) => setTimeout(() => {
      listRef.current?.scrollToEnd({ animated });
    }, delay));
  }

  function latestPortalMessageKey(rows: PortalMessage[]) {
    const last = rows[rows.length - 1];
    if (!last) return null;
    return String(last.id || last.created_at || last.createdAt || rows.length);
  }

  function requestThreadBottomScroll(animated = true, extended = true) {
    shouldFollowThreadRef.current = true;
    pendingThreadScrollRef.current = true;
    setShowJumpToLatest(false);
    scrollThreadToBottom(animated, extended);
  }

  function handleThreadScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    const nearBottom = distanceFromBottom < 96;
    shouldFollowThreadRef.current = nearBottom;
    if (nearBottom) setShowJumpToLatest(false);
  }

  function handleThreadContentChange() {
    if (!shouldFollowThreadRef.current && !pendingThreadScrollRef.current) return;
    const animated = forceScrollAfterSend.current;
    const extended = forceScrollAfterSend.current;
    pendingThreadScrollRef.current = false;
    forceScrollAfterSend.current = false;
    scrollThreadToBottom(animated, extended);
  }

  async function loadContacts(searchText = search, options: { silent?: boolean; refreshing?: boolean } = {}) {
    setError('');
    if (options.refreshing) setRefreshing(true);
    else if (!options.silent) setLoadingContacts(true);
    const request = ++contactsRequest.current;
    const query = searchText.trim();
    try {
      const path = query ? `/portal/messages?search=${encodeURIComponent(query)}` : '/portal/messages';
      const result = await apiFetch<MessageContact[]>(path, {}, token);
      if (request !== contactsRequest.current) return;
      setContacts(Array.isArray(result) ? result : []);
    } catch (err) {
      if (request !== contactsRequest.current) return;
      setError(err instanceof Error ? err.message : 'Could not load messages.');
    } finally {
      if (request === contactsRequest.current) {
        setRefreshing(false);
        setLoadingContacts(false);
      }
    }
  }

  async function refreshSelectedThread(contact = selectedContact, options: { silent?: boolean; refreshing?: boolean; afterSend?: boolean } = {}) {
    if (!contact) return;
    const request = ++threadRequest.current;
    const isCurrent = () => request === threadRequest.current && selectedIdRef.current === String(contact.id);
    setError('');
    if (options.refreshing) setRefreshing(true);
    else if (!options.silent) setLoadingThread(true);
    try {
      const data = await apiFetch<MessageThreadResponse>(`/portal/messages/thread/${encodeURIComponent(contact.id)}`, options.afterSend ? { signal: new AbortController().signal } : {}, token);
      if (!isCurrent()) return;
      const rows = Array.isArray(data.messages) ? data.messages : [];
      const previousLastKey = lastThreadMessageKeyRef.current;
      const nextLastKey = latestPortalMessageKey(rows);
      const shouldScrollToLatest = (!options.silent && !options.refreshing) || shouldFollowThreadRef.current;
      setMessages(rows);
      lastThreadMessageKeyRef.current = nextLastKey;
      setContacts((prev) => prev.map((item) => String(item.id) === String(contact.id) ? { ...item, unreadCount: 0 } : item));
      if (shouldScrollToLatest) {
        requestThreadBottomScroll(false, false);
      } else if (nextLastKey && previousLastKey && nextLastKey !== previousLastKey) {
        setShowJumpToLatest(true);
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError('Could not refresh this conversation. Pull down to retry.');
    } finally {
      if (isCurrent()) {
        setRefreshing(false);
        setLoadingThread(false);
      }
    }
  }

  async function openThread(contact: MessageContact) {
    if (sendLock.current) return;
    selectedIdRef.current = String(contact.id);
    setSelectedContact(contact);
    setMessages([]);
    setBody('');
    setSelectedFiles([]);
    setError('');
    shouldFollowThreadRef.current = true;
    pendingThreadScrollRef.current = true;
    lastThreadMessageKeyRef.current = null;
    setShowJumpToLatest(false);
    await refreshSelectedThread(contact);
  }

  async function sendMessage() {
    if (!selectedContact || sendLock.current) return;
    const text = body.trim();
    if (!text && selectedFiles.length === 0) return;

    sendLock.current = true;
    setSending(true);
    ++threadRequest.current;
    setDeliveryNotice('');
    setError('');
    try {
      const form = new FormData();
      form.append('staff_user_id', String(selectedContact.id));
      form.append('body', text);
      selectedFiles.forEach((file) => {
        form.append('files', {
          uri: file.uri,
          name: file.name,
          type: file.mimeType || 'application/octet-stream',
        } as unknown as Blob);
      });
      await apiFetch('/portal/messages/send', { method: 'POST', body: form }, token);
      setDeliveryNotice('Message sent.');
      setBody('');
      setSelectedFiles([]);
      forceScrollAfterSend.current = true;
      shouldFollowThreadRef.current = true;
      pendingThreadScrollRef.current = true;
      setShowJumpToLatest(false);
      await refreshSelectedThread(selectedContact, { silent: true, afterSend: true });
      requestThreadBottomScroll(true, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send message.');
    } finally {
      sendLock.current = false;
      setSending(false);
    }
  }

  async function pickAttachments() {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
        type: '*/*',
      });
      if (result.canceled) return;
      setSelectedFiles(result.assets.slice(0, 8).map((asset) => ({
        uri: asset.uri,
        name: asset.name || 'Attachment',
        mimeType: asset.mimeType,
        size: asset.size,
      })));
      scrollThreadToBottom(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not choose attachment.');
    }
  }

  async function openAttachment(documentId?: string | number) {
    if (!documentId) return;
    setError('');
    try {
      const data = await apiFetch<{ url?: string }>(`/portal/attachments/${encodeURIComponent(documentId)}/download`, {}, token);
      if (!data.url) throw new Error('Attachment link was not available.');
      await Linking.openURL(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open attachment.');
    }
  }

  useEffect(() => {
    loadContacts('');
    return () => scrollTimers.current.forEach(clearTimeout);
  }, []);
  useRefreshOnReturn(active, () => {
    if (sendLock.current) return;
    if (selectedContact) refreshSelectedThread(selectedContact, { silent: true }).catch(() => undefined);
    else loadContacts(search, { silent: true }).catch(() => undefined);
  });

  useEffect(() => {
    if (!active || selectedContact) return undefined;
    const timer = setTimeout(() => loadContacts(search), 250);
    return () => clearTimeout(timer);
  }, [search, selectedContact, active]);

  useEffect(() => {
    if (!active) return;
    const refreshActive = () => {
      if (AppState.currentState !== 'active' || sending) return;
      if (selectedContact) refreshSelectedThread(selectedContact, { silent: true }).catch(() => undefined);
      else loadContacts(search, { silent: true }).catch(() => undefined);
    };
    const interval = setInterval(refreshActive, 20000);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshActive();
    });
    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [selectedContact, search, sending, token, active]);

  useEffect(() => {
    if (!active || !selectedContact) return undefined;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const frameSub = Platform.OS === 'ios' ? Keyboard.addListener('keyboardWillChangeFrame', () => requestThreadBottomScroll(true, true)) : null;
    const showSub = Keyboard.addListener(showEvent, () => requestThreadBottomScroll(true, true));
    const hideSub = Keyboard.addListener(hideEvent, () => {
      if (shouldFollowThreadRef.current) scrollThreadToBottom(false);
    });
    return () => {
      frameSub?.remove();
      showSub.remove();
      hideSub.remove();
    };
  }, [selectedContact, active]);

  useEffect(() => {
    if (!selectedContact || messages.length === 0) return;
    if (forceScrollAfterSend.current) {
      forceScrollAfterSend.current = false;
      requestThreadBottomScroll(true, true);
      return;
    }
    if (shouldFollowThreadRef.current) scrollThreadToBottom(false);
  }, [messages.length, selectedContact]);

  const threadTitle = selectedContact ? (selectedContact.name || 'Your team') : 'Messages';
  const filteredContacts = contacts;

  const messagesWithDays = useMemo(() => {
    let lastDay = '';
    return messages.map((message) => {
      const day = messageDayLabel(message.created_at || message.createdAt);
      const showDay = Boolean(day && day !== lastDay);
      if (day) lastDay = day;
      return { message, day: showDay ? day : '' };
    });
  }, [messages]);

  if (selectedContact) {
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={0} style={styles.screen}>
        <View style={styles.chatHeader}>
          <Pressable onPress={() => { if (sendLock.current) return; selectedIdRef.current = null; ++threadRequest.current; setDeliveryNotice(''); setSelectedContact(null); shouldFollowThreadRef.current = true; pendingThreadScrollRef.current = false; lastThreadMessageKeyRef.current = null; setShowJumpToLatest(false); }} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
          <StaffAvatar name={threadTitle} url={selectedContact.avatar_url} size={44} />
          <View style={styles.headerTextWrap}>
            <Text numberOfLines={1} style={styles.chatTitle}>{threadTitle}</Text>
            <Text numberOfLines={1} style={styles.chatSubtitle}>Secure client chat</Text>
          </View>
        </View>

        {!!deliveryNotice && <Text accessibilityLiveRegion="polite" style={{ color: colors.gold2, padding: 12 }}>{deliveryNotice}</Text>}
        {loadingThread ? (
          <View style={styles.centerState}><ActivityIndicator color={colors.gold2} /><Text style={styles.muted}>Loading conversation…</Text></View>
        ) : (
          <FlatList
            ref={listRef}
            data={messagesWithDays}
            keyExtractor={({ message }, index) => String(message.id || `${message.created_at}-${index}`)}
            contentContainerStyle={messages.length ? styles.threadList : styles.emptyThreadList}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={handleThreadContentChange}
            onLayout={handleThreadContentChange}
            onScroll={handleThreadScroll}
            scrollEventThrottle={80}
            refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => refreshSelectedThread(selectedContact, { refreshing: true })} message="Refreshing conversation..." />}
            renderItem={({ item }) => {
              const message = item.message;
              const outgoing = message.sender_type === 'client';
              const attachmentCount = Array.isArray(message.attachments) ? message.attachments.length : 0;
              return (
                <View>
                  {!!item.day && <View style={styles.dayPill}><Text style={styles.dayText}>{item.day}</Text></View>}
                  <View style={[styles.messageRow, outgoing ? styles.outgoingRow : styles.incomingRow]}>
                    <View style={[styles.bubble, outgoing ? styles.outgoingBubble : styles.incomingBubble]}>
                      {!!message.body && <Text style={[styles.bubbleText, outgoing && styles.outgoingText]}>{message.body}</Text>}
                      {attachmentCount > 0 && <View style={styles.attachmentStack}>{message.attachments?.map((attachment, attachmentIndex) => (
                        <Pressable key={`${attachment.documentId || attachmentIndex}`} onPress={() => openAttachment(attachment.documentId)} style={[styles.attachmentChip, outgoing && styles.outgoingAttachmentChip]}>
                          <Text numberOfLines={1} style={[styles.attachmentText, outgoing && styles.outgoingText]}>📎 {attachment.displayName || 'Attachment'}</Text>
                        </Pressable>
                      ))}</View>}
                    </View>
                    <Text style={styles.bubbleMeta}>{outgoing ? 'You' : (message.sender_name || 'Your team')} · {formatMessageTime(message.created_at || message.createdAt)}</Text>
                  </View>
                </View>
              );
            }}
            ListEmptyComponent={<View style={styles.centerState}><Text style={styles.emptyIcon}>💬</Text><Text style={styles.emptyTitle}>No messages yet</Text><Text style={styles.muted}>Send a secure message to start the conversation.</Text></View>}
          />
        )}

        {showJumpToLatest && (
          <Pressable onPress={() => requestThreadBottomScroll(true, true)} style={styles.jumpToLatest}>
            <Text style={styles.jumpToLatestText}>Latest ↓</Text>
          </Pressable>
        )}

        {!!error && <Text style={styles.inlineError}>{error}</Text>}
        <View style={styles.composerWrap}>
          {selectedFiles.length > 0 && <View style={styles.selectedFilesRow}>{selectedFiles.map((file, index) => (
            <Pressable key={`${file.uri}-${index}`} onPress={() => setSelectedFiles((files) => files.filter((_, fileIndex) => fileIndex !== index))} style={styles.selectedFileChip}>
              <Text numberOfLines={1} style={styles.selectedFileText}>📎 {file.name}</Text>
              <Text style={styles.removeFileText}>×</Text>
            </Pressable>
          ))}</View>}
          <View style={styles.composerControls}>
          <Pressable disabled={sending} onPress={pickAttachments} style={styles.attachButton}><Text style={styles.attachText}>＋</Text></Pressable>
          <TextInput
            multiline
            onChangeText={setBody}
            placeholder="Secure message"
            placeholderTextColor="rgba(153,164,180,0.65)"
            onFocus={() => requestThreadBottomScroll(true, true)}
            style={styles.composerInput}
            editable={!sending}
              value={body}
          />
          <Pressable disabled={sending || (!body.trim() && selectedFiles.length === 0)} onPress={sendMessage} style={[styles.sendButton, (!body.trim() && selectedFiles.length === 0 || sending) && styles.sendDisabled]}>
            <Text style={styles.sendText}>↑</Text>
          </Pressable>
          </View>
        </View>
        <AppRefreshOverlay refreshing={refreshing} message="Refreshing conversation..." />
      </KeyboardAvoidingView>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.inboxHeader}>
        {onBackHome ? <Pressable onPress={onBackHome} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable> : null}
        <View style={{ flex: 1 }}>
          <Text style={styles.kicker}>Secure chat</Text>
          <Text style={styles.title}>Messages</Text>
        </View>
        <Pressable onPress={() => loadContacts()} style={styles.refreshButton}><Text style={styles.refreshText}>↻</Text></Pressable>
      </View>

      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={setSearch}
          placeholder="Search message content"
          placeholderTextColor="rgba(153,164,180,0.72)"
          returnKeyType="search"
          style={styles.searchInput}
          value={search}
        />
      </View>

      {loadingContacts ? (
        <View style={styles.centerState}><ActivityIndicator color={colors.gold2} /><Text style={styles.muted}>Loading team…</Text></View>
      ) : error ? (
        <View style={styles.centerState}><Text style={styles.emptyTitle}>Could not load messages</Text><Text style={styles.muted}>{error}</Text></View>
      ) : (
        <FlatList
          data={filteredContacts}
          keyExtractor={(item) => String(item.id)}
          contentContainerStyle={filteredContacts.length ? styles.inboxList : styles.emptyThreadList}
          refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => loadContacts(search, { refreshing: true })} message="Refreshing messages..." />}
          renderItem={({ item }) => {
            const unread = Number(item.unreadCount || 0);
            const name = item.name || 'Your team';
            return (
              <Pressable onPress={() => openThread(item)} style={({ pressed }) => [styles.contactRow, unread > 0 && styles.unreadContactRow, pressed && styles.pressedRow]}>
                <StaffAvatar name={name} url={item.avatar_url} />
                <View style={styles.contactMain}>
                  <View style={styles.contactTopLine}>
                    <Text numberOfLines={1} style={[styles.contactName, unread > 0 && styles.unreadName]}>{name}</Text>
                    {unread > 0 && <View style={styles.newMessagePill}><Text style={styles.newMessageText}>{unread > 1 ? `${unread} new` : 'New'}</Text></View>}
                  </View>
                  <View style={styles.contactBottomLine}>
                    <Text numberOfLines={1} style={styles.contactTitle}>{staffTitleText(item)}</Text>
                    <Text style={styles.chevron}>›</Text>
                  </View>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={<View style={styles.centerState}><Text style={styles.emptyIcon}>💬</Text><Text style={styles.emptyTitle}>{search.trim() ? 'No message matches' : 'No conversations yet'}</Text><Text style={styles.muted}>{search.trim() ? 'Try a topic or phrase from a message.' : 'Your secure chats will appear here.'}</Text></View>}
        />
      )}
      <AppRefreshOverlay refreshing={refreshing} message="Refreshing messages..." />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, paddingTop: 58 },
  inboxHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.sm, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  backButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)' },
  backText: { color: colors.gold2, fontSize: 34, lineHeight: 36, fontWeight: '700' },
  refreshButton: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.07)' },
  refreshText: { color: colors.gold2, fontSize: 20, fontWeight: '900' },
  kicker: { color: colors.gold, fontSize: 12, fontWeight: '900', letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 36, fontWeight: '900', letterSpacing: -1.4 },
  searchWrap: { marginHorizontal: spacing.md, marginBottom: spacing.sm, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.07)', paddingHorizontal: spacing.md, minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8 },
  searchIcon: { color: 'rgba(153,164,180,0.72)', fontSize: 16, fontWeight: '900' },
  searchInput: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '800', paddingVertical: 8 },
  inboxList: { paddingHorizontal: spacing.sm, paddingBottom: 34 },
  contactRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 78, paddingHorizontal: spacing.sm, borderRadius: radius.lg },
  unreadContactRow: { backgroundColor: 'rgba(201,168,76,0.07)' },
  pressedRow: { backgroundColor: 'rgba(255,255,255,0.055)' },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', backgroundColor: 'rgba(201,168,76,0.16)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.28)' },
  avatarImage: { width: 52, height: 52, resizeMode: 'cover' },
  avatarText: { color: colors.gold2, fontWeight: '900', fontSize: 15 },
  contactMain: { flex: 1, minWidth: 0, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.075)', paddingVertical: spacing.md },
  contactTopLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  contactBottomLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 4 },
  contactName: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '800' },
  unreadName: { fontWeight: '900' },
  contactTitle: { flex: 1, color: colors.muted, fontSize: 14, fontWeight: '700' },
  chevron: { color: 'rgba(153,164,180,0.55)', fontSize: 24, lineHeight: 24 },
  newMessagePill: { minHeight: 24, borderRadius: 12, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.gold },
  newMessageText: { color: '#11131a', fontSize: 12, fontWeight: '900' },
  headerTextWrap: { flex: 1, minWidth: 0 },
  chatTitle: { color: colors.text, fontSize: 18, fontWeight: '900' },
  chatSubtitle: { color: colors.muted, fontSize: 12, fontWeight: '700', marginTop: 2 },
  threadList: { padding: spacing.md, paddingBottom: 124 },
  emptyThreadList: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  dayPill: { alignItems: 'center', marginVertical: spacing.sm },
  dayText: { overflow: 'hidden', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, backgroundColor: 'rgba(255,255,255,0.075)', color: 'rgba(245,246,248,0.62)', fontSize: 11, fontWeight: '900' },
  messageRow: { marginBottom: 8 },
  outgoingRow: { alignItems: 'flex-end' },
  incomingRow: { alignItems: 'flex-start' },
  bubble: { maxWidth: '82%', borderRadius: 22, paddingHorizontal: 14, paddingVertical: 10 },
  outgoingBubble: { backgroundColor: colors.gold, borderBottomRightRadius: 6 },
  incomingBubble: { backgroundColor: 'rgba(255,255,255,0.105)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', borderBottomLeftRadius: 6 },
  bubbleText: { color: colors.text, fontSize: 16, lineHeight: 21 },
  outgoingText: { color: '#11131a' },
  attachmentStack: { gap: 6, marginTop: 7 },
  attachmentChip: { maxWidth: 230, borderRadius: 13, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(255,255,255,0.07)', paddingHorizontal: 10, paddingVertical: 7 },
  outgoingAttachmentChip: { borderColor: 'rgba(17,19,26,0.18)', backgroundColor: 'rgba(17,19,26,0.08)' },
  attachmentText: { color: colors.gold2, fontSize: 13, fontWeight: '900' },
  bubbleMeta: { color: 'rgba(153,164,180,0.68)', fontSize: 11, marginHorizontal: 8, marginTop: 3 },
  jumpToLatest: { position: 'absolute', right: spacing.md, bottom: 104, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(201,168,76,0.32)', backgroundColor: 'rgba(31,36,48,0.96)', paddingHorizontal: 14, paddingVertical: 9, shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 12, shadowOffset: { width: 0, height: 8 }, elevation: 6 },
  jumpToLatestText: { color: colors.gold2, fontSize: 13, fontWeight: '900' },
  composerWrap: { gap: 8, paddingHorizontal: spacing.sm, paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 22 : 10, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)', backgroundColor: 'rgba(17,20,29,0.96)' },
  composerControls: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  selectedFilesRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 2 },
  selectedFileChip: { maxWidth: '100%', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(201,168,76,0.24)', backgroundColor: 'rgba(201,168,76,0.12)', paddingHorizontal: 10, paddingVertical: 6 },
  selectedFileText: { maxWidth: 250, color: colors.gold2, fontSize: 12, fontWeight: '900' },
  removeFileText: { color: colors.gold2, fontSize: 16, fontWeight: '900', lineHeight: 17 },
  attachButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  attachText: { color: colors.gold2, fontSize: 24, lineHeight: 26 },
  composerInput: { flex: 1, maxHeight: 118, minHeight: 38, borderRadius: 19, paddingHorizontal: 14, paddingTop: 9, paddingBottom: 9, backgroundColor: 'rgba(255,255,255,0.075)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', color: colors.text, fontSize: 16 },
  sendButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.gold },
  sendDisabled: { opacity: 0.45 },
  sendText: { color: '#11131a', fontSize: 22, lineHeight: 24, fontWeight: '900' },
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  emptyIcon: { fontSize: 42 },
  emptyTitle: { color: colors.text, fontSize: 22, fontWeight: '900', textAlign: 'center' },
  inlineError: { color: colors.red, fontSize: 13, paddingHorizontal: spacing.md, paddingTop: 6 },
});
