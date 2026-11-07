'use strict';

// Data for the advisor iPhone app: the client list with each client's tax status, and one client record.
// Uses the same stages and tracker as the client portal so staff and clients see the same picture.

const { pool } = require('../db');
const { householdName, REMIND_COOLDOWN_HOURS } = require('./advisorToday');
const { buildClientTaxStatus, trackerSteps, resultFigures } = require('./clientTaxStatus');

const DAY = 24 * 60 * 60 * 1000;
const VISIBLE = ['sent', 'approved', 'needs_changes', 'signed', 'complete'];
const OPEN_ORGANIZER = ['pending', 'in_progress', 'reopened'];
const DONE_ORGANIZER = ['submitted', 'closed', 'reviewed'];

function iso(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function daysSince(v, now) {
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / DAY)) : null;
}
function shortDate(v) {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
}
function signerFirstName(s) {
  if (s.signer_role === 'spouse') return String(s.spouse_name || '').trim().split(/\s+/)[0] || 'Spouse';
  return s.first_name || 'Client';
}

// Where one return stands from the firm's side.
function staffStage(d, signers) {
  if (d.status === 'needs_changes') return 'changes_requested';
  const allSigned = signers.length > 0 && signers.every(s => s.signed_at);
  if (allSigned || d.status === 'signed' || d.status === 'complete') {
    if (d.accepted_at) return 'accepted';
    if (d.filed_at) return 'filed';
    return 'ready';
  }
  return 'waiting';
}

// Pure: one return shaped for the app, with the next staff action.
function staffReturnView(d, signerRows, now = Date.now()) {
  const signers = signerRows.filter(s => s.delivery_id === d.id);
  const stage = staffStage(d, signers);
  const pending = signers.filter(s => !s.signed_at).map(signerFirstName);
  const signedNames = signers.filter(s => s.signed_at).map(signerFirstName);
  const requester = signers.find(s => s.needs_changes_at);
  let summary;
  if (stage === 'changes_requested') summary = (requester ? signerFirstName(requester) + ' asked for changes' : 'Changes requested');
  else if (stage === 'waiting') summary = [signedNames.length ? signedNames.join(' and ') + ' signed' : '', pending.length ? 'Waiting on ' + pending.join(' and ') : ''].filter(Boolean).join(' · ');
  else if (stage === 'ready') summary = 'Everyone signed · ready to e-file';
  else if (stage === 'filed') summary = d.filed_date_known === false ? 'E-filed' : 'E-filed ' + shortDate(d.filed_at);
  else summary = 'Accepted ' + shortDate(d.accepted_at);
  const reminded = d.last_reminded_at ? new Date(d.last_reminded_at).getTime() : 0;
  return {
    id: d.id,
    kind: d.company_id ? 'business' : 'personal',
    taxYear: String(d.tax_year || ''),
    title: d.title || (d.tax_year + ' tax return'),
    stage,
    summary,
    sentAt: iso(d.sent_at || d.created_at),
    filedAt: iso(d.filed_at),
    acceptedAt: iso(d.accepted_at),
    figures: resultFigures(d),
    changeNote: stage === 'changes_requested' ? (d.needs_changes_note || (requester && requester.needs_changes_note) || '') : '',
    remindedAt: iso(d.last_reminded_at),
    canRemind: stage === 'waiting' && (!reminded || now - reminded > REMIND_COOLDOWN_HOURS * 3600 * 1000),
    signers: signers.map(s => ({ name: s.signer_role === 'spouse' ? (String(s.spouse_name || '').trim() || 'Spouse') : [s.first_name, s.last_name].filter(Boolean).join(' '), role: s.signer_role, signedAt: iso(s.signed_at), approvedAt: iso(s.approved_at) })),
  };
}

const TRACKER_STAGE = { waiting: 'sign', changes_requested: 'changes_requested', ready: 'signed', filed: 'filed', accepted: 'accepted' };

// Pure: status line and filter bucket for the client list.
function listStatus({ ret, organizer, now = Date.now() }) {
  if (ret) {
    const tone = { waiting: 'wait', changes_requested: 'warn', ready: 'gold', filed: 'done', accepted: 'done' }[ret.stage];
    const bucket = { waiting: 'waiting', changes_requested: 'waiting', ready: 'ready' }[ret.stage] || null;
    const label = ret.stage === 'waiting' ? 'Review & sign' : ret.stage === 'changes_requested' ? 'Changes requested' : ret.stage === 'ready' ? 'Ready to e-file' : ret.stage === 'filed' ? 'E-filed' : 'Accepted';
    return { label: ret.taxYear + ' · ' + label, tone, bucket };
  }
  if (organizer) {
    if (organizer.status === 'reopened') return { label: 'Asked for more documents', tone: 'wait', bucket: 'organizer' };
    if (OPEN_ORGANIZER.includes(organizer.status)) {
      const days = daysSince(organizer.created_at || organizer.updated_at, now);
      return { label: 'Organizer out' + (days != null ? ' · ' + days + (days === 1 ? ' day' : ' days') : ''), tone: 'idle', bucket: 'organizer' };
    }
    if (DONE_ORGANIZER.includes(organizer.status)) return { label: 'Organizer in · preparing', tone: 'idle', bucket: null };
  }
  return null;
}

