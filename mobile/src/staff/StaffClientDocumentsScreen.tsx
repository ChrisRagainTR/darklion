import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { apiBaseUrl, apiFetch } from '../api/client';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { type BrowserDoc, DocumentBrowser, toBrowserDoc } from '../components/DocumentBrowser';
import { Icon } from '../components/Icon';
import { chooseUploadFolder } from '../screens/DocumentsScreen';
import { colors } from '../theme/tokens';
import type { ClientRef } from './staffApi';
import { ErrorLine, Loading, NavBar, st } from './ui';

type Doc = { id: number; display_name: string; year: string; folder_section: string | null; folder_category: string | null; folder_subcategory?: string; doc_type?: string | null; created_at: string | null; delivered_at?: string | null; viewed_at: string | null; size_bytes: number; mime_type: string; uploaded_by_type?: string | null };

export function StaffClientDocumentsScreen({ token, client, onBack }: { token: string; client: ClientRef; onBack: () => void }) {
  const [raw, setRaw] = useState<Doc[] | null>(null);
  const [error, setError] = useState('');
  const [side, setSide] = useState<'team' | 'client'>('team');
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [openingId, setOpeningId] = useState<string | number | null>(null);

  const load = useCallback(async (opts: { refreshing?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try {
      const r = await apiFetch<{ documents?: Doc[] }>('/api/documents/mobile-index?owner_type=' + client.type + '&owner_id=' + client.id, {}, token);
      setRaw(r.documents || []); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load documents.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token, client.type, client.id]);
  useEffect(() => { load(); }, [load]);

  const docs = useMemo(() => (raw || []).map(d => toBrowserDoc(d)), [raw]);

  async function open(d: BrowserDoc) {
    setOpeningId(d.id);
    try {
      const r = await apiFetch<{ url?: string }>('/api/documents/' + d.id + '/download', {}, token);
      if (!r.url) throw new Error('The document link was not available.');
      await Linking.openURL(r.url);
    } catch (e) { Alert.alert('Could not open', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setOpeningId(null); }
  }

  async function upload(year?: string) {
    const folder = await chooseUploadFolder('Share with ' + (client.name || 'the client') + ' in');
    if (!folder) return;
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (picked.canceled || !picked.assets?.[0]) return;
    const file = picked.assets[0];
    setUploading(true);
    try {
      const form = new FormData();
      form.append('owner_type', client.type);
      form.append('owner_id', String(client.id));
      form.append('year', year && /^\d{4}$/.test(year) ? year : String(new Date().getFullYear() - 1));
      form.append('folder_section', 'firm_uploaded');
      form.append('folder_category', folder);
      form.append('display_name', file.name || 'Document');
      form.append('file', { uri: file.uri, name: file.name || 'document', type: file.mimeType || 'application/octet-stream' } as unknown as Blob);
      const res = await fetch(apiBaseUrl() + '/api/documents/upload', { method: 'POST', headers: { Accept: 'application/json', Authorization: 'Bearer ' + token }, body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'Upload failed (' + res.status + ')');
      setSide('team');
      await load();
    } catch (e) { Alert.alert('Upload failed', e instanceof Error ? e.message : 'Please try again.'); }
    finally { setUploading(false); }
  }

  return (
    <View style={s.root}>
      <NavBar title="Documents" subtitle={client.name} onBack={onBack} backLabel="Client"
        right={<Pressable accessibilityRole="button" accessibilityLabel="Upload a document" disabled={uploading} onPress={() => upload()} hitSlop={10} style={{ opacity: uploading ? 0.4 : 1 }}><Icon name="upload" size={22} color={colors.gold2} /></Pressable>} />
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}>
        <View style={[st.body, { paddingTop: 14 }]}>
          <ErrorLine text={error} onRetry={() => load()} />
          {!raw && !error ? <Loading /> : null}
          {uploading ? <Loading label="Uploading…" /> : null}
          {raw ? (
            <DocumentBrowser docs={docs} side={side} onSideChange={setSide} audience="staff"
              sideLabels={{ team: 'From us', client: 'From client' }}
              onOpen={open} openingId={openingId}
              onUpload={side === 'team' ? year => upload(year) : undefined} uploadLabel="Share a document"
              emptyText={{ team: 'Nothing shared with this client yet.', client: 'The client has not uploaded anything yet.' }} />
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({ root: { flex: 1, backgroundColor: colors.bg } });

