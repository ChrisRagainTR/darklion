'use strict';
const { backgroundJobsEnabled } = require('./runtimeSafety');
const { completeText } = require('./managedInference');

const { pool } = require('../db');
const { downloadFile } = require('./s3');
const { extractPdfText } = require('./pdfExtract');
const { analyzeTaxReturn } = require('./taxAnalysis');

const WORKER_INTERVAL_MS = parseInt(process.env.EMMA_DRAFT_WORKER_INTERVAL_MS || '10000', 10);
const MAX_ATTEMPTS = parseInt(process.env.EMMA_DRAFT_MAX_ATTEMPTS || '3', 10);
const JOB_TIMEOUT_MINUTES = parseInt(process.env.EMMA_DRAFT_JOB_TIMEOUT_MINUTES || '5', 10);

let workerStarted = false;
let workerTimer = null;
let workerRunning = false;
let appRef = null;

function compact(value, maxChars = 24000) {
  const json = JSON.stringify(value, null, 2);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}\n... [truncated]`;
}

function parseClaudeJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

function normalizeTaxReportData(data) {
  if (!data || typeof data !== 'object') return null;
  const client = data.client || {};
  return {
    agi: data.adjusted_gross_income ?? data.agi ?? data.total_income ?? null,
    adjusted_gross_income: data.adjusted_gross_income ?? data.agi ?? data.total_income ?? null,
    taxable_income: data.taxable_income ?? null,
    total_tax: data.total_tax ?? null,
    refund_or_balance_due: data.refund_or_owed_amount ?? data.refund_or_balance_due ?? null,
    is_refund: data.is_refund ?? null,
    filing_status: client.filing_status ?? data.filing_status ?? null,
    tax_year: client.tax_year ?? data.tax_year ?? null,
    form_type: client.form_type ?? data.form_type ?? null,
    client_name: client.names ?? data.client_name ?? null,
    raw: data,
  };
}

function parseAmountToken(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, '').replace(/[()]/g, match => match === '(' ? '-' : '');
  const n = Number(cleaned.replace(/\)$/g, ''));
  return Number.isFinite(n) ? n : null;
}

function extractNearbyAmount(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const amount = [...match].slice(1).map(parseAmountToken).find(v => v !== null);
    if (amount !== undefined) return amount;
  }
  return null;
}

function extractTaxFactsFromText(pdfText) {
  const text = String(pdfText || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
  const flat = text.replace(/\n/g, ' ');

  const facts = {
    adjusted_gross_income: extractNearbyAmount(flat, [
      /(?:line\s*)?11\s+Adjusted gross income\s+(-?\(?\$?[\d,]+\)?)/i,
      /Adjusted gross income\s+(?:line\s*)?11\s+(-?\(?\$?[\d,]+\)?)/i,
      /Adjusted gross income\s+(-?\(?\$?[\d,]+\)?)/i,
      /Total AGI\s+(-?\(?\$?[\d,]+\)?)/i,
    ]),
    taxable_income: extractNearbyAmount(flat, [
      /(?:line\s*)?15\s+Taxable income\s+(-?\(?\$?[\d,]+\)?)/i,
      /Taxable income\s+(?:line\s*)?15\s+(-?\(?\$?[\d,]+\)?)/i,
      /Taxable income\s+(-?\(?\$?[\d,]+\)?)/i,
    ]),
    total_tax: extractNearbyAmount(flat, [
      /(?:line\s*)?24\s+Total tax\s+(-?\(?\$?[\d,]+\)?)/i,
      /Total tax\s+(?:line\s*)?24\s+(-?\(?\$?[\d,]+\)?)/i,
    ]),
    refund_or_balance_due: extractNearbyAmount(flat, [
      /(?:line\s*)?34\s+(?:Amount )?you overpaid\s+(-?\(?\$?[\d,]+\)?)/i,
      /(?:line\s*)?37\s+Amount you owe\s+(-?\(?\$?[\d,]+\)?)/i,
      /Refund\s+(-?\(?\$?[\d,]+\)?)/i,
      /Balance due\s+(-?\(?\$?[\d,]+\)?)/i,
    ]),
    filing_status: null,
    tax_year: null,
  };

  const yearMatch = text.match(/(?:Form\s+1040(?:-SR)?\s+)?(?:U\.S\.\s+)?Individual Income Tax Return\s+(20\d{2})/i)
    || text.match(/Tax Return Comparison\s+(20\d{2})/i)
    || text.match(/\b(20\d{2})\s+Federal Tax Return/i);
  if (yearMatch) facts.tax_year = yearMatch[1];

  const statuses = ['Single', 'Married filing jointly', 'Married filing separately', 'Head of household', 'Qualifying surviving spouse'];
  const status = statuses.find(s => new RegExp(s, 'i').test(flat));
  if (status) facts.filing_status = status;

  return Object.fromEntries(Object.entries(facts).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

function latestClientText(context) {
  const messages = context.thread_messages || [];
  const latest = [...messages].reverse().find(m => m.sender_type === 'client' && m.body);
  return latest?.body || '';
}

function detectRequestedFacts(context) {
  const text = latestClientText(context);
  const lower = text.toLowerCase();
  const facts = [];
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;

  if (/\bagi\b|adjusted gross income/.test(lower)) facts.push({ type: 'adjusted_gross_income', label: `${year || 'latest'} AGI`, year });
  if (/taxable income/.test(lower)) facts.push({ type: 'taxable_income', label: `${year || 'latest'} taxable income`, year });
  if (/\b(total )?tax\b/.test(lower) && !/tax return|tax document|tax file/.test(lower)) facts.push({ type: 'total_tax', label: `${year || 'latest'} total tax`, year });
  if (/refund|balance due|owe|owed|payment due/.test(lower)) facts.push({ type: 'refund_or_balance_due', label: `${year || 'latest'} refund/balance due`, year });
  if (/filing status/.test(lower)) facts.push({ type: 'filing_status', label: `${year || 'latest'} filing status`, year });

  return facts;
}

function draftLooksLikeFactFiller(text) {
  const lower = String(text || '').toLowerCase();
  return [
    /i(?:'|’)m (?:pulling|looking|checking)/,
    /i (?:will|’ll|'ll) (?:pull|check|review|verify|get|have)/,
    /we(?:'|’)ll (?:pull|check|review|verify|get|have)/,
    /our team (?:will|can|needs to|need to) (?:pull|check|review|verify|get)/,
    /available in (?:your|the) tax return documents/,
    /need to pull the specific/,
    /get (?:that|this) (?:information|figure|number) to you (?:shortly|soon|right away)/,
    /get back to you/,
  ].some(pattern => pattern.test(lower));
}

function validateDraftAgainstResolvedFacts(context, draftResult) {
  const requested = context.fact_resolution?.requested || [];
  if (!requested.length) return;

  const resolved = context.fact_resolution?.resolved || [];
  if (!resolved.length) {
    throw new Error('Refusing to save client-facing draft: requested concrete fact was not resolved');
  }

  const body = draftResult?.draft_body || '';
  if (draftLooksLikeFactFiller(body)) {
    throw new Error('Refusing to save client-facing draft: draft used filler language instead of the resolved fact');
  }

  const missingResolvedValue = resolved.find(fact => fact.formatted_value && !body.includes(fact.formatted_value));
  if (missingResolvedValue) {
    throw new Error(`Refusing to save client-facing draft: resolved ${missingResolvedValue.label} (${missingResolvedValue.formatted_value}) was not included`);
  }
}

function docLooksLikeTaxReturn(doc) {
  const name = `${doc.display_name || ''} ${doc.doc_type || ''} ${doc.folder_category || ''}`.toLowerCase();
  return (doc.mime_type === 'application/pdf' || /\.pdf$/i.test(doc.display_name || ''))
    && (/tax/.test(name) || /1040/.test(name) || /federal/.test(name))
    && !/organizer|1099|w-2|w2|consolidated|voucher/.test(name);
}

async function extractTaxDataForDocument(firmId, doc) {
  const { rows } = await pool.query(
    `SELECT td.id AS delivery_id, td.tax_report_status, td.tax_report_data, d.display_name AS document_name
       FROM documents d
       JOIN tax_deliveries td ON td.firm_id = d.firm_id
        AND d.id IN (td.review_doc_id, td.signature_doc_id)
      WHERE d.id = $1 AND d.firm_id = $2
      ORDER BY td.updated_at DESC
      LIMIT 1`,
    [doc.id, firmId]
  );
  const linked = rows[0];
  const normalized = normalizeTaxReportData(linked?.tax_report_data);
  if (normalized && Object.entries(normalized).some(([key, value]) => key !== 'raw' && value !== null && value !== undefined && value !== '')) {
    return {
      document_id: doc.id,
      document_name: linked.document_name || doc.display_name,
      delivery_id: linked.delivery_id,
      extraction_status: linked.tax_report_status || 'completed',
      source: 'tax_report_data',
      ...normalized,
    };
  }

  const { rows: docRows } = await pool.query(
    'SELECT id, display_name, s3_key, s3_bucket, mime_type FROM documents WHERE id = $1 AND firm_id = $2',
    [doc.id, firmId]
  );
  const fullDoc = docRows[0];
  if (!fullDoc) throw new Error(`Document ${doc.id} not found`);
  if (fullDoc.mime_type && fullDoc.mime_type !== 'application/pdf') throw new Error(`Document ${doc.id} is not a PDF`);

  const buffer = await downloadFile({ key: fullDoc.s3_key, bucket: fullDoc.s3_bucket });
  const pdfText = await extractPdfText(buffer);
  const deterministicFacts = extractTaxFactsFromText(pdfText);
  let reportData = null;
  try {
    reportData = await analyzeTaxReturn(pdfText);
  } catch (err) {
    if (!Object.keys(deterministicFacts).length) throw err;
  }
  const liveNormalized = normalizeTaxReportData(reportData) || {};
  return {
    document_id: fullDoc.id,
    document_name: fullDoc.display_name,
    delivery_id: null,
    extraction_status: 'completed',
    source: reportData ? 'live_pdf_extraction' : 'deterministic_pdf_text_extraction',
    ...liveNormalized,
    ...deterministicFacts,
  };
}

async function buildResearchPacket(context) {
  const requestedFacts = detectRequestedFacts(context);
  const packet = {
    request_type: requestedFacts.length ? 'tax_fact' : 'general_reply',
    started_at: new Date().toISOString(),
    latest_client_message: latestClientText(context),
    scoped_staff_user_id: context.thread?.staff_user_id || null,
    requested_facts: requestedFacts,
    documents_considered: (context.documents || []).filter(docLooksLikeTaxReturn).map(doc => ({
      id: doc.id,
      display_name: doc.display_name,
      year: doc.year,
      doc_type: doc.doc_type,
      folder_category: doc.folder_category,
      created_at: doc.created_at,
    })),
    verified_facts: [],
    missing_facts: [],
    extraction_errors: [],
    open_questions: [],
  };

  const factResolution = await resolveRequestedFacts(context);
  packet.verified_facts = factResolution.resolved.map(f => ({
    label: f.label,
    type: f.type,
    value: f.value,
    formatted_value: f.formatted_value,
    tax_year: f.tax_year,
    source: f.source,
    source_document_id: f.document_id,
    source_document_name: f.document_name,
  }));
  packet.missing_facts = factResolution.missing;
  packet.extraction_errors = factResolution.extraction_errors;
  packet.completed_at = new Date().toISOString();

  return { packet, factResolution };
}

async function resolveRequestedFacts(context) {
  const requested = detectRequestedFacts(context);
  if (!requested.length) return { requested: [], resolved: [], missing: [], required_missing: false };

  const docs = (context.documents || [])
    .filter(docLooksLikeTaxReturn)
    .sort((a, b) => String(b.year || '').localeCompare(String(a.year || '')) || new Date(b.created_at || 0) - new Date(a.created_at || 0));

  const resolved = [];
  const missing = [];
  const extractionErrors = [];
  const extractionCache = new Map();

  for (const fact of requested) {
    const candidates = docs.filter(d => !fact.year || String(d.year || '') === String(fact.year));
    if (!candidates.length) {
      missing.push({ ...fact, reason: fact.year ? `No ${fact.year} tax return PDF found in context` : 'No tax return PDF found in context' });
      continue;
    }

    let found = null;
    for (const doc of candidates.slice(0, 3)) {
      try {
        let extracted = extractionCache.get(doc.id);
        if (!extracted) {
          extracted = await extractTaxDataForDocument(context.job.firm_id, doc);
          extractionCache.set(doc.id, extracted);
        }
        const value = extracted?.[fact.type];
        if (value !== null && value !== undefined && value !== '') {
          found = {
            ...fact,
            value,
            formatted_value: typeof value === 'number' ? money(value) : String(value),
            source: extracted.source,
            document_id: extracted.document_id,
            document_name: extracted.document_name,
            tax_year: extracted.tax_year || doc.year || fact.year || null,
            filing_status: extracted.filing_status || null,
          };
          break;
        }
      } catch (err) {
        extractionErrors.push({ document_id: doc.id, document_name: doc.display_name, error: err.message });
      }
    }

    if (found) resolved.push(found);
    else missing.push({ ...fact, reason: 'Requested fact was not found in extracted tax return data', extraction_errors: extractionErrors.slice(-3) });
  }

  return { requested, resolved, missing, extraction_errors: extractionErrors, required_missing: missing.length > 0 };
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS emma_draft_jobs (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','cancelled')),
      priority INTEGER NOT NULL DEFAULT 5,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      research_packet JSONB,
      draft_id INTEGER REFERENCES message_drafts(id) ON DELETE SET NULL,
      requested_by INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      source_event TEXT NOT NULL DEFAULT 'inbox.message.received',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query('ALTER TABLE emma_draft_jobs ADD COLUMN IF NOT EXISTS research_packet JSONB');
  await pool.query('CREATE INDEX IF NOT EXISTS emma_draft_jobs_queue ON emma_draft_jobs(status, priority, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS emma_draft_jobs_thread ON emma_draft_jobs(thread_id, created_at DESC)');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS emma_draft_jobs_source_message_unique
    ON emma_draft_jobs(source_message_id)
    WHERE source_message_id IS NOT NULL AND source_event = 'inbox.message.received'
  `);
}

