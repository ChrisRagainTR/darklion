import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';
import { apiFetch } from '../api/client';
import { Icon } from '../components/Icon';
import { SignaturePad } from '../components/SignaturePad';
import { WebSheet } from '../components/WebSheet';
import { Avatar, Button, LinkButton, ListRow, Notice, Quote, Section, text } from '../components/ui';
import { colors, fonts } from '../theme/tokens';
import type { TaxDeliveryDocument, TaxDeliveryPacket } from '../types/api';
import { firstName, fmtDate, joinNames, money } from '../utils/taxText';

type Step = 'summary' | 'review' | 'sign' | 'done' | 'changes';
type Props = { token: string; deliveryId: number; onClose: () => void; onChanged: () => void; onMessageTeam: () => void };

function initialStep(p: TaxDeliveryPacket): Step {
  const me = p.currentSigner;
  if (p.delivery.status === 'needs_changes') return 'changes';
  if (!me || me.signedAt || ['signed', 'complete'].includes(String(p.delivery.status))) return 'done';
  return me.approvedAt ? 'sign' : 'summary';
}

// The same four steps as the web portal: summary, review, sign, done.
export function ReturnFlow({ token, deliveryId, onClose, onChanged, onMessageTeam }: Props) {
  const [packet, setPacket] = useState<TaxDeliveryPacket | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [changes, setChanges] = useState(false);
  const [note, setNote] = useState('');
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [drawn, setDrawn] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [consent, setConsent] = useState(false);
  const [viewer, setViewer] = useState<{ title: string; url: string } | null>(null);
  const scroll = useRef<ScrollView>(null);

  async function load(next?: Step) {
    try {
      const p = await apiFetch<TaxDeliveryPacket>('/portal/mobile/tax-deliveries/' + deliveryId, {}, token);
      setPacket(p);
      setError('');
      setStep(next || (s => s || initialStep(p)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'This return could not load.');
    }
  }
  useEffect(() => { load(); }, [deliveryId]);

  function go(next: Step) {
    setError('');
    setStep(next);
    scroll.current?.scrollTo({ y: 0, animated: false });
  }

  async function act(endpoint: string | undefined, body: object, next: Step, failure: string) {
    if (!endpoint || busy) return;
    setBusy(true); setError('');
    try {
      await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(body) }, token);
      await load(next);
      scroll.current?.scrollTo({ y: 0, animated: false });
      onChanged();
    } catch (e) {
      setError(failure + ' ' + (e instanceof Error ? e.message : ''));
    } finally {
      setBusy(false);
    }
  }

  async function openDoc(doc?: TaxDeliveryDocument | null) {
    if (!doc) return;
    let url = doc.signedUrl || null;
    if (!url && doc.apiUrl) {
      try { url = (await apiFetch<{ url?: string }>(doc.apiUrl, {}, token)).url || null; } catch { url = null; }
    }
    if (url) setViewer({ title: doc.name || 'Document', url });
    else setError('That document could not open.');
  }

  const d = packet?.delivery;
  const me = packet?.currentSigner || null;
  const signers = packet?.signers || [];
  const title = d ? (d.companyName ? d.companyName : 'Your ' + d.taxYear + ' return') : 'Tax return';
  const due = d?.taxSummary && (d.taxSummary as Record<string, unknown>).due_date ? String((d.taxSummary as Record<string, unknown>).due_date) : '';

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <WebSheet url={viewer?.url || null} title={viewer?.title || ''} onClose={() => setViewer(null)} />
      <View style={styles.top}>
        <Pressable onPress={onClose} style={styles.back} accessibilityRole="button" accessibilityLabel="Back to Taxes"><Icon name="chevron" size={22} color={colors.gold2} style={{ transform: [{ rotate: '180deg' }] }} /></Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>{title}</Text>
        <View style={styles.back} />
      </View>
      {packet && step ? <Stepper step={step} approved={Boolean(me?.approvedAt)} signed={Boolean(me?.signedAt)} onGo={go} /> : null}
      {due && step && step !== 'done' && step !== 'changes' ? <Text style={[text.hint, styles.due]}>Due {due}</Text> : null}
      <ScrollView ref={scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {!packet ? (error ? <Notice text={error} action="Try again" onAction={() => load()} /> : <ActivityIndicator color={colors.gold2} style={{ marginTop: 40 }} />) : null}
        {packet && error ? <Notice text={error} /> : null}

        {packet && d && step === 'summary' ? (
          <>
            {d.introNote ? (
              <View style={styles.note}>
                <Avatar name={d.preparer?.name || d.firmName || 'Your team'} url={d.preparer?.avatarUrl} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={text.hint}>{(d.preparer ? d.preparer.name + (d.preparer.credentials ? ', ' + d.preparer.credentials : '') : 'Your team') + ' · ' + fmtDate(d.updatedAt || d.createdAt)}</Text>
                  <Text style={[text.body, { marginTop: 4 }]}>{d.introNote}</Text>
                </View>
              </View>
            ) : null}
            <Figures packet={packet} />
            <Highlights packet={packet} />
            <View style={styles.actions}>
              <Button title={me ? 'Continue to review' : 'View the return'} onPress={() => go('review')} />
              <LinkButton title="Ask a question" onPress={onMessageTeam} />
            </View>
          </>
        ) : null}

        {packet && step === 'review' ? (
          <>
            <Text style={text.h2}>Look over your return</Text>
            <Text style={[text.lead, { marginTop: 6 }]}>This is the complete return we'll file. Take your time.</Text>
            <Pressable style={styles.doc} onPress={() => openDoc(packet.documents?.review)} accessibilityRole="button">
              <View style={styles.docIcon}><Icon name="file" size={26} color={colors.gold2} /></View>
              <View style={{ flex: 1 }}>
                <Text style={styles.docTitle} numberOfLines={2}>{packet.documents?.review?.name || 'Tax return'}</Text>
                <Text style={text.hint}>Tap to open the full return</Text>
              </View>
              <Icon name="chevron" size={18} color={colors.muted} />
            </Pressable>
            {!me ? <Text style={[text.hint, { marginTop: 16 }]}>You can view this return. The signers listed below sign it.</Text> : me.approvedAt ? (
              <>
                <Text style={[text.hint, { marginTop: 16 }]}>You approved this return on {fmtDate(me.approvedAt, true)}.</Text>
                <Button title="Continue to sign" onPress={() => go('sign')} style={{ marginTop: 16 }} />
              </>
            ) : changes ? (
              <>
                <Text style={styles.label}>What needs to change?</Text>
                <TextInput value={note} onChangeText={setNote} multiline placeholder="Describe what looks wrong or is missing." placeholderTextColor={colors.muted} style={styles.input} />
                <Button title="Send to your team" busy={busy} disabled={!note.trim()} onPress={() => act(packet.actionEndpoints?.requestChanges, { note: note.trim() }, 'changes', "Your request didn't send.")} style={{ marginTop: 14 }} />
                <LinkButton title="Cancel" onPress={() => setChanges(false)} />
              </>
            ) : (
              <>
                <CheckRow checked={reviewed} onChange={setReviewed} label="I've reviewed my return and it looks correct." />
                <Button title="Approve return" busy={busy} disabled={!reviewed} onPress={() => act(packet.actionEndpoints?.approve, {}, 'sign', "Your approval didn't go through.")} style={{ marginTop: 16 }} />
                <Button kind="outline" title="Something needs to change" onPress={() => setChanges(true)} style={{ marginTop: 10 }} />
              </>
            )}
          </>
        ) : null}

        {packet && d && step === 'sign' ? (
          <>
            <Text style={text.h2}>Sign your e-file authorization</Text>
            <Text style={[text.lead, { marginTop: 6 }]}>By signing, you authorize {d.firmName || 'your tax firm'} to e-file your {d.taxYear} return{d.companyName ? ' for ' + d.companyName : ''}.</Text>
            {packet.documents?.signature ? <ListRow icon="file" title={packet.documents.signature.name || 'Signature pages'} onPress={() => openDoc(packet.documents?.signature)} /> : null}
            <View style={styles.segment}>
              {(['draw', 'type'] as const).map(m => (
                <Pressable key={m} onPress={() => setMode(m)} style={[styles.segBtn, mode === m && styles.segOn]} accessibilityRole="button" accessibilityState={{ selected: mode === m }}>
                  <Text style={[styles.segText, mode === m && styles.segTextOn]}>{m === 'draw' ? 'Draw' : 'Type'}</Text>
                </Pressable>
              ))}
            </View>
            {mode === 'draw' ? <SignaturePad onChange={setDrawn} /> : (
              <TextInput value={typed} onChangeText={setTyped} placeholder="Type your full legal name" placeholderTextColor={colors.muted} autoCapitalize="words" autoComplete="name" style={styles.typed} />
            )}
            <Text style={[text.hint, { marginTop: 8 }]}>Signing as {signers.find(sg => me && sg.id === me.id)?.name || 'you'} · {new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</Text>
            <CheckRow checked={consent} onChange={setConsent} label="I agree to sign electronically. My electronic signature has the same legal effect as a handwritten one." />
            <Button title="Sign and submit" busy={busy} disabled={!consent || (mode === 'draw' ? !drawn : typed.trim().length < 2)}
              onPress={() => act(packet.actionEndpoints?.sign, mode === 'draw' ? { signature_data: drawn, signature_type: 'drawn' } : { signature_data: typed.trim(), signature_type: 'typed' }, 'done', "Your signature didn't go through.")}
              style={{ marginTop: 16 }} />
          </>
        ) : null}

        {packet && d && step === 'done' ? <Done packet={packet} onClose={onClose} /> : null}

        {packet && d && step === 'changes' ? (
          <>
            <Text style={text.h2}>We're updating your return</Text>
            <Text style={[text.lead, { marginTop: 6 }]}>Thanks for letting us know. Your team is making the changes and will send the updated return for your review. You don't need to do anything right now.</Text>
            {d.needsChangesNote ? <Section title="Your note"><Quote>{d.needsChangesNote}</Quote></Section> : null}
            <Button kind="outline" title="Message your team" onPress={onMessageTeam} style={{ marginTop: 20 }} />
          </>
        ) : null}

        {packet && signers.length && step !== 'done' ? (
          <Section title="Who needs to sign">
            {signers.map(sg => <ListRow key={String(sg.id)} dot={sg.signedAt ? 'done' : sg.approvedAt ? 'wait' : 'idle'} title={(sg.name || 'Signer') + (me && sg.id === me.id ? ' (you)' : '')} end={sg.signedAt ? 'Signed ' + fmtDate(sg.signedAt) : sg.approvedAt ? 'Approved' : 'Not started'} />)}
          </Section>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Stepper({ step, approved, signed, onGo }: { step: Step; approved: boolean; signed: boolean; onGo: (s: Step) => void }) {
  const order: Step[] = ['summary', 'review', 'sign', 'done'];
  const labels = ['Summary', 'Review', 'Sign', 'Done'];
  const cur = step === 'changes' ? 1 : order.indexOf(step);
  const doneUpTo = signed ? 3 : approved ? 2 : cur;
  return (
    <View style={styles.stepper}>
      {labels.map((label, i) => {
        const state = i === cur ? 'current' : i < Math.max(cur, doneUpTo) ? 'done' : 'upcoming';
        const can = state === 'done' && !signed && i < 2 && step !== 'changes';
        return (
          <Pressable key={label} disabled={!can} onPress={() => onGo(order[i])} style={styles.stepItem} accessibilityRole="button" accessibilityState={{ selected: state === 'current', disabled: !can }}>
            <View style={[styles.bar, state !== 'upcoming' && styles.barOn]} />
            <Text style={[styles.stepLabel, state === 'current' && styles.stepCurrent, state === 'done' && styles.stepDone]}>{label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function CheckRow({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable onPress={() => onChange(!checked)} style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked ? <Icon name="check" size={15} color="#15171d" /> : null}</View>
      <Text style={styles.checkText}>{label}</Text>
    </Pressable>
  );
}

function Figures({ packet }: { packet: TaxDeliveryPacket }) {
  const ts = (packet.delivery.taxSummary || {}) as Record<string, unknown>;
  const rep = (packet.delivery.taxReportData || {}) as Record<string, any>;
  const out: Array<[string, string, boolean]> = [];
  const fed = ts.federal_amount !== undefined && ts.federal_amount !== '' ? Number(ts.federal_amount) : rep.refund_or_owed_amount != null ? (rep.is_refund ? 1 : -1) * Math.abs(rep.refund_or_owed_amount) : null;
  if (fed !== null && !Number.isNaN(fed)) out.push(['Federal ' + (fed >= 0 ? 'refund' : 'balance due'), money(fed), fed >= 0]);
  if (ts.state_amount !== undefined && ts.state_amount !== '' && !Number.isNaN(Number(ts.state_amount))) {
    const st = Number(ts.state_amount);
    out.push(['State ' + (st >= 0 ? 'refund' : 'balance due'), money(st), st >= 0]);
  }
  if (rep.total_tax != null) out.push(['Total federal tax', money(rep.total_tax), false]);
  if (!out.length) return null;
  const [lead, ...rest] = out;
  const meta = [rep.client?.filing_status, rep.effective_rate ? 'Effective rate ' + rep.effective_rate + '%' : ''].filter(Boolean).join(' · ');
  return (
    <View style={styles.figures}>
      <Text style={text.hint}>{lead[0]}</Text>
      <Text style={[styles.bigFigure, lead[2] && styles.good]}>{lead[1]}</Text>
      <View style={styles.smallFigures}>
        {rest.map(f => <View key={f[0]} style={{ flex: 1 }}><Text style={text.hint}>{f[0]}</Text><Text style={[styles.smallFigure, f[2] && styles.good]}>{f[1]}</Text></View>)}
      </View>
      {meta ? <Text style={[text.hint, { marginTop: 8 }]}>{meta}</Text> : null}
    </View>
  );
}

function Highlights({ packet }: { packet: TaxDeliveryPacket }) {
  const rep = (packet.delivery.taxReportData || {}) as Record<string, any>;
  const yoy = rep.prior_year_comparison;
  const rows: string[] = Array.isArray(yoy?.highlights) ? yoy.highlights.slice(0, 4).map((h: any) => String(h.title)) : [];
  if (!rows.length && Array.isArray(rep.savings_highlights)) rep.savings_highlights.slice(0, 3).forEach((h: any) => rows.push([h.title, h.amount].filter(Boolean).join(' · ')));
  if (!rows.length) return null;
  return <Section title={yoy?.prior_tax_year ? 'What changed from ' + yoy.prior_tax_year : 'Highlights'}>{rows.map(t => <ListRow key={t} title={t} />)}</Section>;
}

function Done({ packet, onClose }: { packet: TaxDeliveryPacket; onClose: () => void }) {
  const d = packet.delivery;
  const me = packet.currentSigner;
  const signers = packet.signers || [];
  const waiting = signers.filter(sg => !sg.signedAt);
  const all = signers.length > 0 && !waiting.length;
  const name = firstName(signers.find(sg => me && sg.id === me.id)?.name);
  let head: string, lead: string;
  const known = d.filedDateKnown !== false;
  if (d.acceptedAt) { head = 'Your return was accepted'; lead = (known ? 'E-filed ' + fmtDate(d.filedAt, true) + ' and accepted ' : 'Accepted ') + fmtDate(d.acceptedAt, true) + ". You're all set."; }
  else if (d.filedAt) { head = 'Your return was filed'; lead = (known ? 'We e-filed it on ' + fmtDate(d.filedAt, true) + '. ' : '') + "We'll update this when it's accepted."; }
  else if (all) { head = "You've signed — thank you" + (name ? ', ' + name : ''); lead = "Everyone has signed. We'll e-file your return next."; }
  else if (me?.signedAt) { head = "You've signed — thank you" + (name ? ', ' + name : ''); lead = joinNames(waiting.map(sg => sg.name || 'Another signer')) + (waiting.length === 1 ? ' still needs' : ' still need') + ' to sign before we can e-file.'; }
  else { head = 'Waiting on signatures'; lead = 'This return is with the signers listed below.'; }
  return (
    <>
      <View style={styles.doneMark}><Icon name="check" size={26} color={colors.gold2} /></View>
      <Text style={text.h1}>{head}</Text>
      <Text style={[text.lead, { marginTop: 8 }]}>{lead}</Text>
      <Section title="What happens next">
        {signers.map(sg => <ListRow key={String(sg.id)} dot={sg.signedAt ? 'done' : 'wait'} title={firstName(sg.name) + ' signs'} end={sg.signedAt ? 'Done ' + fmtDate(sg.signedAt) : 'Waiting'} />)}
        <ListRow dot={d.filedAt ? 'done' : all ? 'now' : 'idle'} title="We e-file your return" end={d.filedAt ? (known ? 'Done ' + fmtDate(d.filedAt) : 'Done') : all ? 'Next' : 'After everyone signs'} />
        <ListRow dot={d.acceptedAt ? 'done' : 'idle'} title="The IRS accepts it" end={d.acceptedAt ? 'Done ' + fmtDate(d.acceptedAt) : 'A few days after filing'} />
      </Section>
      <Button title="Done" onPress={onClose} style={{ marginTop: 24 }} />
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  top: { paddingTop: Math.max(Constants.statusBarHeight || 0, 20) + 4, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center' },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topTitle: { flex: 1, textAlign: 'center', color: colors.text, fontSize: 17, fontWeight: '600' },
  stepper: { flexDirection: 'row', gap: 6, paddingHorizontal: 20, marginTop: 6 },
  stepItem: { flex: 1, gap: 6, paddingVertical: 4 },
  bar: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)' },
  barOn: { backgroundColor: colors.goldBtn },
  stepLabel: { color: colors.muted, fontSize: 12.5, textAlign: 'center' },
  stepCurrent: { color: colors.gold2, fontWeight: '700' },
  stepDone: { color: colors.text },
  due: { textAlign: 'center', marginTop: 4 },
  body: { padding: 20, paddingBottom: 48 },
  note: { flexDirection: 'row', gap: 12, marginBottom: 20 },
  figures: { paddingBottom: 4 },
  bigFigure: { fontFamily: fonts.serif, fontWeight: '700', fontSize: 40, lineHeight: 46, letterSpacing: -0.8, color: colors.text },
  smallFigures: { flexDirection: 'row', gap: 16, marginTop: 10 },
  smallFigure: { fontFamily: fonts.serif, fontWeight: '600', fontSize: 22, color: colors.text, marginTop: 2 },
  good: { color: colors.green },
  actions: { marginTop: 24, gap: 6 },
  doc: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: colors.panel },
  docIcon: { width: 48, height: 58, borderRadius: 6, backgroundColor: 'rgba(201,168,76,0.1)', alignItems: 'center', justifyContent: 'center' },
  docTitle: { color: colors.text, fontSize: 15.5, fontWeight: '600' },
  label: { color: colors.text2, fontSize: 14, marginTop: 18, marginBottom: 8 },
  input: { minHeight: 110, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: colors.panel, color: colors.text, padding: 14, fontSize: 15.5, textAlignVertical: 'top' },
  check: { flexDirection: 'row', gap: 12, marginTop: 18, alignItems: 'flex-start' },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.4)', alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.goldBtn, borderColor: colors.goldBtn },
  checkText: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 21 },
  segment: { flexDirection: 'row', alignSelf: 'flex-start', borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', borderRadius: 10, padding: 3, gap: 3, marginTop: 20, marginBottom: 12 },
  segBtn: { height: 36, minWidth: 96, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: 'rgba(201,168,76,0.16)', borderWidth: 1, borderColor: 'rgba(201,168,76,0.5)' },
  segText: { color: colors.text2, fontWeight: '600' },
  segTextOn: { color: colors.gold2 },
  typed: { height: 64, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.16)', backgroundColor: colors.panel, color: colors.text, paddingHorizontal: 16, fontSize: 22, fontFamily: fonts.serif, fontStyle: 'italic' },
  doneMark: { width: 52, height: 52, borderRadius: 26, borderWidth: 2, borderColor: colors.gold, alignItems: 'center', justifyContent: 'center', marginBottom: 14, marginTop: 6 },
});
