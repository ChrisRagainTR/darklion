import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Icon } from '../components/Icon';
import { colors } from '../theme/tokens';
import { type ClientRef, staffApi, type StaffClientRow } from './staffApi';
import { Empty, ErrorLine, IconCircle, Initials, Loading, NavBar, st } from './ui';

// Pick a client, then open their documents in the same year and folder view.
export function StaffFindDocumentsScreen({ token, onBack, onPick }: { token: string; onBack: () => void; onPick: (ref: ClientRef) => void }) {
  const [rows, setRows] = useState<StaffClientRow[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { staffApi.clients(token).then(r => setRows(r.clients || [])).catch(e => setError(e instanceof Error ? e.message : 'Could not load clients.')); }, [token]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (rows || []).filter(r => !n || r.name.toLowerCase().includes(n) || r.email.toLowerCase().includes(n) || r.relationshipName.toLowerCase().includes(n)).slice(0, 60);
  }, [rows, q]);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <NavBar title="Find documents" onBack={onBack} backLabel="More" />
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={[st.body, { paddingTop: 14 }]}>
          <View style={st.search}>
            <Icon name="search" size={18} color={colors.muted} />
            <TextInput value={q} onChangeText={setQ} autoFocus placeholder="Whose documents?" placeholderTextColor="rgba(153,164,180,0.7)" style={st.searchInput} autoCorrect={false} clearButtonMode="while-editing" />
          </View>
          <ErrorLine text={error} />
          {!rows && !error ? <Loading /> : null}
          {rows && !shown.length ? <Empty text="No clients match." /> : null}
          {shown.map(r => (
            <Pressable key={r.type + r.id} onPress={() => onPick({ type: r.type, id: r.id, name: r.name })} style={({ pressed }) => [st.row, pressed && st.pressed]}>
              {r.type === 'company' ? <IconCircle name="building" size={36} /> : <Initials name={r.name} size={36} />}
              <View style={st.rowBody}><Text style={st.rowTitle} numberOfLines={1}>{r.name}</Text>{r.relationshipName ? <Text style={st.rowMeta}>{r.relationshipName}</Text> : null}</View>
              <Icon name="folder" size={18} color={colors.muted} />
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}