async function enqueueEmmaDraftJob({ firmId, threadId, sourceMessageId = null, staffUserId = null, personId = null, requestedBy = null, sourceEvent = 'inbox.message.received', priority = 5 }) {
  if (!firmId || !threadId) throw new Error('firmId and threadId are required');
  await ensureSchema();

  const params = [firmId, threadId, sourceMessageId, staffUserId, personId, requestedBy, sourceEvent, priority];
  const { rows } = await pool.query(
    `INSERT INTO emma_draft_jobs (firm_id, thread_id, source_message_id, staff_user_id, person_id, requested_by, source_event, priority)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_message_id) WHERE source_message_id IS NOT NULL AND source_event = 'inbox.message.received'
     DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    params
  );

  if (backgroundJobsEnabled()) {
    setImmediate(() => processNextEmmaDraftJob().catch(err => console.error('[emma-draft-jobs] immediate process error:', err.message)));
  }
  return rows[0];
}

async function claimNextJob() {
  await ensureSchema();
  const { rows } = await pool.query(
    `WITH picked AS (
       SELECT id
       FROM emma_draft_jobs
       WHERE status = 'pending'
          OR (status = 'processing' AND started_at < NOW() - ($1 || ' minutes')::INTERVAL AND attempts < $2)
       ORDER BY priority ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE emma_draft_jobs j
     SET status = 'processing', attempts = attempts + 1, started_at = NOW(), updated_at = NOW(), last_error = NULL
     FROM picked
     WHERE j.id = picked.id
     RETURNING j.*`,
    [JOB_TIMEOUT_MINUTES, MAX_ATTEMPTS]
  );
  return rows[0] || null;
}

async function getThreadContext(job) {
  const firmId = job.firm_id;
  const threadId = job.thread_id;
  const personId = job.person_id;

  const context = { job: { id: job.id, firm_id: firmId, source_event: job.source_event, source_message_id: job.source_message_id } };

  const { rows: threadRows } = await pool.query(
    `SELECT mt.id, mt.subject, mt.status, mt.category, mt.last_message_at, mt.created_at,
            COALESCE(mt.staff_user_id, mt.assigned_to, $3) AS staff_user_id,
            p.id AS person_id, p.first_name, p.last_name, p.email, p.phone, p.filing_status, p.notes AS person_notes,
            r.id AS relationship_id, r.name AS relationship_name, r.service_tier, r.billing_status, r.notes AS relationship_notes,
            r.stripe_customer_id, r.stripe_subscription_id,
            fu.name AS staff_name, fu.display_name AS staff_display_name, fu.email AS staff_email
     FROM message_threads mt
     JOIN people p ON p.id = mt.person_id AND p.firm_id = mt.firm_id
     LEFT JOIN relationships r ON r.id = p.relationship_id AND r.firm_id = mt.firm_id
     LEFT JOIN firm_users fu ON fu.id = COALESCE(mt.staff_user_id, mt.assigned_to, $3) AND fu.firm_id = mt.firm_id
     WHERE mt.id = $1 AND mt.firm_id = $2`,
    [threadId, firmId, job.staff_user_id]
  );
  const thread = threadRows[0];
  if (!thread) throw new Error(`Thread ${threadId} not found`);

  const clientName = [thread.first_name, thread.last_name].filter(Boolean).join(' ').trim() || thread.relationship_name || 'Client';
  context.thread = {
    id: thread.id,
    subject: thread.subject,
    status: thread.status,
    category: thread.category,
    staff_user_id: thread.staff_user_id,
    last_message_at: thread.last_message_at,
    assigned_staff: thread.staff_display_name || thread.staff_name || thread.staff_email || null,
  };
  context.client = {
    person_id: thread.person_id,
    name: clientName,
    email: thread.email,
    phone: thread.phone,
    filing_status: thread.filing_status,
    notes: thread.person_notes,
    relationship_id: thread.relationship_id,
    relationship_name: thread.relationship_name,
    service_tier: thread.service_tier,
    billing_status: thread.billing_status,
    relationship_notes: thread.relationship_notes,
    stripe_customer_id_present: !!thread.stripe_customer_id,
    stripe_subscription_id_present: !!thread.stripe_subscription_id,
  };

  const relId = thread.relationship_id;
  const effectivePersonId = personId || thread.person_id;

  const { rows: messageRows } = await pool.query(
    `SELECT m.id, m.sender_type, m.sender_id, m.body, m.is_internal, m.created_at,
            CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email)
                 WHEN m.sender_type = 'client' THEN $2
                 ELSE 'Emma' END AS sender_name,
            COUNT(ma.id)::INT AS attachment_count
     FROM messages m
     LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
     LEFT JOIN message_attachments ma ON ma.message_id = m.id
     WHERE m.thread_id = $1
     GROUP BY m.id, fu.display_name, fu.name, fu.email
     ORDER BY m.created_at DESC
     LIMIT 30`,
    [threadId, clientName]
  );
  context.thread_messages = messageRows.reverse();

  const { rows: recentRows } = await pool.query(
    `SELECT mt.id AS thread_id, mt.subject, mt.status, mt.category, m.id AS message_id, m.sender_type, m.body, m.created_at
     FROM message_threads mt
     JOIN messages m ON m.thread_id = mt.id
     WHERE mt.firm_id = $1
       AND mt.person_id = $2::int
       AND mt.id <> $3
       AND COALESCE(mt.staff_user_id, mt.assigned_to) = $4::int
       AND m.is_internal = false
     ORDER BY m.created_at DESC
     LIMIT 25`,
    [firmId, effectivePersonId, threadId, job.staff_user_id]
  );
  context.recent_client_messages = recentRows.reverse();

  if (relId) {
    const { rows: peopleRows } = await pool.query(
      `SELECT id, first_name, last_name, email, phone, filing_status, portal_enabled, personal_tax_engaged, financial_planning_enabled, notes
       FROM people WHERE firm_id = $1 AND relationship_id = $2::int ORDER BY last_name, first_name LIMIT 20`,
      [firmId, relId]
    );
    context.relationship_people = peopleRows;

    const { rows: companyRows } = await pool.query(
      `SELECT c.id, c.company_name, c.entity_type, c.status, c.bookkeeping_service, c.tax_year_end, c.notes,
              pca.person_id, pca.access_level, pca.ownership_pct
       FROM companies c
       LEFT JOIN person_company_access pca ON pca.company_id = c.id
       WHERE c.firm_id = $1 AND (c.relationship_id = $2::int OR pca.person_id IN (SELECT id FROM people WHERE relationship_id = $2::int AND firm_id = $1))
       ORDER BY c.company_name LIMIT 30`,
      [firmId, relId]
    );
    context.companies = companyRows;
  } else {
    context.relationship_people = [];
    context.companies = [];
  }

  const companyIds = (context.companies || []).map(c => c.id).filter(Boolean);

  const { rows: docRows } = await pool.query(
    `SELECT id, owner_type, owner_id, doc_type, display_name, mime_type, year, folder_section, folder_category, is_delivered, created_at
     FROM documents
     WHERE firm_id = $1
       AND ((owner_type = 'person' AND owner_id = $2::int)
         OR ($3::int[] IS NOT NULL AND owner_type = 'company' AND owner_id = ANY($3::int[])))
     ORDER BY created_at DESC
     LIMIT 25`,
    [firmId, effectivePersonId, companyIds.length ? companyIds : null]
  );
  context.documents = docRows;

  const { rows: taxRows } = await pool.query(
    `SELECT td.id, td.company_id, c.company_name, td.tax_year, td.title, td.status, td.tax_summary, td.tax_report_status, td.tax_report_data, td.updated_at
     FROM tax_deliveries td
     LEFT JOIN companies c ON c.id = td.company_id
     WHERE td.firm_id = $1 AND ($2::int[] IS NOT NULL AND td.company_id = ANY($2::int[]))
     ORDER BY td.updated_at DESC NULLS LAST, td.created_at DESC
     LIMIT 8`,
    [firmId, companyIds.length ? companyIds : null]
  );
  context.tax_deliveries = taxRows.map(row => ({
    ...row,
    tax_report_data: row.tax_report_data ? {
      filing_status: row.tax_report_data.filing_status,
      tax_year: row.tax_report_data.tax_year,
      adjusted_gross_income: row.tax_report_data.adjusted_gross_income || row.tax_report_data.agi,
      taxable_income: row.tax_report_data.taxable_income,
      total_tax: row.tax_report_data.total_tax,
      refund_or_balance_due: row.tax_report_data.refund_or_balance_due,
    } : null,
  }));

  const { rows: bkRows } = await pool.query(
    `SELECT bu.id, c.id AS company_id, COALESCE(c.company_name, bu.company_name) AS company_name,
            bu.txn_date, bu.txn_type, bu.vendor_name, bu.description, bu.amount,
            bu.status, bu.sent_to_client, bu.coded_by_client, bu.coded_by_client_account, bu.report_date
     FROM bookkeeper_uncoded bu
     LEFT JOIN companies c ON c.realm_id = bu.realm_id AND c.firm_id = bu.firm_id
     WHERE bu.firm_id = $1 AND ($2::int[] IS NOT NULL AND c.id = ANY($2::int[]))
     ORDER BY bu.report_date DESC, bu.id DESC
     LIMIT 20`,
    [firmId, companyIds.length ? companyIds : null]
  ).catch(() => ({ rows: [] }));
  context.bookkeeping = bkRows;

  const { rows: blueleafRows } = await pool.query(
    `SELECT person_id, snapshot_date, raw_balance, performance, accounts, synced_at
     FROM blueleaf_snapshots
     WHERE firm_id = $1 AND person_id IN (SELECT id FROM people WHERE firm_id = $1 AND relationship_id = $2::int)
     ORDER BY snapshot_date DESC, synced_at DESC
     LIMIT 5`,
    [firmId, relId || 0]
  ).catch(() => ({ rows: [] }));
  context.investments = blueleafRows.map(row => ({
    person_id: row.person_id,
    snapshot_date: row.snapshot_date,
    raw_balance: row.raw_balance,
    synced_at: row.synced_at,
    account_count: Array.isArray(row.accounts) ? row.accounts.length : null,
    performance: row.performance || {},
  }));

  const { rows: pipelineRows } = await pool.query(
    `SELECT pj.id, pj.name, pj.status, pj.due_date, pj.updated_at, ps.name AS stage_name, pt.name AS pipeline_name
     FROM pipeline_jobs pj
     LEFT JOIN pipeline_stages ps ON ps.id = pj.stage_id
     LEFT JOIN pipeline_instances pi ON pi.id = pj.instance_id
     LEFT JOIN pipeline_templates pt ON pt.id = pi.template_id
     WHERE pj.firm_id = $1 AND (
       (pj.entity_type = 'person' AND pj.entity_id = $2)
       OR ($3::int[] IS NOT NULL AND pj.entity_type = 'company' AND pj.entity_id = ANY($3::int[]))
       OR ($4::int IS NOT NULL AND pj.entity_type = 'relationship' AND pj.entity_id = $4)
     )
     ORDER BY COALESCE(pj.due_date, pj.updated_at::date) DESC NULLS LAST
     LIMIT 15`,
    [firmId, effectivePersonId, companyIds.length ? companyIds : null, relId]
  ).catch(() => ({ rows: [] }));
  context.work_pipeline = pipelineRows;

  return context;
}

async function generateDraftFromContext(context) {
  const researchedDraft = generateDraftFromResearchPacket(context);
  if (researchedDraft) return researchedDraft;

  const preferences=await require('./firmPreferences').getFirmPreferences(context.job.firm_id);
  const text = await completeText({firmId:context.job.firm_id,feature:'reply-draft',maxTokens:1100,prompt:`You are Emma, preparing a client portal reply draft for ${preferences.name} staff to review before sending.

Act like a knowledgeable firm staff person, not a generic writing assistant. Use the context provided to understand the client before drafting: current thread, recent messages for the same assigned staff user, relationship/client profile, household people, companies, documents, tax deliveries/extracted tax data, bookkeeping items, billing/service context, investment snapshots, and pipeline/work status when present.

Inbox context is scoped to the assigned staff user for this thread. Do not mention another staff member’s inbox, queue, assignment, or hidden duplicate thread in the client-facing draft. If cross-staff duplicate context is ever supplied, treat it as internal diagnostics only.

The research phase has already done the work before you draft. Use context.research_packet as the authoritative research record. If research_packet.verified_facts contains a requested fact, state that fact directly in the draft. Do not say the team needs to pull, check, review, or verify that same fact.

Drafting rules:
- Draft only. Do not send.
- If context.fact_resolution.resolved contains verified facts, use those facts as the source of truth and include the requested verified answer in the draft. Do not replace verified facts with vague status language.
- If context.fact_resolution.required_missing is true, do not produce a client-facing placeholder; the job should fail before this prompt is used.
- The draft_body must be only the client-facing message body, with no subject line and no staff-only commentary.
- Write as ${preferences.name} staff, not as an AI.
- Be warm, clear, professional, concise, and specific.
- First identify the concrete thing the client is asking for. If they ask for a number, date, status, document fact, tax figure, billing fact, or next step, find that answer in the context and put the answer in the draft.
- If the answer is present in the context, DO NOT draft filler like “I’m pulling that up,” “I’ll check,” “I’ll get back to you,” “I’ll have that shortly,” or “we will verify” instead of answering. Padding is worse than silence.
- For tax-return questions, use extracted tax data/tax delivery data when present. If AGI/adjusted_gross_income is present, include the exact AGI figure. If taxable income, total tax, refund/balance due, filing status, tax year, or document status is directly requested and present, include the exact fact.
- Directly answer the client's latest message when the answer is supported by context.
- Do not fabricate facts, dates, filing status, balances, refund/payment amounts, AGI, taxable income, investment values, billing status, filing dates, document contents, or promises.
- If the context truly does not contain the requested fact, keep the client-facing draft useful and honest, and explain exactly what is missing in staff_notes. Only then may the draft say staff will verify.
- If the client is frustrated or confused, acknowledge that calmly, but still answer the substantive question if the data is present.
- Simple messages should get simple drafts; tax/bookkeeping/billing/IRS/deadline/document/investment/planning questions should reflect deeper review.
- Put risks, missing data, verification needs, context used, and suggested next actions in staff_notes, not in the client-facing draft.

Return ONLY valid JSON with this shape:
{
  "draft_body": "client-facing message body only, no subject line",
  "confidence": 0.0,
  "staff_notes": "brief internal notes on context used, uncertainties, risks, and suggested next action"
}

Context JSON:
${compact(context, 30000)}`});
  const parsed = parseClaudeJson(text);
  if (!parsed?.draft_body) {
    return {
      draft_body: text.trim(),
      confidence: 0.45,
      staff_notes: 'Emma returned non-JSON output; review carefully before sending.',
    };
  }
  return {
    draft_body: String(parsed.draft_body || '').trim(),
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    staff_notes: String(parsed.staff_notes || '').trim(),
  };
}

function firstName(name, fallback = 'there') {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || fallback;
}

function sentenceForVerifiedFact(fact) {
  const value = fact.formatted_value || String(fact.value || '').trim();
  const year = fact.tax_year || (String(fact.label || '').match(/\b(20\d{2})\b/) || [])[1] || '';
  switch (fact.type) {
    case 'adjusted_gross_income':
      return `Your ${year ? `${year} ` : ''}AGI was ${value}.`;
    case 'taxable_income':
      return `Your ${year ? `${year} ` : ''}taxable income was ${value}.`;
    case 'total_tax':
      return `Your ${year ? `${year} ` : ''}total tax was ${value}.`;
    case 'refund_or_balance_due':
      return `Your ${year ? `${year} ` : ''}refund/balance due amount was ${value}.`;
    case 'filing_status':
      return `Your ${year ? `${year} ` : ''}filing status was ${value}.`;
    default:
      return `${fact.label || 'The requested fact'} was ${value}.`;
  }
}

function generateDraftFromResearchPacket(context) {
  const packet = context.research_packet;
  const requestedFacts = packet?.requested_facts || [];
  const verifiedFacts = packet?.verified_facts || [];
  if (!requestedFacts.length || !verifiedFacts.length) return null;
  if (verifiedFacts.length < requestedFacts.length) return null;

  const clientFirst = firstName(context.client?.name, 'there');
  const staffFirst = firstName(context.thread?.assigned_staff, 'Your team');
  const factLines = verifiedFacts.map(sentenceForVerifiedFact);
  const body = [
    `Hi ${clientFirst},`,
    '',
    factLines.join(' '),
    '',
    'Best,',
    staffFirst,
  ].join('\n');

  const sources = verifiedFacts
    .map(f => `${f.label}: ${f.formatted_value || f.value} from ${f.source_document_name || `document ${f.source_document_id}`}`)
    .join('; ');

  return {
    draft_body: body,
    confidence: 0.95,
    staff_notes: `Deterministic research draft from verified research_packet facts. ${sources}`,
  };
}

async function completeJob(job, draftResult) {
  if (!draftResult.draft_body) throw new Error('Generated draft was empty');

  await pool.query(
    `UPDATE message_drafts
     SET status = 'discarded', updated_at = NOW()
     WHERE firm_id = $1 AND thread_id = $2 AND status = 'pending'`,
    [job.firm_id, job.thread_id]
  );

  const { rows: draftRows } = await pool.query(
    `INSERT INTO message_drafts (firm_id, thread_id, staff_user_id, agent_connection_id, draft_body, confidence, agent_notes, source_event)
     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7)
     RETURNING *`,
    [job.firm_id, job.thread_id, job.staff_user_id || null, draftResult.draft_body, draftResult.confidence, draftResult.staff_notes, job.source_event || 'emma.native_draft']
  );
  const draft = draftRows[0];

  await pool.query(
    `UPDATE emma_draft_jobs
     SET status = 'completed', draft_id = $2, completed_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [job.id, draft.id]
  );

  const pusher = appRef?.get?.('pusher');
  if (pusher) {
    pusher.trigger(`private-firm-${job.firm_id}`, 'agent-draft-new', {
      threadId: job.thread_id,
      draftId: draft.id,
      staffUserId: draft.staff_user_id,
      source: 'emma',
    }).catch(err => console.error('[emma-draft-jobs] pusher error:', err.message));
  }

  return draft;
}

