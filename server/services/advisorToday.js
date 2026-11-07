'use strict';

// Firm-wide tax season view for the advisor Today page. Uses the same stages clients see,
// counted across the firm and turned into short work lists.

const { pool } = require('../db');

const DAY = 24 * 60 * 60 * 1000;
const OPEN_ORGANIZER = ['pending', 'in_progress', 'reopened'];
const DONE_ORGANIZER = ['submitted', 'closed', 'reviewed'];
const REMIND_COOLDOWN_HOURS = 20;

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function daysSince(v, now) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
}
function fullName(first, last) { return [first, last].filter(Boolean).join(' ').trim(); }

// "Jordan & Taylor Ellis" when spouses share a last name, otherwise both full names.
function householdName(first, last, spouseName) {
  const primary = fullName(first, last) || 'Client';
  const spouse = String(spouseName || '').trim();
  if (!spouse) return primary;
  const parts = spouse.split(/\s+/);
  const spouseLast = parts.length > 1 ? parts[parts.length - 1] : '';
  if (!spouseLast || spouseLast.toLowerCase() === String(last || '').toLowerCase()) return (first || primary) + ' & ' + parts[0] + (last ? ' ' + last : '');
  return primary + ' & ' + spouse;
}

function signerLabel(s) {
  if (s.signer_role === 'spouse') return String(s.spouse_name || '').trim().split(/\s+/)[0] || 'Spouse';
  return s.first_name || 'Client';
}

function describeDelivery(d) {
  const signers = Array.isArray(d.signers) ? d.signers : [];
  const taxpayer = signers.find(s => s.signer_role === 'taxpayer') || signers[0] || {};
  const name = d.company_id
    ? (d.company_name || 'Business')
    : householdName(taxpayer.first_name, taxpayer.last_name, signers.some(s => s.signer_role === 'spouse') ? taxpayer.spouse_name : '');
  return {
    id: d.id,
    kind: d.company_id ? 'business' : 'personal',
    name,
    taxYear: String(d.tax_year || ''),
    href: d.company_id ? '/crm/company/' + d.company_id : (taxpayer.person_id ? '/crm/person/' + taxpayer.person_id : null),
    signers,
    lastSignedAt: iso(signers.reduce((m, s) => (s.signed_at && (!m || new Date(s.signed_at) > new Date(m)) ? s.signed_at : m), null)),
  };
}

// Pure: turns rows into counts and work lists. Tested without a database.
function assembleToday({ taxYear, deliveries, organizers, now = Date.now(), listLimit = 8 }) {
  const personalSent = new Set(deliveries
    .filter(d => !d.company_id && String(d.tax_year) === String(taxYear))
    .map(d => (Array.isArray(d.signers) && (d.signers.find(s => s.signer_role === 'taxpayer') || d.signers[0]) || {}).person_id)
    .filter(Boolean));

  const ready = [], changes = [], waiting = [], filed = [];
  let acceptedThisYear = 0, acceptedThisWeek = 0;
  for (const d of deliveries) {
    const v = describeDelivery(d);
    if (d.status === 'needs_changes') {
      const req = v.signers.find(s => s.needs_changes_at) || {};
      changes.push({ ...v, note: d.needs_changes_note || req.needs_changes_note || '', since: iso(req.needs_changes_at || d.updated_at), days: daysSince(req.needs_changes_at || d.updated_at, now) });
    } else if (['sent', 'approved'].includes(d.status)) {
      const pending = v.signers.filter(s => !s.signed_at).map(signerLabel);
      const sent = d.sent_at || d.created_at;
      waiting.push({
        ...v, type: 'signature', sentAt: iso(sent), days: daysSince(sent, now), pending,
        detail: pending.length ? 'Waiting on ' + pending.join(' and ') + ' to sign' : 'Waiting on signatures',
        remindedAt: iso(d.last_reminded_at),
        canRemind: !d.last_reminded_at || now - new Date(d.last_reminded_at).getTime() > REMIND_COOLDOWN_HOURS * 3600 * 1000,
      });
    } else if (['signed', 'complete'].includes(d.status)) {
      if (!d.filed_at) ready.push({ ...v, days: daysSince(v.lastSignedAt, now) });
      else if (!d.accepted_at && d.filed_date_known !== false) filed.push({ ...v, filedAt: iso(d.filed_at), days: daysSince(d.filed_at, now) });
      if (d.accepted_at && String(d.tax_year) === String(taxYear)) acceptedThisYear++;
      if (d.accepted_at && now - new Date(d.accepted_at).getTime() <= 7 * DAY) acceptedThisWeek++;
    }
  }

  let organizersOut = 0, preparing = 0;
  for (const o of organizers) {
    if (personalSent.has(o.person_id)) continue;
    if (OPEN_ORGANIZER.includes(o.status)) organizersOut++;
    if (DONE_ORGANIZER.includes(o.status)) preparing++;
    if (o.status === 'reopened') {
      waiting.push({
        id: 'org-' + o.id, kind: 'organizer', type: 'documents', name: householdName(o.first_name, o.last_name, o.spouse_name),
        taxYear: String(o.tax_year || taxYear), href: '/crm/person/' + o.person_id,
        detail: 'Asked for more documents', days: daysSince(o.updated_at, now), canRemind: false,
      });
    }
  }

  const byOldest = (a, b) => (b.days || 0) - (a.days || 0);
  ready.sort(byOldest); changes.sort(byOldest); waiting.sort(byOldest); filed.sort(byOldest);
  const cut = list => ({ total: list.length, items: list.slice(0, listLimit) });

  return {
    taxYear: String(taxYear),
    counts: {
      organizersOut, preparing,
      waitingOnClients: waiting.length,
      readyToEfile: ready.length,
      changesRequested: changes.length,
      filedAwaitingAcceptance: filed.length,
      accepted: acceptedThisYear,
      acceptedThisWeek,
    },
    readyToEfile: cut(ready),
    changesRequested: cut(changes),
    waitingOnClients: cut(waiting),
    filedAwaitingAcceptance: cut(filed),
  };
}