async function activeTaxYear(firmId) {
  const r = await pool.query('SELECT active_tax_year FROM firms WHERE id = $1', [firmId]);
  return String((r.rows[0] && r.rows[0].active_tax_year) || new Date().getFullYear() - 1);
}

async function loadSigners(ids) {
  if (!ids.length) return [];
  const r = await pool.query(
    `SELECT s.delivery_id, s.person_id, s.signer_role, s.approved_at, s.signed_at, s.needs_changes_at, s.needs_changes_note,
            p.first_name, p.last_name, p.spouse_name
     FROM tax_delivery_signers s JOIN people p ON p.id = s.person_id
     WHERE s.delivery_id = ANY($1)
     ORDER BY CASE WHEN s.signer_role = 'taxpayer' THEN 0 ELSE 1 END, s.id`,
    [ids]
  );
  return r.rows;
}

async function listStaffClients({ firmId, now = Date.now() }) {
  const taxYear = await activeTaxYear(firmId);
  const [people, companies, deliveries, organizers] = await Promise.all([
    pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.spouse_name, p.email, p.phone, r.name AS relationship_name
       FROM people p LEFT JOIN relationships r ON r.id = p.relationship_id
       WHERE p.firm_id = $1`, [firmId]),
    pool.query(
      `SELECT c.id, c.company_name, c.entity_type, r.name AS relationship_name
       FROM companies c LEFT JOIN relationships r ON r.id = c.relationship_id
       WHERE c.firm_id = $1 AND c.archived_at IS NULL AND COALESCE(c.status, 'active') <> 'inactive'`, [firmId]),
    pool.query(
      `SELECT td.id, td.tax_year, td.status, td.company_id, td.title, td.sent_at, td.created_at, td.filed_at, td.accepted_at,
              td.filed_date_known, td.needs_changes_note, td.last_reminded_at, td.tax_summary
       FROM tax_deliveries td WHERE td.firm_id = $1 AND td.tax_year::text = $2 AND td.status = ANY($3)
       ORDER BY td.created_at DESC`, [firmId, taxYear, VISIBLE]),
    pool.query(
      `SELECT person_id, status, created_at, updated_at FROM tax_organizers WHERE firm_id = $1 AND tax_year::text = $2`,
      [firmId, taxYear]
    ).catch(err => (err.code === '42P01' ? { rows: [] } : Promise.reject(err))),
  ]);
  const signers = await loadSigners(deliveries.rows.map(d => d.id));
  const personalByPerson = new Map();
  const byCompany = new Map();
  for (const d of deliveries.rows) {
    const view = staffReturnView(d, signers, now);
    if (d.company_id) { if (!byCompany.has(d.company_id)) byCompany.set(d.company_id, view); continue; }
    const taxpayer = signers.find(s => s.delivery_id === d.id && s.signer_role === 'taxpayer') || signers.find(s => s.delivery_id === d.id);
    if (taxpayer && !personalByPerson.has(taxpayer.person_id)) personalByPerson.set(taxpayer.person_id, view);
  }
  const orgByPerson = new Map(organizers.rows.map(o => [o.person_id, o]));
  const clients = [
    ...people.rows.map(p => ({
      type: 'person', id: p.id,
      name: householdName(p.first_name, p.last_name, p.spouse_name),
      sortName: [p.last_name, p.first_name].filter(Boolean).join(' ').toLowerCase(),
      email: p.email || '', phone: p.phone || '', relationshipName: p.relationship_name || '',
      status: listStatus({ ret: personalByPerson.get(p.id), organizer: orgByPerson.get(p.id), now }),
    })),
    ...companies.rows.map(c => ({
      type: 'company', id: c.id, name: c.company_name || 'Company',
      sortName: String(c.company_name || '').toLowerCase(),
      email: '', phone: '', relationshipName: c.relationship_name || '', entityType: c.entity_type || '',
      status: listStatus({ ret: byCompany.get(c.id), organizer: null, now }),
    })),
  ].sort((a, b) => a.sortName.localeCompare(b.sortName));
  return { taxYear, clients };
}

async function loadReturns({ firmId, where, params, now }) {
  const r = await pool.query(
    `SELECT td.id, td.tax_year, td.status, td.company_id, td.title, td.sent_at, td.created_at, td.filed_at, td.accepted_at,
            td.filed_date_known, td.needs_changes_note, td.last_reminded_at, td.tax_summary, td.tax_report_data
     FROM tax_deliveries td WHERE td.firm_id = $1 AND td.status = ANY($2) AND ` + where + `
     ORDER BY td.tax_year DESC, td.created_at DESC`,
    [firmId, VISIBLE, ...params]
  );
  const signers = await loadSigners(r.rows.map(d => d.id));
  return r.rows.map(d => staffReturnView(d, signers, now));
}

function splitReturns(returns, taxYear, hasOrganizer, fallbackStage) {
  const current = returns.find(x => x.taxYear === taxYear) || null;
  const stage = current ? TRACKER_STAGE[current.stage] : fallbackStage;
  return {
    taxYear,
    tracker: stage ? trackerSteps(stage, { hasOrganizer }) : null,
    currentReturn: current,
    pastReturns: returns.filter(x => x !== current),
  };
}

async function staffPersonRecord({ firmId, personId, now = Date.now() }) {
  const pr = await pool.query(
    `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, p.filing_status, p.city, p.state,
            p.spouse_name, p.spouse_email, p.spouse_phone, p.portal_enabled, p.relationship_id, r.name AS relationship_name
     FROM people p LEFT JOIN relationships r ON r.id = p.relationship_id
     WHERE p.id = $1 AND p.firm_id = $2`, [personId, firmId]);
  const p = pr.rows[0];
  if (!p) return null;
  const [status, companies, returns] = await Promise.all([
    buildClientTaxStatus({ firmId, personId }),
    pool.query(
      `SELECT c.id, c.company_name, c.entity_type FROM person_company_access pca
       JOIN companies c ON c.id = pca.company_id AND c.firm_id = $2
       WHERE pca.person_id = $1 AND c.archived_at IS NULL ORDER BY c.company_name`, [personId, firmId]),
    loadReturns({ firmId, now, where: 'td.company_id IS NULL AND td.id IN (SELECT delivery_id FROM tax_delivery_signers WHERE person_id = $3)', params: [personId] }),
  ]);
  const taxYear = (status && status.taxYear) || await activeTaxYear(firmId);
  const organizer = status && status.organizer;
  const orgStage = status && !status.personalReturn && status.stage !== 'idle' ? status.stage : null;
  const tax = splitReturns(returns, taxYear, Boolean(organizer), orgStage);
  return {
    type: 'person', id: p.id,
    name: householdName(p.first_name, p.last_name, p.spouse_name),
    firstName: p.first_name || '',
    email: p.email || '', phone: p.phone || '',
    spouseName: p.spouse_name || '', spouseEmail: p.spouse_email || '', spousePhone: p.spouse_phone || '',
    filingStatus: p.filing_status || '', city: p.city || '', state: p.state || '',
    portalEnabled: !!p.portal_enabled,
    relationship: p.relationship_id ? { id: p.relationship_id, name: p.relationship_name || '' } : null,
    companies: companies.rows.map(c => ({ id: c.id, name: c.company_name, entityType: c.entity_type || '' })),
    tax: { ...tax, organizer: organizer ? { status: organizer.status, submittedAt: organizer.submittedAt, progress: organizer.progress } : null, stage: status ? status.stage : 'idle' },
  };
}

async function staffCompanyRecord({ firmId, companyId, now = Date.now() }) {
  const cr = await pool.query(
    `SELECT c.id, c.company_name, c.entity_type, c.city, c.state, c.relationship_id, r.name AS relationship_name
     FROM companies c LEFT JOIN relationships r ON r.id = c.relationship_id
     WHERE c.id = $1 AND c.firm_id = $2`, [companyId, firmId]);
  const c = cr.rows[0];
  if (!c) return null;
  const taxYear = await activeTaxYear(firmId);
  const [owners, returns] = await Promise.all([
    pool.query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.phone, pca.ownership_pct FROM person_company_access pca
       JOIN people p ON p.id = pca.person_id AND p.firm_id = $2 WHERE pca.company_id = $1 ORDER BY p.last_name, p.first_name`,
      [companyId, firmId]),
    loadReturns({ firmId, now, where: 'td.company_id = $3', params: [companyId] }),
  ]);
  return {
    type: 'company', id: c.id, name: c.company_name || 'Company', entityType: c.entity_type || '',
    city: c.city || '', state: c.state || '',
    relationship: c.relationship_id ? { id: c.relationship_id, name: c.relationship_name || '' } : null,
    owners: owners.rows.map(o => ({ id: o.id, name: [o.first_name, o.last_name].filter(Boolean).join(' '), email: o.email || '', phone: o.phone || '', ownershipPct: o.ownership_pct })),
    tax: splitReturns(returns, taxYear, false, null),
  };
}

module.exports = { listStaffClients, staffPersonRecord, staffCompanyRecord, staffReturnView, staffStage, listStatus };
