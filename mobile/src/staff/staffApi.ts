import { apiFetch } from '../api/client';
import type { TrackerStep } from '../types/api';

export type StaffTab = 'today' | 'clients' | 'inbox' | 'team' | 'more';

export type ClientRef = { type: 'person' | 'company'; id: number; name?: string };

export type StaffReturn = {
  id: number;
  kind: 'personal' | 'business';
  taxYear: string;
  title: string;
  stage: 'waiting' | 'changes_requested' | 'ready' | 'filed' | 'accepted';
  summary: string;
  sentAt: string | null;
  filedAt: string | null;
  acceptedAt: string | null;
  figures: Array<{ label: string; amount: number; isRefund: boolean }>;
  changeNote: string;
  remindedAt: string | null;
  canRemind: boolean;
  signers: Array<{ name: string; role: string; signedAt: string | null; approvedAt: string | null }>;
};

export type StaffTax = {
  taxYear: string;
  tracker: TrackerStep[] | null;
  currentReturn: StaffReturn | null;
  pastReturns: StaffReturn[];
  organizer?: { status: string; submittedAt: string | null; progress?: { total: number; resolved: number } } | null;
  stage?: string;
};

export type StaffRecord = {
  type: 'person' | 'company';
  id: number;
  name: string;
  firstName?: string;
  email?: string;
  phone?: string;
  spouseName?: string;
  spouseEmail?: string;
  spousePhone?: string;
  filingStatus?: string;
  city?: string;
  state?: string;
  entityType?: string;
  relationship: { id: number; name: string } | null;
  companies?: Array<{ id: number; name: string; entityType: string }>;
  owners?: Array<{ id: number; name: string; email: string; phone: string }>;
  tax: StaffTax;
};

export type StaffClientRow = {
  type: 'person' | 'company';
  id: number;
  name: string;
  email: string;
  phone: string;
  relationshipName: string;
  entityType?: string;
  status: { label: string; tone: 'wait' | 'warn' | 'gold' | 'done' | 'idle'; bucket: 'waiting' | 'organizer' | 'ready' | null } | null;
};

export type TodayItem = {
  id: number | string;
  kind: 'personal' | 'business' | 'organizer';
  name: string;
  taxYear: string;
  href: string | null;
  detail?: string;
  note?: string;
  days?: number | null;
  lastSignedAt?: string | null;
  filedAt?: string | null;
  remindedAt?: string | null;
  canRemind?: boolean;
};
type Group = { total: number; items: TodayItem[] };
export type TodayData = {
  taxYear: string;
  counts: { organizersOut: number; preparing: number; waitingOnClients: number; readyToEfile: number; changesRequested: number; filedAwaitingAcceptance: number; accepted: number; acceptedThisWeek: number };
  readyToEfile: Group;
  changesRequested: Group;
  waitingOnClients: Group;
  filedAwaitingAcceptance: Group;
};

export function refFromHref(href: string | null | undefined, name?: string): ClientRef | null {
  const m = String(href || '').match(/\/crm\/(person|company)\/(\d+)/);
  return m ? { type: m[1] as 'person' | 'company', id: Number(m[2]), name } : null;
}

export const staffApi = {
  today: (token: string) => apiFetch<TodayData>('/api/today', {}, token),
  clients: (token: string) => apiFetch<{ taxYear: string; clients: StaffClientRow[] }>('/api/mobile/staff/clients', {}, token),
  record: (token: string, ref: ClientRef) => apiFetch<StaffRecord>('/api/mobile/staff/' + ref.type + '/' + ref.id, {}, token),
  markFiled: (token: string, deliveryId: number | string, status: 'filed' | 'accepted') =>
    apiFetch('/api/tax-deliveries/' + deliveryId + '/efile', { method: 'POST', body: JSON.stringify({ status }) }, token),
  remind: (token: string, deliveryId: number | string) =>
    apiFetch<{ emailed?: number }>('/api/tax-deliveries/' + deliveryId + '/remind', { method: 'POST', body: '{}' }, token),
};

export function fmtDate(value?: string | null, withYear = false) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

export function fmtWhen(value?: string | null) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return fmtDate(value);
}

export function money(n: number) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

