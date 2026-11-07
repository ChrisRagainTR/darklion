import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { apiFetch } from '../api/client';
import { PrimaryButton } from '../components/PrimaryButton';
import { colors, radius, spacing } from '../theme/tokens';
import type { PipelineInstance, PipelineInstanceDetail, PipelineJob, PipelineStage } from '../types/api';

type Props = {
  token: string;
  onBackHome: () => void;
};

function formatDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function instanceTitle(instance?: PipelineInstance | PipelineInstanceDetail | null) {
  const detail = instance as PipelineInstanceDetail | null | undefined;
  return instance?.name || instance?.template_name || detail?.template?.name || 'Pipeline';
}

function entityLabel(job: PipelineJob) {
  return job.entity_name || job.company_name || job.person_name || job.relationship_name || `${job.entity_type || 'Entity'} #${job.entity_id || ''}`.trim();
}

function priorityColor(priority?: string | null) {
  if (priority === 'urgent' || priority === 'high') return colors.red;
  if (priority === 'low') return colors.muted;
  return colors.gold2;
}

export function StaffPipelinesScreen({ token, onBackHome }: Props) {
  const [instances, setInstances] = useState<PipelineInstance[]>([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | number | null>(null);
  const [detail, setDetail] = useState<PipelineInstanceDetail | null>(null);
  const [selectedJob, setSelectedJob] = useState<PipelineJob | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updateBody, setUpdateBody] = useState('');
  const [error, setError] = useState('');

  const selectedInstance = useMemo(() => instances.find((item) => String(item.id) === String(selectedInstanceId)) || null, [instances, selectedInstanceId]);
  const jobsByStage = useMemo(() => {
    const map = new Map<string, PipelineJob[]>();
    (detail?.jobs || []).forEach((job) => {
      const key = String(job.current_stage_id || 'none');
      map.set(key, [...(map.get(key) || []), job]);
    });
    return map;
  }, [detail]);

  async function loadInstances() {
    setError('');
    setLoadingList(true);
    try {
      const rows = await apiFetch<PipelineInstance[]>('/api/pipelines/instances', {}, token);
      setInstances(Array.isArray(rows) ? rows : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pipelines.');
    } finally {
      setLoadingList(false);
    }
  }

  async function openInstance(instanceId: string | number) {
    setSelectedInstanceId(instanceId);
    setDetail(null);
    setSelectedJob(null);
    setError('');
    setLoadingDetail(true);
    try {
      const data = await apiFetch<PipelineInstanceDetail>(`/api/pipelines/instances/${instanceId}`, {}, token);
      setDetail(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load pipeline.');
    } finally {
      setLoadingDetail(false);
    }
  }

  async function reloadDetail() {
    if (!selectedInstanceId) return;
    const data = await apiFetch<PipelineInstanceDetail>(`/api/pipelines/instances/${selectedInstanceId}`, {}, token);
    setDetail(data);
    if (selectedJob) {
      const fresh = data.jobs?.find((job) => String(job.id) === String(selectedJob.id)) || null;
      setSelectedJob(fresh);
    }
  }

  async function moveJob(stage: PipelineStage) {
    if (!selectedJob?.id || !stage.id || String(selectedJob.current_stage_id) === String(stage.id)) return;
    setError('');
    setSaving(true);
    try {
      await apiFetch(`/api/pipelines/jobs/${selectedJob.id}/move`, {
        method: 'POST',
        body: JSON.stringify({ stage_id: stage.id, note: 'Moved from native mobile app' }),
      }, token);
      await reloadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move card.');
    } finally {
      setSaving(false);
    }
  }

  async function addUpdate() {
    if (!selectedJob?.id || !updateBody.trim()) return;
    setError('');
    setSaving(true);
    try {
      await apiFetch(`/api/pipelines/jobs/${selectedJob.id}/updates`, {
        method: 'POST',
        body: JSON.stringify({ body: updateBody.trim() }),
      }, token);
      setUpdateBody('');
      await reloadDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add update.');
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    loadInstances();
  }, []);

  if (selectedJob) {
    const currentStage = detail?.stages?.find((stage) => String(stage.id) === String(selectedJob.current_stage_id));
    return (
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.flex} keyboardVerticalOffset={0}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.wrap}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Pressable onPress={() => setSelectedJob(null)} style={styles.backButton}><Text style={styles.backText}>←</Text></Pressable>
            <View style={styles.headerText}>
              <Text style={styles.kicker}>Pipeline card</Text>
              <Text style={styles.title} numberOfLines={2}>{entityLabel(selectedJob)}</Text>
              <Text style={styles.muted}>{currentStage?.name || 'No stage'} · {selectedJob.job_status || 'active'}</Text>
            </View>
          </View>
          {!!error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Card details</Text>
            <View style={styles.detailGrid}>
              <View style={styles.detailPill}><Text style={styles.detailLabel}>Priority</Text><Text style={[styles.detailValue, { color: priorityColor(selectedJob.priority) }]}>{selectedJob.priority || 'normal'}</Text></View>
              <View style={styles.detailPill}><Text style={styles.detailLabel}>Assigned</Text><Text style={styles.detailValue}>{selectedJob.assigned_name || selectedJob.assigned_full_name || 'Unassigned'}</Text></View>
              <View style={styles.detailPill}><Text style={styles.detailLabel}>Due</Text><Text style={styles.detailValue}>{formatDate(selectedJob.due_date) || 'No date'}</Text></View>
              <View style={styles.detailPill}><Text style={styles.detailLabel}>Type</Text><Text style={styles.detailValue}>{selectedJob.crm_entity_type || selectedJob.entity_type || 'Entity'}</Text></View>
            </View>
            {!!selectedJob.notes && <Text style={styles.notes}>{selectedJob.notes}</Text>}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Move card</Text>
            <View style={styles.stageMoveList}>
              {(detail?.stages || []).map((stage) => {
                const active = String(stage.id) === String(selectedJob.current_stage_id);
                return (
                  <Pressable key={String(stage.id)} disabled={saving || active} onPress={() => moveJob(stage)} style={[styles.stageMoveButton, active && styles.stageMoveActive]}>
                    <Text style={[styles.stageMoveText, active && styles.stageMoveTextActive]}>{stage.name}</Text>
                    <Text style={styles.stageMoveMeta}>{active ? 'Current' : 'Move here'}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Recent updates</Text>
            {selectedJob.recent_updates?.length ? selectedJob.recent_updates.map((update) => (
              <View key={String(update.id)} style={styles.updateRow}>
                <Text style={styles.updateAuthor}>{update.author_name || 'Staff'} · {formatDate(update.created_at)}</Text>
                <Text style={styles.updateBody}>{update.body}</Text>
              </View>
            )) : <Text style={styles.muted}>No updates yet.</Text>}
          </View>
        </ScrollView>

        <View style={styles.composer}>
          <TextInput
            multiline
            onChangeText={setUpdateBody}
            placeholder="Add a card update…"
            placeholderTextColor="rgba(153,164,180,0.62)"
            style={styles.updateInput}
            value={updateBody}
          />
          <PrimaryButton disabled={saving || !updateBody.trim()} title={saving ? 'Saving…' : 'Add update'} onPress={addUpdate} />
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (selectedInstanceId) {
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <View style={styles.header}>
          <Pressable onPress={() => { setSelectedInstanceId(null); setDetail(null); }} style={styles.backButton}><Text style={styles.backText}>←</Text></Pressable>
          <View style={styles.headerText}>
            <Text style={styles.kicker}>Pipelines</Text>
            <Text style={styles.title} numberOfLines={2}>{instanceTitle(detail || selectedInstance)}</Text>
            <Text style={styles.muted}>{detail?.tax_year || selectedInstance?.tax_year || 'No year'} · {detail?.jobs?.length || selectedInstance?.job_count || 0} cards</Text>
          </View>
        </View>
        {!!error && <Text style={styles.error}>{error}</Text>}
        {loadingDetail ? (
          <View style={styles.loadingCard}><ActivityIndicator color={colors.gold2} /><Text style={styles.muted}>Loading pipeline…</Text></View>
        ) : (
          <View style={styles.stageList}>
            {(detail?.stages || []).map((stage) => {
              const jobs = jobsByStage.get(String(stage.id)) || [];
              return (
                <View key={String(stage.id)} style={styles.stageCard}>
                  <View style={styles.stageHeader}>
                    <Text style={styles.stageTitle}>{stage.name}</Text>
                    <Text style={styles.stageCount}>{jobs.length}</Text>
                  </View>
                  {jobs.length ? jobs.map((job) => (
                    <Pressable key={String(job.id)} onPress={() => setSelectedJob(job)} style={styles.jobCard}>
                      <Text style={styles.jobTitle} numberOfLines={2}>{entityLabel(job)}</Text>
                      <View style={styles.jobMetaRow}>
                        <Text style={[styles.priorityText, { color: priorityColor(job.priority) }]}>{job.priority || 'normal'}</Text>
                        <Text style={styles.jobMeta}>{job.assigned_name || job.assigned_full_name || 'Unassigned'}</Text>
                      </View>
                      {!!job.due_date && <Text style={styles.jobMeta}>Due {formatDate(job.due_date)}</Text>}
                    </Pressable>
                  )) : <Text style={styles.stageEmpty}>No cards here.</Text>}
                </View>
              );
            })}
            {!detail?.stages?.length && <View style={styles.card}><Text style={styles.cardTitle}>No stages</Text><Text style={styles.muted}>This pipeline has no stages configured.</Text></View>}
          </View>
        )}
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <View style={styles.header}>
        <Pressable onPress={onBackHome} style={styles.backButton}><Text style={styles.backText}>←</Text></Pressable>
        <View style={styles.headerText}>
          <Text style={styles.kicker}>Staff</Text>
          <Text style={styles.title}>Pipelines</Text>
          <Text style={styles.muted}>Browse active pipeline boards, cards, stages, and updates.</Text>
        </View>
      </View>
      {!!error && <Text style={styles.error}>{error}</Text>}
      {loadingList ? (
        <View style={styles.loadingCard}><ActivityIndicator color={colors.gold2} /><Text style={styles.muted}>Loading pipelines…</Text></View>
      ) : instances.length === 0 ? (
        <View style={styles.card}><Text style={styles.cardTitle}>No pipelines yet</Text><Text style={styles.muted}>Create pipeline boards on desktop for now.</Text></View>
      ) : (
        <View style={styles.threadList}>
          {instances.map((item) => (
            <Pressable key={String(item.id)} onPress={() => openInstance(item.id)} style={styles.threadRow}>
              <View style={styles.avatar}><Text style={styles.avatarText}>🧭</Text></View>
              <View style={styles.threadBody}>
                <View style={styles.threadTitleRow}>
                  <Text style={styles.threadName} numberOfLines={1}>{instanceTitle(item)}</Text>
                  <Text style={styles.threadDate}>{formatDate(item.created_at)}</Text>
                </View>
                <Text style={styles.threadSubject} numberOfLines={1}>{item.tax_year || 'No year'} · {item.entity_type || 'entities'}</Text>
                <Text style={styles.threadPreview}>{Number(item.job_count || 0)} cards · {item.status || 'active'}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  wrap: { padding: spacing.lg, paddingTop: 70, gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headerText: { flex: 1, gap: 6 },
  backButton: { width: 44, height: 44, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  backText: { color: colors.text, fontSize: 24, fontWeight: '900' },
  kicker: { color: colors.gold, fontSize: 12, fontWeight: '900', letterSpacing: 1.4, textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 36, fontWeight: '900', letterSpacing: -1.4, lineHeight: 39 },
  muted: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  error: { color: colors.red, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.lg },
  loadingCard: { minHeight: 180, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(31,36,48,0.94)', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  card: { borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(31,36,48,0.88)', padding: spacing.lg, gap: spacing.md },
  cardTitle: { color: colors.text, fontSize: 20, fontWeight: '900' },
  threadList: { gap: spacing.sm },
  threadRow: { flexDirection: 'row', gap: spacing.sm, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(31,36,48,0.88)', padding: spacing.md, alignItems: 'center' },
  avatar: { width: 44, height: 44, borderRadius: 17, backgroundColor: 'rgba(201,168,76,0.16)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.28)', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.gold2, fontSize: 17, fontWeight: '900' },
  threadBody: { flex: 1, gap: 4 },
  threadTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  threadName: { flex: 1, color: colors.text, fontSize: 16, fontWeight: '900' },
  threadDate: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  threadSubject: { color: colors.gold2, fontSize: 13, fontWeight: '800' },
  threadPreview: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  stageList: { gap: spacing.md },
  stageCard: { borderRadius: radius.xl, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(31,36,48,0.88)', padding: spacing.md, gap: spacing.sm },
  stageHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  stageTitle: { flex: 1, color: colors.text, fontSize: 18, fontWeight: '900' },
  stageCount: { minWidth: 28, height: 28, borderRadius: 14, backgroundColor: 'rgba(201,168,76,0.16)', color: colors.gold2, fontSize: 13, fontWeight: '900', textAlign: 'center', lineHeight: 28, overflow: 'hidden' },
  stageEmpty: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  jobCard: { borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(5,8,14,0.34)', padding: spacing.md, gap: 7 },
  jobTitle: { color: colors.text, fontSize: 15, fontWeight: '900', lineHeight: 20 },
  jobMetaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  priorityText: { fontSize: 12, fontWeight: '900', textTransform: 'uppercase' },
  jobMeta: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  detailGrid: { gap: spacing.sm },
  detailPill: { borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(5,8,14,0.34)', padding: spacing.md, gap: 3 },
  detailLabel: { color: colors.muted, fontSize: 11, fontWeight: '900', letterSpacing: 0.8, textTransform: 'uppercase' },
  detailValue: { color: colors.text, fontSize: 15, fontWeight: '900' },
  notes: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  stageMoveList: { gap: spacing.sm },
  stageMoveButton: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, backgroundColor: 'rgba(5,8,14,0.28)', padding: spacing.md, gap: 3 },
  stageMoveActive: { borderColor: 'rgba(201,168,76,0.4)', backgroundColor: 'rgba(201,168,76,0.12)' },
  stageMoveText: { color: colors.text, fontSize: 15, fontWeight: '900' },
  stageMoveTextActive: { color: colors.gold2 },
  stageMoveMeta: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  updateRow: { borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', backgroundColor: 'rgba(5,8,14,0.28)', padding: spacing.md, gap: 5 },
  updateAuthor: { color: colors.gold2, fontSize: 12, fontWeight: '900' },
  updateBody: { color: colors.text, fontSize: 14, lineHeight: 20 },
  composer: { padding: spacing.md, paddingBottom: 28, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg, gap: spacing.sm },
  updateInput: { minHeight: 70, maxHeight: 130, borderRadius: radius.lg, borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', backgroundColor: 'rgba(5,8,14,0.52)', color: colors.text, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 15, textAlignVertical: 'top' },
});
