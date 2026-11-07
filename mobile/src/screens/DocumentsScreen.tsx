import { useEffect, useMemo, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { WebView } from 'react-native-webview';
import { apiBaseUrl, apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { type BrowserDoc, DocumentBrowser, toBrowserDoc } from '../components/DocumentBrowser';
import { Icon } from '../components/Icon';
import { Notice, text } from '../components/ui';
import { useRefreshOnReturn } from '../hooks/useRefreshOnReturn';
import { colors } from '../theme/tokens';
import type { PortalDocument } from '../types/api';

type Props = { active?: boolean; token: string; onBackHome?: () => void };
type Viewer = { title: string; url: string };

const TOP = Math.max(Constants.statusBarHeight || 0, 20);

export function chooseUploadFolder(title: string): Promise<'tax' | 'bookkeeping' | 'other' | null> {
  const keys = ['tax', 'bookkeeping', 'other'] as const;
  const labels = ['Tax', 'Bookkeeping', 'Other'];
  return new Promise(resolve => {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions({ title, options: [...labels, 'Cancel'], cancelButtonIndex: 3 }, i => resolve(i < 3 ? keys[i] : null));
    } else {
      Alert.alert(title, undefined, [...labels.map((l, i) => ({ text: l, onPress: () => resolve(keys[i]) })), { text: 'Cancel', style: 'cancel' as const, onPress: () => resolve(null) }]);
    }
  });
}

export function DocumentsScreen({ active = true, token }: Props) {
  const [documents, setDocuments] = useState<PortalDocument[] | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | number | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [side, setSide] = useState<'team' | 'client'>('team');
  const [uploading, setUploading] = useState('');
  const [companies, setCompanies] = useState<Record<string, string>>({});

  async function load(opts: { refreshing?: boolean } = {}) {
    if (opts.refreshing) setRefreshing(true);
    try {
      const result = await apiFetch<PortalDocument[]>('/portal/documents', {}, token);
      setDocuments(Array.isArray(result) ? result : []);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load documents.');
    } finally {
      if (opts.refreshing) setRefreshing(false);
    }
  }

  useEffect(() => {
    load();
    apiFetch<Array<{ id: number; company_name?: string }>>('/portal/companies', {}, token)
      .then(rows => setCompanies(Object.fromEntries((Array.isArray(rows) ? rows : []).map(c => [String(c.id), c.company_name || 'Business']))))
      .catch(() => undefined);
  }, []);
  useRefreshOnReturn(active, () => { if (!viewer) load().catch(() => undefined); });
  useEffect(() => {
    if (!active) return;
    const tick = () => { if (AppState.currentState === 'active' && !viewer) load().catch(() => undefined); };
    const interval = setInterval(tick, 30000);
    const sub = AppState.addEventListener('change', s => { if (s === 'active') tick(); });
    return () => { clearInterval(interval); sub.remove(); };
  }, [viewer, token, active]);

  // Business documents get one folder per business so they don't mix with personal tax files.
  const docs = useMemo(() => (documents || []).map(d => {
    const b = toBrowserDoc(d);
    const owner = String(d.owner_type || d.ownerType || '');
    const ownerId = String(d.owner_id ?? d.ownerId ?? '');
    return owner === 'company' ? { ...b, folderKey: 'co:' + ownerId, folderLabel: companies[ownerId] || 'Business', folderOrder: 6 } : b;
  }), [documents, companies]);

  async function open(doc: BrowserDoc) {
    if (openingId) return;
    setOpeningId(doc.id);
    try {
      const data = await apiFetch<{ url?: string }>('/portal/documents/' + encodeURIComponent(String(doc.id)) + '/download', {}, token);
      if (!data.url) throw new Error('The document link was not available.');
      setViewer({ title: doc.name, url: data.url });
      const now = new Date().toISOString();
      setDocuments(prev => (prev || []).map(d => String(d.id) === String(doc.id) ? { ...d, viewed_at: d.viewed_at || now } : d));
    } catch (err) {
      Alert.alert('Could not open', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setOpeningId(null);
    }
  }

  async function upload(year?: string) {
    const folder = await chooseUploadFolder('Which folder is this for?');
    if (!folder) return;
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true, type: '*/*' });
    if (picked.canceled || !picked.assets?.length) return;
    const files = picked.assets.slice(0, 10);
    const uploadYear = year && /^\d{4}$/.test(year) ? year : String(new Date().getFullYear() - 1);
    let done = 0;
    try {
      for (const f of files) {
        setUploading(files.length > 1 ? 'Uploading ' + (done + 1) + ' of ' + files.length + '…' : 'Uploading…');
        const form = new FormData();
        form.append('year', uploadYear);
        form.append('folder_category', folder);
        form.append('file', { uri: f.uri, name: f.name || 'document', type: f.mimeType || 'application/octet-stream' } as unknown as Blob);
        const res = await fetch(apiBaseUrl() + '/portal/upload', { method: 'POST', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, body: form });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((done ? done + ' uploaded; ' : '') + (f.name || 'File') + ': ' + (typeof body?.error === 'string' ? body.error : 'upload failed'));
        done++;
      }
      setSide('client');
      Alert.alert(done === 1 ? 'Uploaded' : done + ' files uploaded', 'Your team can see ' + (done === 1 ? 'it' : 'them') + ' now.');
    } catch (err) {
      Alert.alert('Upload stopped', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setUploading('');
      load().catch(() => undefined);
    }
  }

  return (
    <>
      <Modal visible={Boolean(viewer)} animationType="slide" presentationStyle="fullScreen" onRequestClose={() => setViewer(null)}>
        <View style={s.viewerRoot}>
          <View style={s.viewerHeader}>
            <Pressable onPress={() => setViewer(null)} style={s.viewerBtn} hitSlop={8}><Text style={s.viewerBtnText}>Done</Text></Pressable>
            <Text numberOfLines={1} style={s.viewerTitle}>{viewer?.title || 'Document'}</Text>
            <Pressable onPress={() => viewer?.url && Linking.openURL(viewer.url)} style={s.viewerBtn} hitSlop={8}><Text style={[s.viewerBtnText, { color: colors.gold2 }]}>Share</Text></Pressable>
          </View>
          {viewer?.url ? <WebView style={{ flex: 1, backgroundColor: colors.bg }} source={{ uri: viewer.url }} startInLoadingState renderLoading={() => <View style={s.center}><ActivityIndicator color={colors.gold2} /></View>} /> : null}
        </View>
      </Modal>
      <ScrollView style={s.root} contentContainerStyle={s.body} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing documents…" />}>
        <View style={s.head}>
          <Text style={text.h1}>Documents</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Upload a document" disabled={Boolean(uploading)} onPress={() => upload()} style={s.uploadBtn}>
            <Icon name="upload" size={20} color={colors.gold2} />
          </Pressable>
        </View>
        {uploading ? <View style={s.uploading}><ActivityIndicator color={colors.gold2} /><Text style={text.hint}>{uploading}</Text></View> : null}
        {error ? <Notice text={error} action="Try again" onAction={() => load()} /> : null}
        {!documents && !error ? <View style={s.center}><ActivityIndicator color={colors.gold2} /></View> : null}
        {documents ? (
          <View style={{ marginTop: 16 }}>
            <DocumentBrowser docs={docs} side={side} onSideChange={setSide} audience="client"
              sideLabels={{ team: 'From your team', client: 'From you' }}
              onOpen={open} openingId={openingId}
              onUpload={side === 'client' ? year => upload(year) : undefined}
              emptyText={{ team: 'Nothing from your team yet. When we share a document with you, it shows up here.', client: "You haven't uploaded anything yet." }} />
          </View>
        ) : null}
      </ScrollView>
    </>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  body: { paddingHorizontal: 20, paddingTop: TOP + 16, paddingBottom: 40 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  uploadBtn: { width: 42, height: 42, borderRadius: 21, borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)', alignItems: 'center', justifyContent: 'center' },
  uploading: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12 },
  center: { paddingVertical: 40, alignItems: 'center' },
  viewerRoot: { flex: 1, backgroundColor: colors.bg },
  viewerHeader: { paddingTop: TOP + 6, paddingHorizontal: 16, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.14)' },
  viewerBtn: { minWidth: 56, minHeight: 40, justifyContent: 'center' },
  viewerBtnText: { color: colors.text, fontSize: 16, fontWeight: '600' },
  viewerTitle: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '600', textAlign: 'center' },
});
