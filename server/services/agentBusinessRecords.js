'use strict';

const { pool } = require('../db');
const { resolveRefundOrBalance } = require('./taxFactExtractor');

class AgentBusinessError extends Error {
  constructor(message, status = 400, code = 'business_record_error') {
    super(message);
    this.name = 'AgentBusinessError';
    this.status = status;
    this.code = code;
  }
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) throw new AgentBusinessError(`${field} must be a positive integer`, 400, 'invalid_input');
  return id;
}

function boundedInt(value, fallback, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new AgentBusinessError('limit must be a positive integer', 400, 'invalid_input');
  return Math.min(number, max);
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function text(value, max = 1000) {
  return String(value || '').slice(0, max);
}

function companyAccessSql(companyExpression, parameterNumber) {
  return `(
    ${companyExpression} IS NULL
    OR NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $${parameterNumber})
    OR EXISTS (
      SELECT 1 FROM companies access_company
      JOIN firm_user_companies allowed ON allowed.realm_id = access_company.realm_id
      WHERE access_company.id = ${companyExpression} AND allowed.firm_user_id = $${parameterNumber}
    )
  )`;
}

function personalDeliveryAccessSql(parameterNumber) {
  return `(
    td.company_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $${parameterNumber})
    OR NOT EXISTS (
      SELECT 1 FROM tax_delivery_signers scope_signer
      JOIN people scope_person ON scope_person.id = scope_signer.person_id AND scope_person.firm_id = td.firm_id
      JOIN companies scope_company ON scope_company.relationship_id = scope_person.relationship_id AND scope_company.firm_id = td.firm_id
      WHERE scope_signer.delivery_id = td.id
    )
    OR EXISTS (
      SELECT 1 FROM tax_delivery_signers scope_signer
      JOIN people scope_person ON scope_person.id = scope_signer.person_id AND scope_person.firm_id = td.firm_id
      JOIN companies scope_company ON scope_company.relationship_id = scope_person.relationship_id AND scope_company.firm_id = td.firm_id
      JOIN firm_user_companies allowed ON allowed.realm_id = scope_company.realm_id
      WHERE scope_signer.delivery_id = td.id AND allowed.firm_user_id = $${parameterNumber}
    )
  )`;
}

function relationshipAccessSql(relationshipExpression, firmExpression, parameterNumber) {
  return `(
    ${relationshipExpression} IS NULL
    OR NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $${parameterNumber})
    OR NOT EXISTS (SELECT 1 FROM companies related_company WHERE related_company.relationship_id = ${relationshipExpression} AND related_company.firm_id = ${firmExpression})
    OR EXISTS (
      SELECT 1 FROM companies related_company
      JOIN firm_user_companies allowed ON allowed.realm_id = related_company.realm_id
      WHERE related_company.relationship_id = ${relationshipExpression}
        AND related_company.firm_id = ${firmExpression}
        AND allowed.firm_user_id = $${parameterNumber}
    )
  )`;
}

async function assertPersonAccess(db, firmId, staffUserId, personId) {
  const id = positiveId(personId, 'person_id');
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const { rows } = await db.query(
    `SELECT p.id
       FROM people p
      WHERE p.id = $1 AND p.firm_id = $2
        AND (
          NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $3)
          OR NOT EXISTS (
            SELECT 1 FROM companies c WHERE c.relationship_id = p.relationship_id AND c.firm_id = p.firm_id
            UNION ALL
            SELECT 1 FROM person_company_access pca JOIN companies c ON c.id = pca.company_id
             WHERE pca.person_id = p.id AND c.firm_id = p.firm_id
          )
          OR EXISTS (
            SELECT 1 FROM companies c JOIN firm_user_companies allowed ON allowed.realm_id = c.realm_id
             WHERE c.relationship_id = p.relationship_id AND c.firm_id = p.firm_id AND allowed.firm_user_id = $3
          )
          OR EXISTS (
            SELECT 1 FROM person_company_access pca
            JOIN companies c ON c.id = pca.company_id
            JOIN firm_user_companies allowed ON allowed.realm_id = c.realm_id
             WHERE pca.person_id = p.id AND c.firm_id = p.firm_id AND allowed.firm_user_id = $3
          )
        )`,
    [id, firm, staff]
  );
  if (!rows[0]) throw new AgentBusinessError('Person not found', 404, 'person_not_found');
  return id;
}

async function assertRelationshipAccess(db, firmId, staffUserId, relationshipId) {
  const id = positiveId(relationshipId, 'relationship_id');
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const predicate = relationshipAccessSql('r.id', 'r.firm_id', 3);
  const { rows } = await db.query(`SELECT r.id FROM relationships r WHERE r.id = $1 AND r.firm_id = $2 AND ${predicate}`, [id, firm, staff]);
  if (!rows[0]) throw new AgentBusinessError('Relationship not found', 404, 'relationship_not_found');
  return id;
}

function runDto(row) {
  return {
    id: row.id,
    company_id: row.company_id || null,
    company_name: row.company_name ? text(row.company_name, 300) : null,
    run_date: row.run_date || null,
    status: row.status || null,
    transactions_found: Number(row.txns_found) || 0,
    transactions_auto_coded: Number(row.txns_auto_coded) || 0,
    transactions_ai_coded: Number(row.txns_ai_coded) || 0,
    transactions_manual_review: Number(row.txns_manual_review) || 0,
    transactions_failed: Number(row.txns_failed) || 0,
    new_mappings_created: Number(row.new_mappings_created) || 0,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
  };
}

function mappingDto(row) {
  return {
    id: row.id,
    company_id: row.company_id || null,
    company_name: row.company_name ? text(row.company_name, 300) : null,
    vendor_name: text(row.vendor_name, 500),
    direction: row.direction || null,
    account_name: text(row.account_name, 500),
    source: row.source || null,
    confidence: Number(row.confidence) || 0,
    usage_count: Number(row.usage_count) || 0,
    minimum_amount: numberOrNull(row.min_amount),
    maximum_amount: numberOrNull(row.max_amount),
    last_used_at: row.last_used_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function listBookkeepingRuns({ firmId, staffUserId, limit, db = pool }) {
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const bounded = boundedInt(limit, 20, 50);
  const { rows } = await db.query(
    `SELECT br.id, c.id AS company_id, c.company_name, br.run_date, br.status,
            br.txns_found, br.txns_auto_coded, br.txns_ai_coded, br.txns_manual_review,
            br.txns_failed, br.new_mappings_created, br.started_at, br.completed_at
       FROM bookkeeper_runs br
       LEFT JOIN companies c ON c.realm_id = br.realm_id AND c.firm_id = br.firm_id
      WHERE br.firm_id = $1
        AND (NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $2)
             OR EXISTS (SELECT 1 FROM firm_user_companies allowed WHERE allowed.firm_user_id = $2 AND allowed.realm_id = br.realm_id))
      ORDER BY br.started_at DESC, br.id DESC LIMIT $3`,
    [firm, staff, bounded]
  );
  return { runs: rows.map(runDto), limit: bounded };
}

async function listBookkeepingMappings({ firmId, staffUserId, realmId, search, limit, db = pool }) {
  const params = [positiveId(firmId, 'firm_id'), positiveId(staffUserId, 'staff_user_id')];
  let where = `vm.firm_id = $1
    AND (NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $2)
         OR EXISTS (SELECT 1 FROM firm_user_companies allowed WHERE allowed.firm_user_id = $2 AND allowed.realm_id = vm.realm_id))`;
  if (realmId) {
    const realm = String(realmId);
    if (realm.length > 100) throw new AgentBusinessError('realm_id must be 100 characters or fewer', 400, 'invalid_input');
    params.push(realm);
    where += ` AND vm.realm_id = $${params.length}`;
  }
  if (search) {
    const term = String(search).trim();
    if (term.length > 100) throw new AgentBusinessError('search must be 100 characters or fewer', 400, 'invalid_input');
    params.push(`%${term}%`);
    where += ` AND (vm.vendor_name ILIKE $${params.length} OR vm.account_name ILIKE $${params.length})`;
  }
  const bounded = boundedInt(limit, 50, 100);
  params.push(bounded);
  const { rows } = await db.query(
    `SELECT vm.id, c.id AS company_id, c.company_name, vm.vendor_name, vm.direction,
            vm.account_name, vm.source, vm.confidence, vm.usage_count, vm.min_amount,
            vm.max_amount, vm.last_used_at, vm.created_at, vm.updated_at
       FROM vendor_mapping vm
       LEFT JOIN companies c ON c.realm_id = vm.realm_id AND c.firm_id = vm.firm_id
      WHERE ${where}
      ORDER BY vm.usage_count DESC, vm.vendor_name ASC LIMIT $${params.length}`,
    params
  );
  return { mappings: rows.map(mappingDto), limit: bounded };
}

async function getBookkeepingOverview({ firmId, staffUserId, db = pool }) {
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const access = `(NOT EXISTS (SELECT 1 FROM firm_user_companies restricted WHERE restricted.firm_user_id = $2)
    OR EXISTS (SELECT 1 FROM firm_user_companies allowed WHERE allowed.firm_user_id = $2 AND allowed.realm_id = source.realm_id))`;
  const [{ rows: pending }, recent, { rows: mappings }] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS count, COUNT(DISTINCT source.realm_id) AS companies
         FROM (SELECT DISTINCT ON (realm_id, txn_qb_id) realm_id
                 FROM bookkeeper_uncoded
                WHERE firm_id = $1 AND status = 'pending' AND amount IS NOT NULL AND amount <> 0
                ORDER BY realm_id, txn_qb_id, run_id DESC, id DESC) source
        WHERE ${access}`,
      [firm, staff]
    ),
    listBookkeepingRuns({ firmId: firm, staffUserId: staff, limit: 7, db }),
    db.query(
      `SELECT COUNT(*) AS count FROM vendor_mapping source WHERE source.firm_id = $1 AND ${access}`,
      [firm, staff]
    ),
  ]);
  return {
    pending_count: Number(pending[0]?.count) || 0,
    pending_companies: Number(pending[0]?.companies) || 0,
    total_mappings: Number(mappings[0]?.count) || 0,
    recent_runs: recent.runs,
  };
}

function signerDto(row) {
  return {
    id: row.id,
    person_id: row.person_id,
    person_name: row.person_name ? text(row.person_name, 300) : null,
    signer_role: row.signer_role || null,
    approved_at: row.approved_at || null,
    signed_at: row.signed_at || null,
    signature_type: row.signature_type || null,
    needs_changes_at: row.needs_changes_at || null,
    needs_changes_note: text(row.needs_changes_note, 4000),
    signed_document_id: row.signed_doc_id || null,
  };
}

function taxSummaryDto(value) {
  const summary = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    federal_amount: numberOrNull(summary.federal_amount),
    state_amount: numberOrNull(summary.state_amount),
    due_date: typeof summary.due_date === 'string' ? summary.due_date : null,
    filing_status: typeof summary.filing_status === 'string' ? summary.filing_status : null,
  };
}

function deliveryDto(row, signers = []) {
  return {
    id: row.id,
    company_id: row.company_id || null,
    company_name: row.company_name ? text(row.company_name, 300) : null,
    tax_year: row.tax_year || '',
    title: text(row.title, 500),
    intro_note: text(row.intro_note, 4000),
    tax_summary: taxSummaryDto(row.tax_summary),
    review_document_id: row.review_doc_id || null,
    review_document_name: row.review_doc_name || null,
    signature_document_id: row.signature_doc_id || null,
    signature_document_name: row.signature_doc_name || null,
    signed_document_id: row.signed_doc_id || null,
    pipeline_job_id: row.pipeline_job_id || null,
    status: row.status || null,
    needs_changes_note: text(row.needs_changes_note, 4000),
    tax_report_status: row.tax_report_status || 'none',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    signers: signers.map(signerDto),
  };
}

async function deliverySigners(db, firmId, deliveryIds) {
  if (!deliveryIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT tds.id, tds.delivery_id, tds.person_id, tds.signer_role, tds.approved_at,
            tds.signed_at, tds.signature_type, tds.needs_changes_at, tds.needs_changes_note,
            signed_document.id AS signed_doc_id,
            NULLIF(CONCAT_WS(' ', p.first_name, p.last_name), '') AS person_name
       FROM tax_delivery_signers tds
       JOIN tax_deliveries td ON td.id = tds.delivery_id AND td.firm_id = $1
       JOIN people p ON p.id = tds.person_id AND p.firm_id = td.firm_id
       LEFT JOIN documents signed_document ON signed_document.id = tds.signed_doc_id AND signed_document.firm_id = td.firm_id
      WHERE tds.delivery_id = ANY($2::int[]) ORDER BY tds.id LIMIT 1000`,
    [firmId, deliveryIds]
  );
  const grouped = new Map();
  for (const row of rows) grouped.set(row.delivery_id, [...(grouped.get(row.delivery_id) || []), row]);
  return grouped;
}

async function listTaxDeliveries({ firmId, staffUserId, companyId, personId, limit, db = pool }) {
  const params = [positiveId(firmId, 'firm_id'), positiveId(staffUserId, 'staff_user_id')];
  let where = `td.firm_id = $1 AND ${companyAccessSql('td.company_id', 2)} AND ${personalDeliveryAccessSql(2)}`;
  if (companyId) {
    params.push(positiveId(companyId, 'company_id'));
    where += ` AND td.company_id = $${params.length}`;
  } else if (personId) {
    const id = await assertPersonAccess(db, firmId, staffUserId, personId);
    params.push(id);
    where += ` AND (EXISTS (SELECT 1 FROM tax_delivery_signers tds WHERE tds.delivery_id = td.id AND tds.person_id = $${params.length})
      OR EXISTS (SELECT 1 FROM person_company_access pca WHERE pca.person_id = $${params.length} AND pca.company_id = td.company_id))`;
  }
  const bounded = boundedInt(limit, 50, 100);
  params.push(bounded);
  const { rows } = await db.query(
    `SELECT td.id, td.company_id, c.company_name, td.tax_year, td.title, td.intro_note,
            td.tax_summary, rd.id AS review_doc_id, rd.display_name AS review_doc_name,
            sd.id AS signature_doc_id, sd.display_name AS signature_doc_name, signed_doc.id AS signed_doc_id,
            td.pipeline_job_id, td.status, td.needs_changes_note, td.tax_report_status,
            td.created_at, td.updated_at
       FROM tax_deliveries td
       LEFT JOIN companies c ON c.id = td.company_id AND c.firm_id = td.firm_id
       LEFT JOIN documents rd ON rd.id = td.review_doc_id AND rd.firm_id = td.firm_id
       LEFT JOIN documents sd ON sd.id = td.signature_doc_id AND sd.firm_id = td.firm_id
       LEFT JOIN documents signed_doc ON signed_doc.id = td.signed_doc_id AND signed_doc.firm_id = td.firm_id
      WHERE ${where} ORDER BY td.created_at DESC, td.id DESC LIMIT $${params.length}`,
    params
  );
  const grouped = await deliverySigners(db, params[0], rows.map(row => row.id));
  return { deliveries: rows.map(row => deliveryDto(row, grouped.get(row.id) || [])), limit: bounded };
}

async function getTaxDelivery({ firmId, staffUserId, deliveryId, db = pool }) {
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const id = positiveId(deliveryId, 'delivery_id');
  const { rows } = await db.query(
    `SELECT td.id, td.company_id, c.company_name, td.tax_year, td.title, td.intro_note,
            td.tax_summary, rd.id AS review_doc_id, rd.display_name AS review_doc_name,
            sd.id AS signature_doc_id, sd.display_name AS signature_doc_name, signed_doc.id AS signed_doc_id,
            td.pipeline_job_id, td.status, td.needs_changes_note, td.tax_report_status,
            td.created_at, td.updated_at
       FROM tax_deliveries td
       LEFT JOIN companies c ON c.id = td.company_id AND c.firm_id = td.firm_id
       LEFT JOIN documents rd ON rd.id = td.review_doc_id AND rd.firm_id = td.firm_id
       LEFT JOIN documents sd ON sd.id = td.signature_doc_id AND sd.firm_id = td.firm_id
       LEFT JOIN documents signed_doc ON signed_doc.id = td.signed_doc_id AND signed_doc.firm_id = td.firm_id
      WHERE td.id = $1 AND td.firm_id = $2 AND ${companyAccessSql('td.company_id', 3)} AND ${personalDeliveryAccessSql(3)} LIMIT 1`,
    [id, firm, staff]
  );
  if (!rows[0]) throw new AgentBusinessError('Tax delivery not found', 404, 'tax_delivery_not_found');
  const grouped = await deliverySigners(db, firm, [id]);
  return deliveryDto(rows[0], grouped.get(id) || []);
}

function normalizedTaxReport(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const client = data.client && typeof data.client === 'object' ? data.client : {};
  const verified = data.verified_facts && typeof data.verified_facts === 'object' ? data.verified_facts : {};
  const value = key => verified[key] && typeof verified[key] === 'object' ? verified[key].value : undefined;
  const refundOrBalance = resolveRefundOrBalance(data, verified)?.amount ?? null;
  return {
    adjusted_gross_income: value('adjusted_gross_income') ?? data.adjusted_gross_income ?? data.agi ?? data.total_income ?? null,
    taxable_income: value('taxable_income') ?? data.taxable_income ?? null,
    total_tax: value('total_tax') ?? data.total_tax ?? null,
    total_payments: value('total_payments') ?? data.total_payments ?? null,
    refund_or_balance_due: refundOrBalance,
    filing_status: value('filing_status') ?? client.filing_status ?? data.filing_status ?? null,
    tax_year: value('tax_year') ?? client.tax_year ?? data.tax_year ?? null,
    form_type: client.form_type ?? data.form_type ?? null,
    client_name: client.names ?? data.client_name ?? null,
  };
}

async function getTaxDeliverySummary({ firmId, staffUserId, deliveryId, db = pool }) {
  const delivery = await getTaxDelivery({ firmId, staffUserId, deliveryId, db });
  const { rows } = await db.query(
    'SELECT tax_report_data, tax_report_status, tax_report_error IS NOT NULL AS has_error FROM tax_deliveries WHERE id = $1 AND firm_id = $2',
    [delivery.id, positiveId(firmId, 'firm_id')]
  );
  return {
    delivery_id: delivery.id,
    status: rows[0]?.tax_report_status || 'none',
    data: normalizedTaxReport(rows[0]?.tax_report_data),
    has_error: rows[0]?.has_error === true,
  };
}

function organizerAnswers(raw) {
  const result = {};
  const answers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  for (let number = 1; number <= 17; number += 1) {
    const key = `q${number}`;
    const value = answers[key];
    result[key] = number === 17
      ? { answered: Boolean(typeof value === 'string' ? value.trim() : value?.details) }
      : { answer: typeof value === 'boolean' ? value : (typeof value?.answer === 'boolean' ? value.answer : null), details_provided: Boolean(value?.details) };
  }
  return result;
}

function organizerItemDto(row) {
  return {
    id: row.id,
    section: row.section || '',
    payer_name: text(row.payer_name, 500),
    owner: row.owner || null,
    prior_year_amount: numberOrNull(row.prior_year_amount),
    sentinel_provides: row.sentinel_provides === true,
    status: row.status || null,
    document_id: row.document_id || null,
    source: row.source || null,
    triggered_by: row.triggered_by || null,
    display_order: Number(row.display_order) || 0,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function organizerDto(row, items = []) {
  return {
    id: row.id,
    person_id: row.person_id,
    tax_year: row.tax_year || '',
    status: row.status || null,
    source_document_id: row.source_document_id || null,
    workpaper_document_id: row.workpaper_document_id || null,
    bulk_document_id: row.bulk_document_id || null,
    organizer_version: row.organizer_version || null,
    answers: organizerAnswers(row.question_answers),
    submitted_at: row.submitted_at || null,
    reviewed_at: row.reviewed_at || null,
    closed_at: row.closed_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    items: items.map(organizerItemDto),
  };
}

const ORGANIZER_SELECT = `o.id, o.person_id, o.tax_year, o.status,
  (SELECT d.id FROM documents d WHERE d.id = o.source_document_id AND d.firm_id = o.firm_id) AS source_document_id,
  (SELECT d.id FROM documents d WHERE d.id = o.workpaper_document_id AND d.firm_id = o.firm_id) AS workpaper_document_id,
  (SELECT d.id FROM documents d WHERE d.id = o.bulk_document_id AND d.firm_id = o.firm_id) AS bulk_document_id,
  o.question_answers, o.organizer_version,
  o.submitted_at, o.reviewed_at, o.closed_at, o.created_at, o.updated_at`;

async function organizerItems(db, firmId, organizerIds) {
  if (!organizerIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT i.id, i.organizer_id, i.section, i.payer_name, i.owner, i.prior_year_amount,
            i.sentinel_provides, i.status, document.id AS document_id, i.source, i.triggered_by,
            i.display_order, i.created_at, i.updated_at
       FROM tax_organizer_items i
       JOIN tax_organizers o ON o.id = i.organizer_id AND o.firm_id = $1
       LEFT JOIN documents document ON document.id = i.document_id AND document.firm_id = o.firm_id
      WHERE i.organizer_id = ANY($2::int[]) ORDER BY i.organizer_id, i.display_order, i.id LIMIT 1000`,
    [firmId, organizerIds]
  );
  const grouped = new Map();
  for (const row of rows) grouped.set(row.organizer_id, [...(grouped.get(row.organizer_id) || []), row]);
  return grouped;
}

async function listOrganizers({ firmId, staffUserId, personId, limit, db = pool }) {
  const person = await assertPersonAccess(db, firmId, staffUserId, personId);
  const bounded = boundedInt(limit, 20, 50);
  const { rows } = await db.query(
    `SELECT ${ORGANIZER_SELECT} FROM tax_organizers o
      WHERE o.person_id = $1 AND o.firm_id = $2
      ORDER BY o.tax_year DESC, o.id DESC LIMIT $3`,
    [person, positiveId(firmId, 'firm_id'), bounded]
  );
  const grouped = await organizerItems(db, positiveId(firmId, 'firm_id'), rows.map(row => row.id));
  return { organizers: rows.map(row => organizerDto(row, grouped.get(row.id) || [])), limit: bounded };
}

async function getOrganizer({ firmId, staffUserId, personId, year, db = pool }) {
  const person = await assertPersonAccess(db, firmId, staffUserId, personId);
  const normalizedYear = String(year || '');
  if (!/^(19|20|21)\d{2}$/.test(normalizedYear)) throw new AgentBusinessError('year must be a four-digit tax year', 400, 'invalid_input');
  const { rows } = await db.query(
    `SELECT ${ORGANIZER_SELECT} FROM tax_organizers o
      WHERE o.person_id = $1 AND o.tax_year = $2 AND o.firm_id = $3 LIMIT 1`,
    [person, normalizedYear, positiveId(firmId, 'firm_id')]
  );
  if (!rows[0]) throw new AgentBusinessError('Tax organizer not found', 404, 'organizer_not_found');
  const grouped = await organizerItems(db, firmId, [rows[0].id]);
  return organizerDto(rows[0], grouped.get(rows[0].id) || []);
}

function proposalTierDto(tier) {
  return {
    name: String(tier?.name || '').slice(0, 200),
    subtitle: String(tier?.subtitle || '').slice(0, 500),
    price: numberOrNull(tier?.price),
    bullets: (Array.isArray(tier?.bullets) ? tier.bullets : []).slice(0, 50).map(value => String(value).slice(0, 500)),
    recommended: tier?.recommended === true,
  };
}

function proposalAddOnDto(item) {
  return {
    description: String(item?.description || '').slice(0, 500),
    monthly_price: numberOrNull(item?.monthlyPrice ?? item?.monthly_price),
  };
}

function proposalBackworkDto(item) {
  return {
    description: String(item?.description || '').slice(0, 500),
    flat_fee: numberOrNull(item?.flatFee ?? item?.flat_fee),
  };
}

function proposalDto(row) {
  return {
    id: row.id,
    relationship_id: row.relationship_id || null,
    relationship_name: row.relationship_name ? text(row.relationship_name, 300) : null,
    title: text(row.title, 500),
    client_name: text(row.client_name, 300),
    client_email: text(row.client_email, 320),
    client_phone: text(row.client_phone, 100),
    engagement_type: row.engagement_type || null,
    tiers: (Array.isArray(row.tiers) ? row.tiers : []).slice(0, 20).map(proposalTierDto),
    add_ons: (Array.isArray(row.add_ons) ? row.add_ons : []).slice(0, 50).map(proposalAddOnDto),
    backwork: (Array.isArray(row.backwork) ? row.backwork : []).slice(0, 50).map(proposalBackworkDto),
    aum_fee_percent: numberOrNull(row.aum_fee_percent),
    require_dual_signature: row.require_dual_signature === true,
    status: row.status || null,
    expires_at: row.expires_at || null,
    viewed_at: row.viewed_at || null,
    accepted_at: row.accepted_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

const PROPOSAL_SELECT = `p.id, p.relationship_id, r.name AS relationship_name, p.title,
  p.client_name, p.client_email, p.client_phone, p.engagement_type, p.tiers, p.add_ons,
  p.backwork, p.aum_fee_percent, p.require_dual_signature, p.status, p.expires_at,
  p.viewed_at, p.accepted_at, p.created_at, p.updated_at`;

async function listProposals({ firmId, staffUserId, status, limit, db = pool }) {
  const params = [positiveId(firmId, 'firm_id'), positiveId(staffUserId, 'staff_user_id')];
  let where = `p.firm_id = $1 AND ${relationshipAccessSql('p.relationship_id', 'p.firm_id', 2)}`;
  if (status) {
    const allowed = new Set(['draft', 'sent', 'viewed', 'accepted', 'signed']);
    if (!allowed.has(status)) throw new AgentBusinessError('Invalid proposal status', 400, 'invalid_input');
    params.push(status);
    where += ` AND p.status = $${params.length}`;
  }
  const bounded = boundedInt(limit, 50, 100);
  params.push(bounded);
  const { rows } = await db.query(
    `SELECT ${PROPOSAL_SELECT} FROM proposals p
       LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
      WHERE ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length}`,
    params
  );
  return { proposals: rows.map(proposalDto), limit: bounded };
}

async function getProposal({ firmId, staffUserId, proposalId, db = pool }) {
  const id = positiveId(proposalId, 'proposal_id');
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const { rows } = await db.query(
    `SELECT ${PROPOSAL_SELECT} FROM proposals p
       LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = p.firm_id
      WHERE p.id = $1 AND p.firm_id = $2 AND ${relationshipAccessSql('p.relationship_id', 'p.firm_id', 3)} LIMIT 1`,
    [id, firm, staff]
  );
  if (!rows[0]) throw new AgentBusinessError('Proposal not found', 404, 'proposal_not_found');
  const [{ rows: acceptances }, { rows: engagements }] = await Promise.all([
    db.query(
      `SELECT selected_tier_index, selected_tier_indices, selected_tier_names, company_name,
              contact_name, entity_type, accepted_at
         FROM proposal_acceptances WHERE proposal_id = $1 ORDER BY accepted_at DESC LIMIT 1`,
      [id]
    ),
    db.query(
      `SELECT status, engagement_type, signed_by_name, signed_at, signed2_by_name, signed2_at,
              monthly_price, selected_tier_index, selected_tier_indices, tiers, add_ons, backwork,
              aum_fee_percent, require_dual_signature, saved_to_crm, created_at, updated_at
         FROM proposal_engagements WHERE proposal_id = $1 AND firm_id = $2 ORDER BY created_at DESC LIMIT 1`,
      [id, firm]
    ),
  ]);
  const acceptance = acceptances[0] ? {
    selected_tier_index: acceptances[0].selected_tier_index,
    selected_tier_indices: (Array.isArray(acceptances[0].selected_tier_indices) ? acceptances[0].selected_tier_indices : []).slice(0, 20).map(Number).filter(Number.isInteger),
    selected_tier_names: (Array.isArray(acceptances[0].selected_tier_names) ? acceptances[0].selected_tier_names : []).slice(0, 20).map(value => text(value, 200)),
    company_name: text(acceptances[0].company_name, 300),
    contact_name: text(acceptances[0].contact_name, 300),
    entity_type: text(acceptances[0].entity_type, 100),
    accepted_at: acceptances[0].accepted_at || null,
  } : null;
  const engagement = engagements[0] ? {
    status: engagements[0].status || null,
    engagement_type: engagements[0].engagement_type || null,
    signed_by_name: text(engagements[0].signed_by_name, 300),
    signed_at: engagements[0].signed_at || null,
    second_signed_by_name: text(engagements[0].signed2_by_name, 300),
    second_signed_at: engagements[0].signed2_at || null,
    monthly_price: numberOrNull(engagements[0].monthly_price),
    selected_tier_index: engagements[0].selected_tier_index,
    selected_tier_indices: (Array.isArray(engagements[0].selected_tier_indices) ? engagements[0].selected_tier_indices : []).slice(0, 20).map(Number).filter(Number.isInteger),
    tiers: (Array.isArray(engagements[0].tiers) ? engagements[0].tiers : []).slice(0, 20).map(proposalTierDto),
    add_ons: (Array.isArray(engagements[0].add_ons) ? engagements[0].add_ons : []).slice(0, 50).map(proposalAddOnDto),
    backwork: (Array.isArray(engagements[0].backwork) ? engagements[0].backwork : []).slice(0, 50).map(proposalBackworkDto),
    aum_fee_percent: numberOrNull(engagements[0].aum_fee_percent),
    require_dual_signature: engagements[0].require_dual_signature === true,
    saved_to_crm: engagements[0].saved_to_crm === true,
    created_at: engagements[0].created_at || null,
    updated_at: engagements[0].updated_at || null,
  } : null;
  return { ...proposalDto(rows[0]), acceptance, engagement };
}

async function getProposalStats({ firmId, staffUserId, db = pool }) {
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const predicate = relationshipAccessSql('p.relationship_id', 'p.firm_id', 2);
  const [{ rows: counts }, { rows: revenue }] = await Promise.all([
    db.query(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE p.status = 'sent') AS sent,
              COUNT(*) FILTER (WHERE p.status IN ('accepted','signed')) AS accepted_signed
         FROM proposals p WHERE p.firm_id = $1 AND ${predicate}`,
      [firm, staff]
    ),
    db.query(
      `SELECT COALESCE(SUM(pe.monthly_price), 0) AS mrr
         FROM proposal_engagements pe JOIN proposals p ON p.id = pe.proposal_id AND p.firm_id = pe.firm_id
        WHERE pe.firm_id = $1 AND pe.status = 'signed' AND ${predicate}`,
      [firm, staff]
    ),
  ]);
  return {
    total: Number(counts[0]?.total) || 0,
    sent: Number(counts[0]?.sent) || 0,
    accepted_signed: Number(counts[0]?.accepted_signed) || 0,
    monthly_recurring_revenue: numberOrNull(revenue[0]?.mrr) || 0,
  };
}

async function getBillingConfig({ firmId, staffUserId, relationshipId, db = pool }) {
  const relationship = await assertRelationshipAccess(db, firmId, staffUserId, relationshipId);
  const firm = positiveId(firmId, 'firm_id');
  const [{ rows }, { rows: people }, { rows: lines }] = await Promise.all([
    db.query(
      `SELECT billing_accounts, billing_emails, aum_billing_enabled, aum_person_id,
              aum_annual_rate, aum_min_monthly_fee, aum_override_monthly_fee
         FROM relationships WHERE id = $1 AND firm_id = $2`,
      [relationship, firm]
    ),
    db.query(
      `SELECT id, first_name, last_name, email, financial_planning_enabled
         FROM people WHERE relationship_id = $1 AND firm_id = $2 ORDER BY first_name, last_name, id LIMIT 100`,
      [relationship, firm]
    ),
    db.query(
      `SELECT id, person_id, label, enabled, annual_rate, min_monthly_fee, override_monthly_fee
         FROM relationship_aum_billing_lines WHERE relationship_id = $1 AND firm_id = $2 ORDER BY id LIMIT 100`,
      [relationship, firm]
    ),
  ]);
  const config = rows[0];
  if (!config) throw new AgentBusinessError('Billing configuration not found', 404, 'billing_config_not_found');
  const relationshipPersonIds = new Set(people.map(person => Number(person.id)));
  return {
    relationship_id: relationship,
    billing_accounts: (Array.isArray(config.billing_accounts) ? config.billing_accounts : [])
      .filter(account => typeof account === 'string' && /^[a-z0-9_-]{1,40}$/.test(account)).slice(0, 20),
    billing_emails: (Array.isArray(config.billing_emails) ? config.billing_emails : []).slice(0, 20).map(email => text(email, 320)),
    aum_billing_enabled: config.aum_billing_enabled === true,
    aum_person_id: relationshipPersonIds.has(Number(config.aum_person_id)) ? Number(config.aum_person_id) : null,
    aum_annual_rate: numberOrNull(config.aum_annual_rate),
    aum_minimum_monthly_fee: numberOrNull(config.aum_min_monthly_fee),
    aum_override_monthly_fee: numberOrNull(config.aum_override_monthly_fee),
    people: people.map(person => ({
      id: person.id,
      name: text([person.first_name, person.last_name].filter(Boolean).join(' '), 300),
      email: text(person.email, 320),
      financial_planning_enabled: person.financial_planning_enabled === true,
    })),
    aum_lines: lines.map(line => ({
      id: line.id,
      person_id: relationshipPersonIds.has(Number(line.person_id)) ? Number(line.person_id) : null,
      label: text(line.label, 300),
      enabled: line.enabled !== false,
      annual_rate: numberOrNull(line.annual_rate),
      minimum_monthly_fee: numberOrNull(line.min_monthly_fee),
      override_monthly_fee: numberOrNull(line.override_monthly_fee),
    })),
  };
}

function investmentPerformanceDto(performance) {
  const value = performance && typeof performance === 'object' ? performance : {};
  return {
    month_to_date: numberOrNull(value.mtd),
    quarter_to_date: numberOrNull(value.qtd),
    year_to_date: numberOrNull(value.ytd),
    last_month: numberOrNull(value.lastMonth),
    last_quarter: numberOrNull(value.lastQuarter),
    method: typeof value.method === 'string' ? value.method : null,
  };
}

function investmentAccountDto(account, hiddenIds) {
  const id = String(account?.id || '');
  return {
    name: text(account?.name || account?.accountName || 'Account', 300),
    institution_name: text(account?.institutionName, 300),
    account_type: text(account?.accountType, 200),
    balance: numberOrNull(account?.balance ?? account?.currentNetValue),
    hidden: id ? hiddenIds.has(id) : false,
  };
}

async function getPersonInvestments({ firmId, staffUserId, personId, db = pool }) {
  const person = await assertPersonAccess(db, firmId, staffUserId, personId);
  const firm = positiveId(firmId, 'firm_id');
  const { rows: people } = await db.query(
    'SELECT financial_planning_enabled, blueleaf_hidden_accounts FROM people WHERE id = $1 AND firm_id = $2',
    [person, firm]
  );
  if (!people[0]) throw new AgentBusinessError('Person not found', 404, 'person_not_found');
  if (!people[0].financial_planning_enabled) return { person_id: person, enabled: false, snapshot: null };
  const { rows } = await db.query(
    `SELECT snapshot_date, performance, accounts, raw_balance, synced_at
       FROM blueleaf_snapshots WHERE person_id = $1 AND firm_id = $2
      ORDER BY snapshot_date DESC, synced_at DESC LIMIT 1`,
    [person, firm]
  );
  if (!rows[0]) return { person_id: person, enabled: true, snapshot: null };
  const hidden = new Set((Array.isArray(people[0].blueleaf_hidden_accounts) ? people[0].blueleaf_hidden_accounts : []).map(String));
  return {
    person_id: person,
    enabled: true,
    snapshot: {
      snapshot_date: rows[0].snapshot_date || null,
      synced_at: rows[0].synced_at || null,
      total_balance: numberOrNull(rows[0].raw_balance),
      performance: investmentPerformanceDto(rows[0].performance),
      accounts: (Array.isArray(rows[0].accounts) ? rows[0].accounts : []).slice(0, 200).map(account => investmentAccountDto(account, hidden)),
    },
  };
}

function engagementLetterDto(row) {
  const extracted = row.extracted_data && typeof row.extracted_data === 'object' ? row.extracted_data : {};
  const services = extracted.services && typeof extracted.services === 'object' && !Array.isArray(extracted.services)
    ? Object.keys(extracted.services).slice(0, 100) : [];
  const monthlyItems = Array.isArray(extracted.monthly_line_items) ? extracted.monthly_line_items.slice(0, 100) : [];
  const oneTimeFees = Array.isArray(extracted.one_time_fees) ? extracted.one_time_fees.slice(0, 100) : [];
  const line = item => ({
    name: String(item?.name || item?.label || item?.description || '').slice(0, 200),
    amount: numberOrNull(item?.amount ?? item?.price),
  });
  return {
    id: row.id,
    relationship_id: row.relationship_id,
    relationship_name: text(row.relationship_name, 300),
    display_name: text(row.display_name, 500),
    client_name: extracted.client_name ? text(extracted.client_name, 300) : null,
    entity_name: extracted.entity_name ? text(extracted.entity_name, 300) : null,
    service_names: services,
    monthly_line_items: monthlyItems.map(line),
    total_monthly: numberOrNull(extracted.total_monthly),
    one_time_fees: oneTimeFees.map(line),
    term_end_date: extracted.term_end_date ? text(extracted.term_end_date, 100) : null,
    created_at: row.created_at || null,
  };
}

async function listEngagementLetters({ firmId, staffUserId, limit, db = pool }) {
  const firm = positiveId(firmId, 'firm_id');
  const staff = positiveId(staffUserId, 'staff_user_id');
  const bounded = boundedInt(limit, 50, 100);
  const { rows } = await db.query(
    `SELECT el.id, el.relationship_id, r.name AS relationship_name, el.display_name,
            el.extracted_data, el.created_at
       FROM engagement_letters el
       JOIN relationships r ON r.id = el.relationship_id AND r.firm_id = el.firm_id
      WHERE el.firm_id = $1 AND el.status = 'active'
        AND ${relationshipAccessSql('el.relationship_id', 'el.firm_id', 2)}
      ORDER BY el.created_at DESC, el.id DESC LIMIT $3`,
    [firm, staff, bounded]
  );
  return { engagement_letters: rows.map(engagementLetterDto), limit: bounded };
}

module.exports = {
  AgentBusinessError,
  getBillingConfig,
  getBookkeepingOverview,
  getOrganizer,
  getPersonInvestments,
  getProposal,
  getProposalStats,
  getTaxDelivery,
  getTaxDeliverySummary,
  listBookkeepingMappings,
  listBookkeepingRuns,
  listEngagementLetters,
  listOrganizers,
  listProposals,
  listTaxDeliveries,
};
