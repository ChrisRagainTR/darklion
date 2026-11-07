import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppRefreshControl } from '../components/AppRefreshControl';
import { Icon } from '../components/Icon';
import { colors } from '../theme/tokens';
import { type ClientRef, staffApi, type StaffClientRow } from './staffApi';
import { Chips, Dot, Empty, ErrorLine, IconCircle, Initials, Loading, PageTitle, StaffHeader, st } from './ui';

type Filter = 'all' | 'waiting' | 'organizer' | 'ready';
type Props = { token: string; initials: string; active: boolean; onOpenClient: (ref: ClientRef) => void; onOpenMe: () => void };

const ENTITY: Record<string, string> = { s_corp: 'S corporation', c_corp: 'C corporation', partnership: 'Partnership', llc: 'LLC', sole_prop: 'Sole proprietor', nonprofit: 'Nonprofit', trust: 'Trust' };

export function StaffClientsScreen({ token, initials, active, onOpenClient, onOpenMe }: Props) {
  const [rows, setRows] = useState<StaffClientRow[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (opts: { refreshing?: boolean } = {}) => {
    if (opts.refreshing) setRefreshing(true);
    try { const r = await staffApi.clients(token); setRows(r.clients || []); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load clients.'); }
    finally { if (opts.refreshing) setRefreshing(false); }
  }, [token]);
  useEffect(() => { if (active) load(); }, [active, load]);

  const counts = useMemo(() => {
    const c = { waiting: 0, organizer: 0, ready: 0 };
    for (const r of rows || []) if (r.status?.bucket) c[r.status.bucket]++;
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const digits = needle.replace(/\D/g, '');
    return (rows || []).filter(r => {
      if (filter !== 'all' && r.status?.bucket !== filter) return false;
      if (!needle) return true;
      return r.name.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle) || r.relationshipName.toLowerCase().includes(needle)
        || (digits.length >= 3 && r.phone.replace(/\D/g, '').includes(digits));
    });
  }, [rows, q, filter]);

  const header = (
    <View>
      <StaffHeader initials={initials} onPressMe={onOpenMe} />
      <View style={st.body}>
        <PageTitle title="Clients" />
        <View style={[st.search, { marginTop: 12 }]}>
          <Icon name="search" size={18} color={colors.muted} />
          <TextInput value={q} onChangeText={setQ} placeholder="Search name, email, or phone" placeholderTextColor="rgba(153,164,180,0.7)" style={st.searchInput} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search" />
        </View>
        <View style={{ marginTop: 12 }}>
          <Chips<Filter> value={filter} onChange={setFilter} options={[
            { key: 'all', label: 'All' },
            { key: 'waiting', label: 'Waiting to sign', count: counts.waiting },
            { key: 'organizer', label: 'Organizer out', count: counts.organizer },
            { key: 'ready', label: 'Ready to e-file', count: counts.ready },
          ]} />
        </View>
        <ErrorLine text={error} onRetry={() => load()} />
        {!rows && !error ? <Loading /> : null}
        {rows ? <Text style={s.count}>{shown.length} {shown.length === 1 ? 'client' : 'clients'}</Text> : null}
      </View>
    </View>
  );

  return (
    <FlatList
      style={s.root}
      data={shown}
      keyExtractor={r => r.type + r.id}
      ListHeaderComponent={header}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={20}
      refreshControl={<AppRefreshControl refreshing={refreshing} onRefresh={() => load({ refreshing: true })} message="Refreshing…" />}
      ListEmptyComponent={rows ? <View style={st.body}><Empty text={q ? 'No clients match "' + q + '".' : 'No clients in this list.'} /></View> : null}
      renderItem={({ item }) => (
        <Pressable onPress={() => onOpenClient({ type: item.type, id: item.id, name: item.name })} style={({ pressed }) => [st.row, s.row, pressed && st.pressed]}>
          {item.type === 'company' ? <IconCircle name="building" /> : <Initials name={item.name} />}
          <View style={st.rowBody}>
            <Text style={st.rowTitle} numberOfLines={1}>{item.name}</Text>
            <Text style={s.sub} numberOfLines={1}>{item.status ? item.status.label : item.type === 'company' ? (ENTITY[item.entityType || ''] || 'Company') : (item.relationshipName || item.email || 'Person')}</Text>
          </View>
          {item.status ? <Dot tone={item.status.tone} /> : null}
          <Icon name="chevron" size={16} color={colors.muted} />
        </Pressable>
      )}
    />
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  count: { color: colors.muted, fontSize: 13, marginTop: 16, marginBottom: 2 },
  row: { marginHorizontal: 20 },
  sub: { color: colors.muted, fontSize: 13.5 },
});

