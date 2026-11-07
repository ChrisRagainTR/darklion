import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme/tokens';
import { Icon } from './Icon';

// Documents grouped by side (team or client), then year chips, then folder accordions.
// Shared by the client app and the advisor app so both behave the same way.

export type BrowserDoc = {
  id: string | number;
  name: string;
  year: string;
  side: 'team' | 'client';
  folderKey: string;
  folderLabel: string;
  folderOrder: number;
  date: string | null;
  size: number;
  mime: string;
  viewed: boolean;
  isNew: boolean;
};

type RawDoc = {
  id: string | number;
  display_name?: string; displayName?: string; name?: string;
  year?: string | number | null;
  folder_section?: string | null; folderSection?: string | null;
  folder_category?: string | null; folderCategory?: string | null;
  folder_subcategory?: string | null; folderSubcategory?: string | null;
  doc_type?: string | null; docType?: string | null;
  uploaded_by_type?: string | null; uploadedByType?: string | null;
  created_at?: string | null; createdAt?: string | null;
  delivered_at?: string | null; deliveredAt?: string | null;
  viewed_at?: string | null; viewedAt?: string | null;
  size_bytes?: number | null; sizeBytes?: number | null; size?: number | null;
  mime_type?: string | null; mimeType?: string | null;
};

const MAIN_FOLDERS: Record<string, [string, number]> = {
  tax: ['Tax', 0], bookkeeping: ['Bookkeeping', 1], ias: ['Investments', 2], engagement_letter: ['Engagement letters', 3], other: ['Other', 9],
};
const NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Same folders and "new" rule as the web portal: new means shared by the team in the last 30 days and not opened.
export function toBrowserDoc(d: RawDoc, now = Date.now()): BrowserDoc {
  const section = d.folder_section ?? d.folderSection ?? null;
  const uploader = String(d.uploaded_by_type ?? d.uploadedByType ?? '').toLowerCase();
  const side: 'team' | 'client' = section ? (section === 'client_uploaded' ? 'client' : 'team') : (uploader === 'client' ? 'client' : 'team');
  const rawCat = String(d.folder_category ?? d.folderCategory ?? '').toLowerCase();
  const docType = String(d.doc_type ?? d.docType ?? '').toLowerCase();
  const cat = docType === 'engagement_letter' || rawCat === 'engagement_letter' ? 'engagement_letter' : MAIN_FOLDERS[rawCat] ? rawCat : 'other';
  const sub = String(d.folder_subcategory ?? d.folderSubcategory ?? '').trim();
  const [label, order] = sub ? [sub, 5] : MAIN_FOLDERS[cat];
  const viewedAt = d.viewed_at ?? d.viewedAt ?? null;
  const date = d.delivered_at ?? d.deliveredAt ?? d.created_at ?? d.createdAt ?? null;
  const added = date ? new Date(date).getTime() : 0;
  return {
    id: d.id,
    name: d.display_name || d.displayName || d.name || 'Document',
    year: d.year ? String(d.year) : 'Undated',
    side,
    folderKey: sub ? 'sub:' + sub.toLowerCase() : cat,
    folderLabel: label,
    folderOrder: order,
    date,
    size: Number(d.size_bytes ?? d.sizeBytes ?? d.size ?? 0) || 0,
    mime: String(d.mime_type ?? d.mimeType ?? ''),
    viewed: Boolean(viewedAt),
    isNew: side === 'team' && !viewedAt && added > 0 && now - added <= NEW_WINDOW_MS,
  };
}

const byYearDesc = (a: string, b: string) => Number(a === 'Undated') - Number(b === 'Undated') || b.localeCompare(a);
const time = (d: BrowserDoc) => (d.date ? new Date(d.date).getTime() : 0);

// Pure: years and folders for one side, plus the starting year and open folders.
export function organize(docs: BrowserDoc[], side: 'team' | 'client', year?: string | null) {
  const mine = docs.filter(d => d.side === side);
  const years = Array.from(new Set(mine.map(d => d.year))).sort(byYearDesc);
  const newYear = years.find(y => mine.some(d => d.year === y && d.isNew));
  const activeYear = year && years.includes(year) ? year : newYear || years[0] || '';
  const inYear = mine.filter(d => d.year === activeYear).sort((a, b) => time(b) - time(a));
  const map = new Map<string, { key: string; label: string; order: number; docs: BrowserDoc[] }>();
  for (const d of inYear) {
    const f = map.get(d.folderKey) || { key: d.folderKey, label: d.folderLabel, order: d.folderOrder, docs: [] };
    f.docs.push(d);
    map.set(d.folderKey, f);
  }
  const folders = Array.from(map.values()).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  return { years, activeYear, folders, newFolderKeys: folders.filter(f => f.docs.some(d => d.isNew)).map(f => f.key) };
}