async function failJob(job, err) {
  const terminal = job.attempts >= MAX_ATTEMPTS;
  await pool.query(
    `UPDATE emma_draft_jobs
     SET status = $2, last_error = $3, updated_at = NOW()
     WHERE id = $1`,
    [job.id, terminal ? 'failed' : 'pending', String(err.message || err).slice(0, 1000)]
  );
}

async function processNextEmmaDraftJob() {
  if (!backgroundJobsEnabled()) return null;
  if (workerRunning) return null;
  workerRunning = true;
  let job = null;
  try {
    job = await claimNextJob();
    if (!job) return null;
    if(!(await require('./firmPreferences').getFirmPreferences(job.firm_id)).aiEnabled)throw Error('AI is disabled for this firm');
    const context = await getThreadContext(job);
    const research = await buildResearchPacket(context);
    context.research_packet = research.packet;
    context.fact_resolution = research.factResolution;
    await pool.query(
      'UPDATE emma_draft_jobs SET research_packet = $2, updated_at = NOW() WHERE id = $1',
      [job.id, JSON.stringify(research.packet)]
    );
    if (context.fact_resolution.required_missing) {
      const missing = context.fact_resolution.missing.map(f => `${f.label}: ${f.reason}`).join('; ');
      throw new Error(`Required client-requested fact could not be resolved before drafting: ${missing}`);
    }
    const draftResult = await generateDraftFromContext(context);
    validateDraftAgainstResolvedFacts(context, draftResult);
    return await completeJob(job, draftResult);
  } catch (err) {
    console.error('[emma-draft-jobs] job error:', err.message);
    if (job) await failJob(job, err).catch(e => console.error('[emma-draft-jobs] failJob error:', e.message));
    return null;
  } finally {
    workerRunning = false;
  }
}

function startEmmaDraftWorker(app) {
  if (!backgroundJobsEnabled()) return;
  appRef = app || appRef;
  if (workerStarted) return;
  workerStarted = true;
  ensureSchema().catch(err => console.error('[emma-draft-jobs] schema init error:', err.message));
  workerTimer = setInterval(() => {
    processNextEmmaDraftJob().catch(err => console.error('[emma-draft-jobs] worker tick error:', err.message));
  }, WORKER_INTERVAL_MS);
  if (workerTimer.unref) workerTimer.unref();
  console.log('[emma-draft-jobs] worker started');
}

module.exports = {
  ensureSchema,
  enqueueEmmaDraftJob,
  processNextEmmaDraftJob,
  startEmmaDraftWorker,
};
