import type { ClientReturn, ClientTaxStatus, TrackerStep } from '../types/api';

export function fmtDate(value?: string | null, withYear = false) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (withYear || d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

export function fmtDue(p: { dueDate?: string; dueText?: string }) {
  if (!p.dueDate) return p.dueText || '';
  const [y, m, d] = p.dueDate.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const money = (n: number) => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US');
// Returns filed before DarkLion tracked filing show "Filed" with no date.
export const filedPhrase = (r: { filedAt?: string | null; filedDateKnown?: boolean }, withYear = false) =>
  r.filedDateKnown === false ? 'Filed' : `E-filed ${fmtDate(r.filedAt, withYear)}`;
export const firstName = (name?: string | null) => String(name || '').trim().split(/\s+/)[0] || '';
export function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

export function figuresLine(r: ClientReturn) {
  return (r.figures || []).map(f => `${f.label} ${f.isRefund ? 'refund' : 'balance due'} ${money(f.amount)}`).join(' · ');
}

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function homeSentence(s: ClientTaxStatus) {
  const r = s.personalReturn;
  const year = s.taxYear;
  const bizActions = s.actions.filter(a => a.type === 'tax_return' && (!r || a.deliveryId !== r.id)).length;
  const extra = bizActions ? ' A business return is also ready for you.' : '';
  switch (s.stage) {
    case 'organizer_ready': return `Your ${year} tax organizer is ready.${extra}`;
    case 'organizer_in_progress': return `Pick up your ${year} organizer where you left off.${extra}`;
    case 'more_documents': return `We need a few more documents to finish your return.${extra}`;
    case 'preparing': return `We're preparing your ${year} return. Nothing is needed from you right now.${extra}`;
    case 'review': case 'sign': return `Your ${year} return is ready to review and sign.${extra}`;
    case 'with_other_signers': return `Your ${year} return is out for signatures.${extra}`;
    case 'signed_waiting': {
      const others = (r?.signers || []).filter(x => !x.isMe && !x.signedAt).map(x => firstName(x.name));
      return `You've signed. We're waiting on ${joinNames(others) || 'another signer'}.${extra}`;
    }
    case 'changes_requested': return `We're updating your return based on your note.${extra}`;
    case 'signed': return `Your return is signed. We'll e-file it next.${extra}`;
    case 'filed': return (r?.filedDateKnown === false ? `Your ${year} return was filed.` : `Your ${year} return was e-filed on ${fmtDate(r?.filedAt, true)}.`) + extra;
    case 'accepted': return `Your ${year} return was accepted. You're all set.${extra}`;
    default: return bizActions ? 'A business return is ready for you to review and sign.' : "You're all caught up.";
  }
}

export function trackerNote(s: ClientTaxStatus) {
  const r = s.personalReturn;
  switch (s.stage) {
    case 'organizer_in_progress': return s.organizer ? `${s.organizer.progress.resolved} of ${s.organizer.progress.total} done` : '';
    case 'more_documents': {
      const n = s.organizer?.requestedItems.length || 0;
      return n ? `Waiting on ${n} document${n === 1 ? '' : 's'}` : 'Waiting on documents';
    }
    case 'preparing': return s.organizer?.submittedAt ? `Organizer received ${fmtDate(s.organizer.submittedAt)}` : '';
    case 'review': case 'sign': return r?.dueText ? `Due ${r.dueText}` : '';
    case 'changes_requested': return 'Being updated';
    case 'signed_waiting': return 'Waiting on another signature';
    case 'signed': return "We'll e-file next";
    case 'filed': return r ? filedPhrase(r) : '';
    case 'accepted': return `Accepted ${fmtDate(r?.acceptedAt)}`;
    default: return '';
  }
}

export function returnTracker(r: ClientReturn): TrackerStep[] | null {
  const map: Record<string, number> = { review: 1, sign: 1, changes_requested: 1, signed_waiting: 1, with_other_signers: 1, signed: 2, filed: 3, accepted: 3 };
  const pos = map[r.stage];
  if (pos === undefined) return null;
  return ['We prepare', 'Review & sign', 'Filed'].map((label, i) => ({ label, state: i < pos ? 'done' : i === pos ? 'current' : 'upcoming' }));
}

export function returnStatusText(r: ClientReturn) {
  switch (r.stage) {
    case 'review': return 'Ready for you to review and sign' + (r.dueText ? ` · Due ${r.dueText}` : '');
    case 'sign': return 'Approved. Ready for your signature' + (r.dueText ? ` · Due ${r.dueText}` : '');
    case 'with_other_signers': return 'Out for signatures';
    case 'signed_waiting': return `You signed ${fmtDate(r.me?.signedAt)} · Waiting on another signer`;
    case 'changes_requested': return "We're updating it based on your note";
    case 'signed': return "Signed · We'll e-file it next";
    case 'filed': return filedPhrase(r, true);
    case 'accepted': return `${filedPhrase(r, true)} · Accepted ${fmtDate(r.acceptedAt, true)}`;
    default: return '';
  }
}