function badge(d: BrowserDoc): [string, string] {
  const ext = (d.name.split('.').pop() || '').toLowerCase();
  const m = d.mime.toLowerCase();
  if (m.includes('pdf') || ext === 'pdf') return ['PDF', '#d64545'];
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv') || ['xls', 'xlsx', 'csv'].includes(ext)) return ['XLS', '#2f9e63'];
  if (m.includes('word') || ['doc', 'docx'].includes(ext)) return ['DOC', '#3d74c9'];
  if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'heic', 'gif'].includes(ext)) return ['IMG', '#6b7385'];
  return [(ext || 'FILE').slice(0, 4).toUpperCase(), '#6b7385'];
}
function fmtDate(v: string | null) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtSize(n: number) {
  if (!n) return '';
  return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
}

type Props = {
  docs: BrowserDoc[];
  side: 'team' | 'client';
  onSideChange: (s: 'team' | 'client') => void;
  sideLabels: { team: string; client: string };
  // Client app shows "New"; the advisor app shows whether the client opened each file.
  audience: 'client' | 'staff';
  onOpen: (d: BrowserDoc) => void;
  openingId?: string | number | null;
  onUpload?: (year: string) => void;
  uploadLabel?: string;
  emptyText: { team: string; client: string };
};

export function DocumentBrowser({ docs, side, onSideChange, sideLabels, audience, onOpen, openingId, onUpload, uploadLabel, emptyText }: Props) {
  const [yearBySide, setYearBySide] = useState<Record<string, string | null>>({ team: null, client: null });
  const [openBySide, setOpenBySide] = useState<Record<string, Set<string> | null>>({ team: null, client: null });
  const view = useMemo(() => organize(docs, side, yearBySide[side]), [docs, side, yearBySide]);
  const open = openBySide[side + ':' + view.activeYear] ?? new Set(view.newFolderKeys);

  function toggle(key: string) {
    const k = side + ':' + view.activeYear;
    const next = new Set(open);
    if (next.has(key)) next.delete(key); else next.add(key);
    setOpenBySide(o => ({ ...o, [k]: next }));
  }

  return (
    <View>
      <View style={s.seg}>
        {(['team', 'client'] as const).map(k => {
          const on = k === side;
          const newCount = k === 'team' && audience === 'client' ? docs.filter(d => d.isNew).length : 0;
          return (
            <Pressable key={k} accessibilityRole="button" accessibilityLabel={sideLabels[k]} accessibilityState={{ selected: on }} onPress={() => onSideChange(k)} style={[s.segItem, on && s.segOn]}>
              <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} style={[s.segText, on && s.segTextOn]}>{sideLabels[k]}{newCount ? ' · ' + newCount + ' new' : ''}</Text>
            </Pressable>
          );
        })}
      </View>

      {view.years.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipsWrap} contentContainerStyle={s.chips}>
          {view.years.map(y => {
            const on = y === view.activeYear;
            return (
              <Pressable key={y} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setYearBySide(v => ({ ...v, [side]: y }))} style={[s.chip, on && s.chipOn]}>
                <Text style={[s.chipText, on && s.chipTextOn]}>{y}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      {!view.folders.length ? <Text style={s.empty}>{emptyText[side]}</Text> : null}

      <View style={s.list}>
        {view.folders.map(f => {
          const isOpen = open.has(f.key);
          const newCount = audience === 'client' ? f.docs.filter(d => d.isNew).length : 0;
          return (
            <View key={f.key}>
              <Pressable accessibilityRole="button" accessibilityState={{ expanded: isOpen }} accessibilityLabel={f.label + ', ' + f.docs.length + (f.docs.length === 1 ? ' file' : ' files') + (newCount ? ', ' + newCount + ' new' : '')}
                onPress={() => toggle(f.key)} style={({ pressed }) => [s.folder, pressed && s.pressed]}>
                <Icon name="folder" size={22} color={colors.gold2} />
                <Text style={s.folderName} numberOfLines={1}>{f.label}</Text>
                {newCount ? <View style={s.newPill}><Text style={s.newText}>{newCount} new</Text></View> : null}
                <Text style={s.count}>{f.docs.length} {f.docs.length === 1 ? 'file' : 'files'}</Text>
                <Icon name="chevron" size={16} color={colors.muted} style={{ transform: [{ rotate: isOpen ? '90deg' : '0deg' }] }} />
              </Pressable>
              {isOpen ? (
                <View style={s.files}>
                  {f.docs.map(d => {
                    const [label, color] = badge(d);
                    const meta = [fmtDate(d.date), fmtSize(d.size)].filter(Boolean).join(' · ');
                    return (
                      <Pressable key={String(d.id)} accessibilityRole="button" accessibilityLabel={'Open ' + d.name} onPress={() => onOpen(d)} style={({ pressed }) => [s.file, pressed && s.pressed]}>
                        <View style={[s.badge, { backgroundColor: color }]}><Text style={s.badgeText}>{label}</Text></View>
                        <View style={s.fileBody}>
                          <Text style={s.fileName} numberOfLines={2}>{d.name}</Text>
                          {meta ? <Text style={s.meta}>{meta}</Text> : null}
                        </View>
                        {String(openingId) === String(d.id) ? <ActivityIndicator color={colors.gold2} />
                          : audience === 'client' ? (d.isNew ? <View style={s.newPill}><Text style={s.newText}>New</Text></View> : null)
                          : d.side === 'team' ? <Text style={[s.viewed, !d.viewed && { color: colors.amber }]}>{d.viewed ? 'Viewed' : 'Not opened'}</Text> : null}
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          );
        })}
      </View>

      {onUpload ? (
        <Pressable accessibilityRole="button" onPress={() => onUpload(view.activeYear)} style={({ pressed }) => [s.upload, pressed && { opacity: 0.8 }]}>
          <Icon name="upload" size={18} color={colors.gold2} />
          <Text style={s.uploadText}>{uploadLabel || 'Upload a document'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  seg: { flexDirection: 'row', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)', borderRadius: 10, padding: 3 },
  segItem: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.goldBtn },
  segText: { color: colors.text2, fontSize: 14, fontWeight: '600' },
  segTextOn: { color: '#15171d' },
  chipsWrap: { marginTop: 12, marginHorizontal: -20 },
  chips: { gap: 8, paddingHorizontal: 20 },
  chip: { borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', borderRadius: 18, paddingHorizontal: 16, height: 34, justifyContent: 'center' },
  chipOn: { backgroundColor: colors.goldBtn, borderColor: colors.goldBtn },
  chipText: { color: colors.text2, fontSize: 14, fontWeight: '600' },
  chipTextOn: { color: '#15171d' },
  list: { marginTop: 10 },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.12)' },
  folderName: { flex: 1, color: colors.text, fontSize: 16.5, fontWeight: '500' },
  count: { color: colors.muted, fontSize: 13 },
  files: { marginLeft: 10, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: 'rgba(212,178,90,0.55)', marginBottom: 6 },
  file: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 11, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(255,255,255,0.08)' },
  badge: { width: 34, height: 22, borderRadius: 5, alignItems: 'center', justifyContent: 'center' },
  badgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  fileBody: { flex: 1, minWidth: 0, gap: 2 },
  fileName: { color: colors.text, fontSize: 15, lineHeight: 20 },
  meta: { color: colors.muted, fontSize: 12.5 },
  newPill: { backgroundColor: colors.goldBtn, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  newText: { color: '#15171d', fontSize: 11.5, fontWeight: '700' },
  viewed: { color: colors.green, fontSize: 12.5 },
  pressed: { backgroundColor: 'rgba(255,255,255,0.04)' },
  empty: { color: colors.muted, fontSize: 14.5, lineHeight: 20, paddingVertical: 20 },
  upload: { marginTop: 22, height: 48, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(201,168,76,0.6)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  uploadText: { color: colors.gold2, fontSize: 16, fontWeight: '600' },
});