async function buildAdvisorToday({ firmId, now = Date.now() }) {
  const firm = await pool.query('SELECT active_tax_year FROM firms WHERE id = $1', [firmId]);
  const taxYear = String((firm.rows[0] && firm.rows[0].active_tax_year) || new Date(now).getFullYear() - 1);
  const [deliveries, organizers] = await Promise.all([
    pool.query(
      `SELECT td.id, td.tax_year, td.status, td.company_id, co.company_name, td.sent_at, td.created_at, td.updated_at,
              td.filed_at, td.accepted_at, td.filed_date_known, td.needs_changes_note, td.last_reminded_at,
              (SELECT COALESCE(json_agg(json_build_object(
                  'person_id', s.person_id, 'signer_role', s.signer_role, 'first_name', p.first_name, 'last_name', p.last_name,
                  'spouse_name', p.spouse_name, 'approved_at', s.approved_at, 'signed_at', s.signed_at,
                  'needs_changes_at', s.needs_changes_at, 'needs_changes_note', s.needs_changes_note)
                ORDER BY CASE WHEN s.signer_role = 'taxpayer' THEN 0 ELSE 1 END, s.id), '[]'::json)
               FROM tax_delivery_signers s JOIN people p ON p.id = s.person_id WHERE s.delivery_id = td.id) AS signers
       FROM tax_deliveries td
       LEFT JOIN companies co ON co.id = td.company_id
       WHERE td.firm_id = $1 AND td.status <> 'draft'
         AND (td.tax_year = $2 OR td.status IN ('sent', 'approved', 'needs_changes')
              OR (td.status IN ('signed', 'complete') AND (td.filed_at IS NULL OR td.accepted_at IS NULL)))`,
      [firmId, taxYear]
    ),
    pool.query(
      `SELECT o.id, o.person_id, o.tax_year, o.status, o.submitted_at, o.updated_at, p.first_name, p.last_name, p.spouse_name
       FROM tax_organizers o JOIN people p ON p.id = o.person_id
       WHERE o.firm_id = $1 AND o.tax_year = $2`,
      [firmId, taxYear]
    ).catch(err => (err.code === '42P01' ? { rows: [] } : Promise.reject(err))),
  ]);
  return assembleToday({ taxYear, deliveries: deliveries.rows, organizers: organizers.rows, now });
}

module.exports = { buildAdvisorToday, assembleToday, householdName, REMIND_COOLDOWN_HOURS };
