'use strict';

// One view of a client's tax season, shared by the web portal and the iPhone app so both
// always show the same state. Stage rules live in pure functions below and are unit tested.

const { pool } = require('../db');

const VISIBLE_DELIVERY_STATUSES = ['sent', 'approved', 'needs_changes', 'signed', 'complete'];
const ORGANIZER_DONE_STATUSES = ['submitted', 'closed', 'reviewed'];

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function signerName(row) {
  if (row.signer_role === 'spouse') {
    return (row.spouse_name || '').trim() || `${row.first_name || ''} ${row.last_name || ''}`.trim();
  }
  return `${row.first_name || ''} ${row.last_name || ''}`.trim();
}

function parseMoney(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = typeof value === 'number' ? value : parseFloat(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(num) ? num : null;
}

// Refund or balance due, preferring the amounts staff typed on the delivery over the generated summary.
function resultFigures(delivery) {
  const summary = delivery.tax_summary || {};
  const report = delivery.tax_report_data || {};
  const figures = [];
  const federal = parseMoney(summary.federal_amount);
  if (federal !== null) figures.push({ label: 'Federal', amount: Math.abs(federal), isRefund: federal >= 0 });
  else {
    const reported = parseMoney(report.refund_or_owed_amount);
    if (reported !== null) figures.push({ label: 'Federal', amount: Math.abs(reported), isRefund: Boolean(report.is_refund) });
  }
  const state = parseMoney(summary.state_amount);
  if (state !== null) figures.push({ label: 'State', amount: Math.abs(state), isRefund: state >= 0 });
  return figures;
}

// Stage of one return as the signed-in client experiences it.
function deliveryStage(delivery, signers, mySigner) {
  if (delivery.status === 'needs_changes') return 'changes_requested';
  const allSigned = signers.length > 0 && signers.every(s => s.signed_at);
  if (allSigned || delivery.status === 'signed' || delivery.status === 'complete') {
    if (delivery.accepted_at) return 'accepted';
    if (delivery.filed_at) return 'filed';
    return 'signed';
  }
  if (mySigner && mySigner.signed_at) return 'signed_waiting';
  if (!mySigner) return 'with_other_signers';
  return mySigner.approved_at ? 'sign' : 'review';
}

// The client's current place in the season, driving Home and the tracker.
function personalStage({ organizer, delivery }) {
  if (delivery) return delivery.stage;
  if (organizer) {
    if (organizer.status === 'reopened') return 'more_documents';
    if (ORGANIZER_DONE_STATUSES.includes(organizer.status)) return 'preparing';
    if (organizer.status === 'in_progress' || (organizer.progress && organizer.progress.resolved > 0)) return 'organizer_in_progress';
    return 'organizer_ready';
  }
  return 'idle';
}

// Steps shown in the tracker. Clients without an organizer (and every business return) skip that step.
function trackerSteps(stage, { hasOrganizer }) {
  const labels = hasOrganizer ? ['Organizer', 'We prepare', 'Review & sign', 'Filed'] : ['We prepare', 'Review & sign', 'Filed'];
  const offset = hasOrganizer ? 0 : -1;
  const position = {
    organizer_ready: 0, organizer_in_progress: 0,
    more_documents: 1, preparing: 1,
    review: 2, sign: 2, changes_requested: 2, signed_waiting: 2, with_other_signers: 2,
    signed: 3, filed: 4, accepted: 4,
  }[stage];
  if (position === undefined) return null;
  const current = Math.max(0, position + offset);
  return labels.map((label, index) => ({
    label,
    state: index < current ? 'done' : index === current ? 'current' : 'upcoming',
  }));
}

function parseDueDate(text) {
  if (!text) return null;
  const raw = String(text).trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = isoMatch ? new Date(Date.UTC(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3])) : new Date(`${raw} UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

// Upcoming estimated payment reminders from the most recent return summary. Due dates only; payments are not tracked.
function upcomingEstimatedPayments(report, today) {
  if (!report || typeof report !== 'object') return [];
  const rows = [];
  for (const p of Array.isArray(report.federal_estimated_payments) ? report.federal_estimated_payments : []) {
    rows.push({ jurisdiction: 'Federal', quarter: p.quarter || '', dueDate: parseDueDate(p.due_date), dueText: p.due_date || '', amount: p.amount || '' });
  }
  for (const p of Array.isArray(report.state_estimated_payments) ? report.state_estimated_payments : []) {
    rows.push({ jurisdiction: p.state || 'State', quarter: p.quarter || '', dueDate: parseDueDate(p.due_date), dueText: p.due_date || '', amount: p.amount || '' });
  }
  return rows
    .filter(r => r.dueDate && r.dueDate >= today)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.jurisdiction.localeCompare(b.jurisdiction));
}

function shapeDelivery(row, signerRows, { personId, signerRole }) {
  const signers = signerRows.filter(s => s.delivery_id === row.id);
  const mySigner = signers.find(s => s.person_id === personId && s.signer_role === signerRole)
    || (signerRole === 'taxpayer' ? signers.find(s => s.person_id === personId) : null) || null;
  const stage = deliveryStage(row, signers, mySigner);
  const changeRequester = signers.find(s => s.needs_changes_at);
  return {
    id: row.id,
    kind: row.company_id ? 'business' : 'personal',
    companyId: row.company_id,
    companyName: row.company_name || null,
    taxYear: row.tax_year,
    title: row.title || `${row.tax_year} tax return`,
    status: row.status,
    stage,
    // Returns sent before sent_at existed fall back to their creation date.
    sentAt: iso(row.sent_at || row.created_at),
    updatedAt: iso(row.updated_at),
    dueText: (row.tax_summary && row.tax_summary.due_date) || null,
    figures: resultFigures(row),
    filedAt: iso(row.filed_at),
    filedDateKnown: row.filed_date_known !== false,
    acceptedAt: iso(row.accepted_at),
    signedDocId: row.signed_doc_id || null,
    reviewDocId: row.review_doc_id || null,
    changeRequest: row.status === 'needs_changes' ? {
      note: row.needs_changes_note || (changeRequester && changeRequester.needs_changes_note) || '',
      by: changeRequester ? signerName(changeRequester) : null,
      at: iso(changeRequester && changeRequester.needs_changes_at),
    } : null,
    me: mySigner ? {
      role: mySigner.signer_role,
      approvedAt: iso(mySigner.approved_at),
      signedAt: iso(mySigner.signed_at),
    } : null,
    signers: signers.map(s => ({
      name: signerName(s),
      role: s.signer_role,
      isMe: s === mySigner,
      approvedAt: iso(s.approved_at),
      signedAt: iso(s.signed_at),
    })),
  };
}

const ACTION_STAGES = ['review', 'sign'];

function assembleStatus({ person, taxYear, companies, deliveries, organizer, today, signerRole = 'taxpayer' }) {
  const personalDelivery = deliveries.find(d => d.view.kind === 'personal' && String(d.view.taxYear) === taxYear) || null;
  const stage = personalStage({ organizer, delivery: personalDelivery && personalDelivery.view });
  const businessReturns = deliveries.filter(d => d.view.kind === 'business' && String(d.view.taxYear) === taxYear).map(d => d.view);
  const returnsThisYear = [personalDelivery && personalDelivery.view, ...businessReturns].filter(Boolean);
  const finished = ['signed', 'filed', 'accepted'];
  const pastReturns = deliveries.filter(d => String(d.view.taxYear) !== taxYear && finished.includes(d.view.stage)).map(d => d.view);
  const lastFiled = deliveries.find(d => d.view.kind === 'personal' && finished.includes(d.view.stage)) || null;
  const reportSource = deliveries.find(d => d.view.kind === 'personal' && d.row.tax_report_data && !['changes_requested'].includes(d.view.stage));

  const actions = returnsThisYear.filter(r => ACTION_STAGES.includes(r.stage)).map(r => ({ type: 'tax_return', deliveryId: r.id, stage: r.stage }));
  if (!personalDelivery && organizer) {
    if (stage === 'organizer_ready' || stage === 'organizer_in_progress') actions.push({ type: 'organizer', stage });
    if (stage === 'more_documents') actions.push({ type: 'organizer_requests', stage, count: organizer.requestedItems.length });
  }

  return {
    taxYear,
    today,
    // A spouse signs in with their own login on the same household record.
    firstName: (signerRole === 'spouse' ? String(person.spouse_name || '').trim().split(/\s+/)[0] : '') || person.first_name || '',
    stage,
    tracker: trackerSteps(stage, { hasOrganizer: Boolean(organizer) }),
    organizer,
    personalReturn: personalDelivery ? personalDelivery.view : null,
    businessReturns,
    businesses: companies.map(c => ({ id: c.id, name: c.company_name })),
    pastReturns,
    lastFiledReturn: lastFiled ? { taxYear: lastFiled.view.taxYear, stage: lastFiled.view.stage, filedAt: lastFiled.view.filedAt, filedDateKnown: lastFiled.view.filedDateKnown, acceptedAt: lastFiled.view.acceptedAt } : null,
    estimatedPayments: upcomingEstimatedPayments(reportSource && reportSource.row.tax_report_data, today),
    actions,
  };
}

async function loadOrganizer({ firmId, personId, taxYear }) {
  const orgRes = await pool.query(
    `SELECT o.id, o.tax_year, o.status, o.submitted_at, o.reopen_note,
            COUNT(i.id) FILTER (WHERE NOT COALESCE(i.sentinel_provides, false))::int AS total,
            COUNT(i.id) FILTER (WHERE NOT COALESCE(i.sentinel_provides, false) AND i.status <> 'pending')::int AS resolved
     FROM tax_organizers o LEFT JOIN tax_organizer_items i ON i.organizer_id = o.id
     WHERE o.firm_id = $1 AND o.person_id = $2 AND o.tax_year = $3
     GROUP BY o.id`,
    [firmId, personId, taxYear]
  ).catch(err => (err.code === '42P01' ? { rows: [] } : Promise.reject(err)));
  const org = orgRes.rows[0];
  if (!org) return null;
  const requested = org.status === 'reopened' ? await pool.query(
    `SELECT id, payer_name, section FROM tax_organizer_items
     WHERE organizer_id = $1 AND status = 'pending' AND NOT COALESCE(sentinel_provides, false)
     ORDER BY display_order, id`,
    [org.id]
  ) : { rows: [] };
  return {
    id: org.id,
    taxYear: org.tax_year,
    status: org.status,
    submittedAt: iso(org.submitted_at),
    reopenNote: org.reopen_note || '',
    progress: { total: org.total, resolved: org.resolved },
    requestedItems: requested.rows.map(i => ({ id: i.id, name: i.payer_name, section: i.section })),
  };
}

async function buildClientTaxStatus({ firmId, personId, signerRole = 'taxpayer', today = new Date().toISOString().slice(0, 10) }) {
  const [personRes, firmRes, companyRes] = await Promise.all([
    pool.query('SELECT id, first_name, last_name, spouse_name, organizer_visible FROM people WHERE id = $1 AND firm_id = $2', [personId, firmId]),
    pool.query('SELECT active_tax_year FROM firms WHERE id = $1', [firmId]),
    pool.query(
      `SELECT c.id, c.company_name FROM person_company_access pca
       JOIN companies c ON c.id = pca.company_id
       WHERE pca.person_id = $1 AND c.firm_id = $2 ORDER BY c.company_name`,
      [personId, firmId]
    ),
  ]);
  const person = personRes.rows[0];
  if (!person) return null;
  const taxYear = String((firmRes.rows[0] && firmRes.rows[0].active_tax_year) || new Date().getFullYear() - 1);
  const companyIds = companyRes.rows.map(c => c.id);

  const deliveriesRes = await pool.query(
    `SELECT td.*, co.company_name
     FROM tax_deliveries td
     LEFT JOIN companies co ON co.id = td.company_id
     WHERE td.firm_id = $1 AND td.status = ANY($2)
       AND (td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = $3)
            OR td.company_id = ANY($4))
     ORDER BY td.tax_year DESC, td.created_at DESC`,
    [firmId, VISIBLE_DELIVERY_STATUSES, personId, companyIds]
  );
  const deliveryIds = deliveriesRes.rows.map(d => d.id);
  const signerRes = deliveryIds.length ? await pool.query(
    `SELECT tds.*, p.first_name, p.last_name, p.spouse_name
     FROM tax_delivery_signers tds JOIN people p ON p.id = tds.person_id
     WHERE tds.delivery_id = ANY($1)
     ORDER BY CASE WHEN tds.signer_role = 'taxpayer' THEN 0 ELSE 1 END, tds.id`,
    [deliveryIds]
  ) : { rows: [] };

  const deliveries = deliveriesRes.rows.map(row => ({ row, view: shapeDelivery(row, signerRes.rows, { personId, signerRole }) }));
  const organizer = person.organizer_visible ? await loadOrganizer({ firmId, personId, taxYear }) : null;
  return assembleStatus({ person, taxYear, companies: companyRes.rows, deliveries, organizer, today, signerRole });
}

module.exports = {
  buildClientTaxStatus,
  assembleStatus,
  shapeDelivery,
  deliveryStage,
  personalStage,
  trackerSteps,
  upcomingEstimatedPayments,
  parseDueDate,
  resultFigures,
};
