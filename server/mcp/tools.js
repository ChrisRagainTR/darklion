'use strict';

const crypto = require('crypto');
const { z } = require('zod');
const { callAgentWork, AgentWorkApiError } = require('./apiClient');

const positiveId = z.coerce.number().int().positive();
const limit = z.number().int().min(1).max(100).optional();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const objectOutput = z.looseObject({});

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const OPEN_READ_ONLY = { ...READ_ONLY, openWorldHint: true };
const IDEMPOTENT_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const OPEN_IDEMPOTENT_WRITE = { ...IDEMPOTENT_WRITE, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const REVERSIBLE_DESTRUCTIVE_WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };
const TOOL_ACCESS = new Map();

function asResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function errorResult(error) {
  const known = error instanceof AgentWorkApiError;
  const payload = {
    error: known ? error.message : 'DarkLion MCP tool failed',
    code: known ? error.code : 'mcp_tool_error',
    status: known ? error.status : 500,
    ...(known && error.details ? { details: error.details } : {}),
  };
  return { ...asResult(payload), isError: true };
}

function register(server, name, config, handler) {
  const { requiredScope = 'darklion:read', capability = null, ...mcpConfig } = config;
  TOOL_ACCESS.set(name, { name, requiredScope, capability, annotations: mcpConfig.annotations });
  server.registerTool(name, { ...mcpConfig, outputSchema: objectOutput }, async args => {
    try { return asResult(await handler(args)); } catch (error) { return errorResult(error); }
  });
}

function registerDarkLionTools(server, principal) {
  const api = (path, options) => callAgentWork(principal, path, options);

  register(server, 'darklion_status', {
    title: 'DarkLion Status', description: 'Return the authenticated firm, staff identity, capabilities, and Agent Work resources.', inputSchema: z.object({}), annotations: READ_ONLY,
  }, () => api('/status'));

  register(server, 'darklion_list_companies', {
    title: 'List DarkLion Companies', description: 'List companies in the authenticated firm for use with company-scoped tools.',
    inputSchema: z.object({}), annotations: READ_ONLY,
  }, () => api('/companies'));

  register(server, 'darklion_search_crm', {
    title: 'Search DarkLion CRM',
    description: 'Search the authenticated firm for matching relationships, people, spouses, email addresses, and companies.',
    inputSchema: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(25).optional() }),
    annotations: READ_ONLY,
  }, args => api('/crm/search', { query: { q: args.query, limit: args.limit } }));

  register(server, 'darklion_list_relationships', {
    title: 'List DarkLion Relationships', description: 'List firm relationships with bounded company and people counts.',
    inputSchema: z.object({}), annotations: READ_ONLY, capability: 'crm_read',
  }, () => api('/crm/relationships'));

  register(server, 'darklion_get_relationship', {
    title: 'Get DarkLion Relationship', description: 'Get one firm relationship with its people and active companies.',
    inputSchema: z.object({ relationship_id: positiveId }), annotations: READ_ONLY, capability: 'crm_read',
  }, args => api(`/crm/relationships/${args.relationship_id}`));

  register(server, 'darklion_get_relationship_snapshot', {
    title: 'Get Relationship Snapshot', description: 'Get recent tax delivery, message, activity, and engagement context for one relationship.',
    inputSchema: z.object({ relationship_id: positiveId }), annotations: READ_ONLY, capability: 'crm_read',
  }, args => api(`/crm/relationships/${args.relationship_id}/snapshot`));

  register(server, 'darklion_create_relationship', {
    title: 'Create DarkLion Relationship', description: 'Create a firm relationship with supported service and billing fields.',
    inputSchema: z.object({ name: z.string().trim().min(1).max(200), service_tier: z.string().trim().max(50).optional(), billing_status: z.string().trim().max(50).optional() }),
    annotations: WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api('/crm/relationships', { method: 'POST', body: args }));

  register(server, 'darklion_update_relationship', {
    title: 'Update DarkLion Relationship', description: 'Update supported fields on one relationship in the authenticated firm.',
    inputSchema: z.object({ relationship_id: positiveId, name: z.string().trim().min(1).max(200).optional(), service_tier: z.string().trim().max(50).optional(), billing_status: z.string().trim().max(50).optional() }),
    annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api(`/crm/relationships/${args.relationship_id}`, { method: 'PUT', body: { ...args, relationship_id: undefined } }));

  register(server, 'darklion_list_people', {
    title: 'List DarkLion People', description: 'List firm people, optionally limited to one relationship, without sensitive identity fields.',
    inputSchema: z.object({ relationship_id: positiveId.optional() }), annotations: READ_ONLY, capability: 'crm_read',
  }, args => api('/crm/people', { query: args }));

  register(server, 'darklion_get_person', {
    title: 'Get DarkLion Person', description: 'Get one firm person and their company access without DOB, SSN, notes, or credentials.',
    inputSchema: z.object({ person_id: positiveId }), annotations: READ_ONLY, capability: 'crm_read',
  }, args => api(`/crm/people/${args.person_id}`));

  const personFields = {
    first_name: z.string().trim().max(100).optional(), last_name: z.string().trim().max(100).optional(),
    email: z.string().trim().email().max(320).optional(), phone: z.string().trim().max(50).optional(),
    filing_status: z.string().trim().max(50).optional(), portal_enabled: z.boolean().optional(),
    spouse_name: z.string().trim().max(200).optional(), spouse_email: z.union([z.literal(''), z.string().trim().email().max(320)]).optional(),
    spouse_portal_enabled: z.boolean().optional(), billing_method: z.string().trim().max(50).optional(),
    personal_tax_engaged: z.boolean().optional(), address_line1: z.string().trim().max(200).optional(),
    address_line2: z.string().trim().max(200).optional(), city: z.string().trim().max(100).optional(),
    state: z.string().trim().max(50).optional(), zip: z.string().trim().max(20).optional(),
  };
  register(server, 'darklion_create_person', {
    title: 'Create DarkLion Person', description: 'Create a person under an existing firm relationship using supported contact fields.',
    inputSchema: z.object({ relationship_id: positiveId, ...personFields, email: z.string().trim().email().max(320) }),
    annotations: WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api('/crm/people', { method: 'POST', body: args }));

  register(server, 'darklion_update_person', {
    title: 'Update DarkLion Person', description: 'Update supported contact, filing, portal, billing, or address fields for one firm person.',
    inputSchema: z.object({ person_id: positiveId, ...personFields }), annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api(`/crm/people/${args.person_id}`, { method: 'PUT', body: { ...args, person_id: undefined } }));

  register(server, 'darklion_move_person_relationship', {
    title: 'Move Person Relationship', description: 'Move a person to another firm relationship and optionally synchronize company access.',
    inputSchema: z.object({ person_id: positiveId, relationship_id: positiveId, sync_company_access: z.boolean().optional() }),
    annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api(`/crm/people/${args.person_id}/move-relationship`, { method: 'POST', body: { relationship_id: args.relationship_id, sync_company_access: args.sync_company_access } }));

  register(server, 'darklion_get_company', {
    title: 'Get DarkLion Company', description: 'Get one visible active firm company and its linked people without provider credentials.',
    inputSchema: z.object({ company_id: positiveId }), annotations: READ_ONLY, capability: 'crm_read',
  }, args => api(`/crm/companies/${args.company_id}`));

  const companyFields = {
    company_name: z.string().trim().max(200).optional(), entity_type: z.string().trim().max(50).optional(),
    tax_year_end: z.string().trim().max(20).optional(), status: z.string().trim().max(50).optional(),
    bookkeeping_service: z.string().trim().max(50).optional(), billing_method: z.string().trim().max(50).optional(),
    address_line1: z.string().trim().max(200).optional(), address_line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(), state: z.string().trim().max(50).optional(), zip: z.string().trim().max(20).optional(),
    bookkeeper_id: positiveId.nullable().optional(),
  };
  register(server, 'darklion_create_company', {
    title: 'Create DarkLion Company', description: 'Create an unconnected company under an existing relationship in the authenticated firm.',
    inputSchema: z.object({ relationship_id: positiveId, ...companyFields, company_name: z.string().trim().min(1).max(200) }),
    annotations: WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api('/crm/companies', { method: 'POST', body: args }));

  register(server, 'darklion_update_company', {
    title: 'Update DarkLion Company', description: 'Update supported bookkeeping, assignment, entity, billing, or address fields for one company.',
    inputSchema: z.object({ company_id: positiveId, ...companyFields }), annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api(`/crm/companies/${args.company_id}`, { method: 'PUT', body: { ...args, company_id: undefined } }));

  register(server, 'darklion_move_company_relationship', {
    title: 'Move Company Relationship', description: 'Move a company to another firm relationship and optionally synchronize person access.',
    inputSchema: z.object({ company_id: positiveId, relationship_id: positiveId, sync_company_access: z.boolean().optional() }),
    annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'crm_write',
  }, args => api(`/crm/companies/${args.company_id}/move-relationship`, { method: 'POST', body: { relationship_id: args.relationship_id, sync_company_access: args.sync_company_access } }));

  register(server, 'darklion_list_documents', {
    title: 'List DarkLion Documents', description: 'List visible firm documents using owner, relationship, year, type, folder, and delivery filters.',
    inputSchema: z.object({ owner_type: z.enum(['person', 'company']).optional(), owner_id: positiveId.optional(), relationship_id: positiveId.optional(), year: z.string().regex(/^\d{4}$/).optional(), doc_type: z.string().trim().max(100).optional(), folder_section: z.enum(['firm_uploaded', 'client_uploaded']).optional(), folder_category: z.enum(['tax', 'bookkeeping', 'ias', 'other']).optional(), is_delivered: z.boolean().optional(), deleted: z.enum(['active', 'trash', 'all']).optional(), limit, offset: z.number().int().min(0).max(100000).optional() }),
    annotations: READ_ONLY, capability: 'documents_read',
  }, args => api('/documents', { query: args }));

  register(server, 'darklion_list_document_folders', {
    title: 'List Document Folders', description: 'List available firm and client folders for one visible person or company.',
    inputSchema: z.object({ owner_type: z.enum(['person', 'company']), owner_id: positiveId }), annotations: READ_ONLY, capability: 'documents_read',
  }, args => api('/documents/folders', { query: args }));

  register(server, 'darklion_create_document_folder', {
    title: 'Create Document Folder', description: 'Create a client-specific document folder for one visible person or company.',
    inputSchema: z.object({ owner_type: z.enum(['person', 'company']), owner_id: positiveId, folder_section: z.enum(['firm_uploaded', 'client_uploaded']), folder_category: z.enum(['tax', 'bookkeeping', 'ias', 'other']), name: z.string().trim().min(1).max(100) }),
    annotations: WRITE, requiredScope: 'darklion:write', capability: 'documents_write',
  }, args => api('/documents/folders', { method: 'POST', body: args }));

  register(server, 'darklion_get_document', {
    title: 'Get DarkLion Document', description: 'Get safe metadata for one visible document without exposing storage coordinates.',
    inputSchema: z.object({ document_id: positiveId, include_deleted: z.boolean().optional() }), annotations: READ_ONLY, capability: 'documents_read',
  }, args => api(`/documents/${args.document_id}`, { query: { include_deleted: args.include_deleted } }));

  register(server, 'darklion_get_document_extracted_data', {
    title: 'Get Document Extracted Data', description: 'Get allowlisted cached tax facts, or explicitly request bounded live PDF extraction.',
    inputSchema: z.object({ document_id: positiveId, live: z.boolean().optional() }), annotations: OPEN_READ_ONLY, capability: 'documents_read',
  }, args => api(`/documents/${args.document_id}/extracted-data`, { query: { live: args.live } }));

  register(server, 'darklion_get_document_download_url', {
    title: 'Get Document Download URL', description: 'Create a short-lived signed download URL for one visible document.',
    inputSchema: z.object({ document_id: positiveId }), annotations: OPEN_READ_ONLY, capability: 'documents_read',
  }, args => api(`/documents/${args.document_id}/download-url`));

  register(server, 'darklion_update_document', {
    title: 'Update DarkLion Document', description: 'Update supported name, year, type, or folder fields for one editable document.',
    inputSchema: z.object({ document_id: positiveId, display_name: z.string().trim().min(1).max(255).optional(), year: z.union([z.literal(''), z.string().regex(/^\d{4}$/)]).optional(), doc_type: z.string().trim().min(1).max(100).optional(), folder_id: positiveId.nullable().optional(), folder_section: z.enum(['firm_uploaded', 'client_uploaded']).optional(), folder_category: z.enum(['tax', 'bookkeeping', 'ias', 'other']).optional() }),
    annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'documents_write',
  }, args => api(`/documents/${args.document_id}`, { method: 'PUT', body: { ...args, document_id: undefined } }));

  register(server, 'darklion_trash_document', {
    title: 'Trash DarkLion Document', description: 'Move an eligible document to recoverable Trash; permanent deletion is not available.',
    inputSchema: z.object({ document_id: positiveId, reason: z.string().trim().max(500).optional() }),
    annotations: REVERSIBLE_DESTRUCTIVE_WRITE, requiredScope: 'darklion:write', capability: 'documents_write',
  }, args => api(`/documents/${args.document_id}`, { method: 'DELETE', body: { reason: args.reason } }));

  register(server, 'darklion_restore_document', {
    title: 'Restore DarkLion Document', description: 'Restore one previously trashed document in the authenticated firm.',
    inputSchema: z.object({ document_id: positiveId }), annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'documents_write',
  }, args => api(`/documents/${args.document_id}/restore`, { method: 'POST' }));

  register(server, 'darklion_list_pipeline_jobs', {
    title: 'List Pipeline Jobs', description: 'List bounded firm pipeline work with optional assignment and instance filters.',
    inputSchema: z.object({ assigned_to: positiveId.optional(), instance_id: positiveId.optional(), include_completed: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }),
    annotations: READ_ONLY, capability: 'pipelines_read',
  }, args => api('/pipelines/jobs', { query: args }));

  register(server, 'darklion_update_pipeline_job', {
    title: 'Update Pipeline Job', description: 'Update bounded assignment, due date, priority, status, or notes fields on one pipeline job.',
    inputSchema: z.object({ job_id: positiveId, notes: z.string().trim().max(5000).optional(), assigned_to: positiveId.nullable().optional(), due_date: z.union([z.literal(''), isoDate, z.null()]).optional(), priority: z.enum(['normal', 'high', 'urgent']).optional(), job_status: z.enum(['active', 'blocked', 'complete', 'completed', 'archived']).optional() }),
    annotations: IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'pipelines_write',
  }, args => api(`/pipelines/jobs/${args.job_id}`, { method: 'PUT', body: { ...args, job_id: undefined } }));

  register(server, 'darklion_move_pipeline_job', {
    title: 'Move Pipeline Job', description: 'Move one firm pipeline job to a validated stage and record the transition history.',
    inputSchema: z.object({ job_id: positiveId, stage_id: positiveId, note: z.string().trim().max(2000).optional() }),
    annotations: WRITE, requiredScope: 'darklion:write', capability: 'pipelines_write',
  }, args => api(`/pipelines/jobs/${args.job_id}/move`, { method: 'POST', body: { stage_id: args.stage_id, note: args.note } }));

  register(server, 'darklion_list_pipeline_stages', {
    title: 'List Pipeline Stages', description: 'List ordered stages for one pipeline template belonging to the authenticated firm.',
    inputSchema: z.object({ template_id: positiveId }), annotations: READ_ONLY, capability: 'pipelines_read',
  }, args => api(`/pipelines/templates/${args.template_id}/stages`));

  register(server, 'darklion_list_staff', {
    title: 'List DarkLion Staff', description: 'List active same-firm staff identifiers, display names, and roles for assignment workflows.',
    inputSchema: z.object({}), annotations: READ_ONLY, capability: 'staff_read',
  }, () => api('/staff'));

  register(server, 'darklion_get_my_work', {
    title: 'Get My DarkLion Work', description: 'Get the authenticated staff member assigned pipeline jobs and open task messages.',
    inputSchema: z.object({}), annotations: READ_ONLY, capability: 'work_read',
  }, () => api('/my-work'));

  register(server, 'darklion_list_conversation_summaries', {
    title: 'List Conversation Summaries', description: 'List visible daily conversation summaries for one calendar month without marking them viewed.',
    inputSchema: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }), annotations: READ_ONLY, capability: 'summaries_read',
  }, args => api('/communications/summaries', { query: args }));

  register(server, 'darklion_get_conversation_summary', {
    title: 'Get Conversation Summary', description: 'Get one staff-filtered daily conversation summary without changing viewed state.',
    inputSchema: z.object({ date: isoDate }), annotations: READ_ONLY, capability: 'summaries_read',
  }, args => api(`/communications/summaries/${args.date}`));

  register(server, 'darklion_send_client_message', {
    title: 'Send Client Message', description: 'Send an attachment-free secure client message as the authenticated staff member with idempotency.',
    inputSchema: z.object({ person_id: positiveId, subject: z.string().trim().max(255).optional(), body: z.string().trim().min(1).max(50_000), client_nonce: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }),
    annotations: { ...WRITE, openWorldHint: true }, requiredScope: 'darklion:communicate', capability: 'messages_send',
  }, args => api('/communications/client-messages', { method: 'POST', body: args }));

  register(server, 'darklion_reply_client_message', {
    title: 'Reply to Client Message', description: 'Reply to one visible client thread without attachments using an idempotency nonce.',
    inputSchema: z.object({ thread_id: positiveId, body: z.string().trim().min(1).max(50_000), client_nonce: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/) }),
    annotations: { ...WRITE, openWorldHint: true }, requiredScope: 'darklion:communicate', capability: 'messages_send',
  }, args => api(`/communications/client-messages/${args.thread_id}/reply`, { method: 'POST', body: { body: args.body, client_nonce: args.client_nonce } }));

  register(server, 'darklion_get_bookkeeping_overview', {
    title: 'Get Bookkeeping Overview', description: 'Get firm bookkeeping workload totals, recent runs, and mapping counts for visible companies.',
    inputSchema: z.object({}), annotations: READ_ONLY, capability: 'bookkeeping_read',
  }, () => api('/business/bookkeeping/overview'));

  register(server, 'darklion_list_bookkeeping_runs', {
    title: 'List Bookkeeping Runs', description: 'List recent bookkeeping automation runs for companies visible to the authenticated staff member.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }), annotations: READ_ONLY, capability: 'bookkeeping_read',
  }, args => api('/business/bookkeeping/runs', { query: args }));

  register(server, 'darklion_list_bookkeeping_mappings', {
    title: 'List Bookkeeping Mappings', description: 'List bounded vendor-to-account bookkeeping mappings without provider account identifiers.',
    inputSchema: z.object({ realm_id: z.string().trim().min(1).max(100).optional(), search: z.string().trim().min(1).max(100).optional(), limit }), annotations: READ_ONLY, capability: 'bookkeeping_read',
  }, args => api('/business/bookkeeping/mappings', { query: args }));

  register(server, 'darklion_list_tax_deliveries', {
    title: 'List Tax Deliveries', description: 'List safe tax-return delivery records visible to the authenticated firm staff member.',
    inputSchema: z.object({ company_id: positiveId.optional(), person_id: positiveId.optional(), limit }), annotations: READ_ONLY, capability: 'tax_deliveries_read',
  }, args => api('/business/tax-deliveries', { query: args }));

  register(server, 'darklion_get_tax_delivery', {
    title: 'Get Tax Delivery', description: 'Get one tax delivery with allowlisted signer state and no signature, IP, token, or storage data.',
    inputSchema: z.object({ delivery_id: positiveId }), annotations: READ_ONLY, capability: 'tax_deliveries_read',
  }, args => api(`/business/tax-deliveries/${args.delivery_id}`));

  register(server, 'darklion_get_tax_delivery_summary', {
    title: 'Get Tax Delivery Summary', description: 'Get normalized tax facts from one visible tax delivery without raw provider output.',
    inputSchema: z.object({ delivery_id: positiveId }), annotations: READ_ONLY, capability: 'tax_deliveries_read',
  }, args => api(`/business/tax-deliveries/${args.delivery_id}/summary`));

  register(server, 'darklion_list_tax_organizers', {
    title: 'List Tax Organizers', description: 'List bounded tax organizer records for one visible person.',
    inputSchema: z.object({ person_id: positiveId, limit: z.number().int().min(1).max(50).optional() }), annotations: READ_ONLY, capability: 'organizers_read',
  }, args => api(`/business/organizers/${args.person_id}`, { query: { limit: args.limit } }));

  register(server, 'darklion_get_tax_organizer', {
    title: 'Get Tax Organizer', description: 'Get one tax organizer with progress metadata and redacted answer and document details.',
    inputSchema: z.object({ person_id: positiveId, year: z.string().regex(/^(19|20|21)\d{2}$/) }), annotations: READ_ONLY, capability: 'organizers_read',
  }, args => api(`/business/organizers/${args.person_id}/${args.year}`));

  register(server, 'darklion_list_proposals', {
    title: 'List Proposals', description: 'List bounded firm proposals using safe projected client, tier, add-on, and pricing fields.',
    inputSchema: z.object({ status: z.enum(['draft', 'sent', 'viewed', 'accepted', 'signed']).optional(), limit }), annotations: READ_ONLY, capability: 'proposals_read',
  }, args => api('/business/proposals', { query: args }));

  register(server, 'darklion_get_proposal', {
    title: 'Get Proposal', description: 'Get one visible proposal and engagement state without invite tokens, signatures, IPs, or private acceptance contacts.',
    inputSchema: z.object({ proposal_id: positiveId }), annotations: READ_ONLY, capability: 'proposals_read',
  }, args => api(`/business/proposals/${args.proposal_id}`));

  register(server, 'darklion_get_proposal_stats', {
    title: 'Get Proposal Stats', description: 'Get firm proposal pipeline and signed engagement summary statistics.',
    inputSchema: z.object({}), annotations: READ_ONLY, capability: 'proposals_read',
  }, () => api('/business/proposals/stats'));

  register(server, 'darklion_get_billing_config', {
    title: 'Get Billing Configuration', description: 'Get a visible relationship billing configuration using a fixed local-data projection.',
    inputSchema: z.object({ relationship_id: positiveId }), annotations: READ_ONLY, capability: 'billing_read',
  }, args => api(`/business/billing/relationships/${args.relationship_id}/config`));

  register(server, 'darklion_get_person_investments', {
    title: 'Get Person Investments', description: 'Get a visible person investment snapshot with account numbers, holdings, provider IDs, and raw performance removed.',
    inputSchema: z.object({ person_id: positiveId }), annotations: READ_ONLY, capability: 'investments_read',
  }, args => api(`/business/people/${args.person_id}/investments`));

  register(server, 'darklion_list_engagement_letters', {
    title: 'List Engagement Letters', description: 'List active engagement-letter summaries without extracted source text, storage data, or AI prompts.',
    inputSchema: z.object({ limit }), annotations: READ_ONLY, capability: 'engagements_read',
  }, args => api('/business/engagement-letters', { query: args }));

  register(server, 'darklion_get_activity_log', {
    title: 'Get Activity Log', description: 'Get the firm activity log and optional summaries for a date or timestamp range.',
    inputSchema: z.object({
      date: isoDate.optional(), since: isoDateTime.optional(), until: isoDateTime.optional(),
      event_types: z.array(z.string().trim().min(1)).max(50).optional(), limit: z.number().int().min(1).max(500).optional(), include_summaries: z.boolean().optional(),
    }).refine(v => !(v.date && (v.since || v.until)), { message: 'date cannot be combined with since or until' })
      .refine(v => !(v.since && v.until) || Date.parse(v.since) <= Date.parse(v.until), { message: 'since must not be later than until' }),
    annotations: READ_ONLY,
  }, args => api('/activity-log', { query: { ...args, event_type: args.event_types, event_types: undefined } }));

  register(server, 'darklion_get_revenue_forecast', {
    title: 'Get Revenue Forecast', description: 'Build the authenticated firm revenue forecast for a calendar year.',
    inputSchema: z.object({ year: z.number().int().min(2000).max(new Date().getFullYear() + 10).optional() }), annotations: OPEN_READ_ONLY,
  }, args => api('/revenue-forecast', { query: args }));

  const companySelector = {
    company_id: positiveId.optional(), realm_id: z.string().trim().min(1).max(100).optional(),
  };
  register(server, 'darklion_search_transactions', {
    title: 'Search Transactions', description: 'Search imported QuickBooks transactions using exact, near, minimum, or maximum amount filters and other criteria.',
    inputSchema: z.object({
      ...companySelector,
      vendor: z.string().trim().max(200).optional(), query: z.string().trim().max(500).optional(),
      amount_exact: z.number().finite().optional(), amount_near: z.number().finite().optional(), tolerance: z.number().finite().nonnegative().optional(),
      amount_min: z.number().finite().optional(), amount_max: z.number().finite().optional(),
      date_from: isoDate.optional(), date_to: isoDate.optional(), status: z.string().trim().max(50).optional(), type: z.string().trim().max(100).optional(),
      source: z.enum(['transactions', 'bookkeeper_uncoded']).optional(), include_uncoded: z.boolean().optional(), limit, offset: z.number().int().min(0).optional(),
    }).refine(v => Boolean(v.company_id) !== Boolean(v.realm_id), { message: 'Provide exactly one of company_id or realm_id' })
      .refine(v => v.amount_min === undefined || v.amount_max === undefined || v.amount_min <= v.amount_max, { message: 'amount_min must not exceed amount_max' })
      .refine(v => !v.date_from || !v.date_to || v.date_from <= v.date_to, { message: 'date_from must not be later than date_to' }),
    annotations: READ_ONLY,
  }, args => api('/transactions/search', { method: 'POST', body: {
    ...args,
    q: args.query,
    query: undefined,
    amount: { exact: args.amount_exact, near: args.amount_near, tolerance: args.tolerance, min: args.amount_min, max: args.amount_max },
    amount_exact: undefined, amount_near: undefined, tolerance: undefined, amount_min: undefined, amount_max: undefined,
  } }));

  register(server, 'darklion_backfill_transactions', {
    title: 'Backfill Transactions', description: 'Import or refresh a bounded QuickBooks transaction history window for one firm company.',
    inputSchema: z.object({ ...companySelector, months: z.number().int().min(1).max(84).default(24), types: z.array(z.string().trim().min(1)).max(25).optional() })
      .refine(v => Boolean(v.company_id) !== Boolean(v.realm_id), { message: 'Provide exactly one of company_id or realm_id' }),
    annotations: OPEN_IDEMPOTENT_WRITE, requiredScope: 'darklion:write', capability: 'transactions_write',
  }, args => api('/transactions/backfill', { method: 'POST', body: args }));

  register(server, 'darklion_get_inbox_summary', {
    title: 'Get Inbox Summary', description: 'Get open-thread, unread-message, and pending-draft counts visible to the authenticated staff member.', inputSchema: z.object({}), annotations: READ_ONLY,
  }, () => api('/inbox/summary'));

  register(server, 'darklion_list_inbox_threads', {
    title: 'List Inbox Threads', description: 'List the authenticated staff inbox. Archived threads are excluded by default; use view archived to inspect their archive. Global status open does not mean a thread is in this staff member’s inbox.',
    inputSchema: z.object({ unread: z.boolean().optional(), limit, view: z.enum(['inbox', 'archived']).optional() }), annotations: READ_ONLY,
  }, args => api('/inbox/threads', { query: args }));

  register(server, 'darklion_get_inbox_thread', {
    title: 'Get Inbox Thread', description: 'Get one accessible thread with messages, drafts, and staff-specific isArchived/archivedAt. Use those fields, not global status, to determine whether it is archived for this staff member.',
    inputSchema: z.object({ thread_id: positiveId }), annotations: READ_ONLY,
  }, args => api(`/inbox/threads/${args.thread_id}`));

  register(server, 'darklion_create_inbox_draft', {
    title: 'Create Inbox Draft', description: 'Create a pending reply draft for staff review; this does not send a client message.',
    inputSchema: z.object({ thread_id: positiveId, draft_body: z.string().trim().min(1).max(50_000), confidence: z.number().min(0).max(1).optional(), notes: z.string().trim().max(5_000).optional() }),
    annotations: WRITE, requiredScope: 'darklion:write', capability: 'inbox_drafts',
  }, args => api(`/inbox/threads/${args.thread_id}/draft`, { method: 'POST', body: { ...args, thread_id: undefined } }));

  register(server, 'darklion_get_team_chat_summary', {
    title: 'Get Team Chat Summary', description: 'Get unread Team Chat counts and conversations visible to the authenticated staff member.', inputSchema: z.object({}), annotations: READ_ONLY,
  }, () => api('/team-chat/summary'));

  register(server, 'darklion_list_team_conversations', {
    title: 'List Team Conversations', description: 'List Team Chat conversations visible to the authenticated staff member.',
    inputSchema: z.object({ unread: z.boolean().optional(), limit }), annotations: READ_ONLY,
  }, args => api('/team-chat/conversations', { query: args }));

  register(server, 'darklion_get_team_conversation_messages', {
    title: 'Get Team Conversation Messages', description: 'Get messages in one Team Chat conversation visible to the authenticated staff member.',
    inputSchema: z.object({ conversation_id: positiveId, limit }), annotations: READ_ONLY,
  }, args => api(`/team-chat/conversations/${args.conversation_id}/messages`, { query: { limit: args.limit } }));

  register(server, 'darklion_reply_team_conversation', {
    title: 'Reply to Team Conversation', description: 'Send an internal Team Chat reply as the authenticated staff member. Reusing client_nonce is idempotent.',
    inputSchema: z.object({ conversation_id: positiveId, body: z.string().min(1).max(50_000), client_nonce: z.string().trim().min(8).max(200).optional() }), annotations: WRITE,
    requiredScope: 'darklion:write', capability: 'team_chat_send',
  }, args => api(`/team-chat/conversations/${args.conversation_id}/reply`, {
    method: 'POST', body: { body: args.body, client_nonce: args.client_nonce || `mcp-${crypto.randomUUID()}` },
  }));
}

registerDarkLionTools({ registerTool() {} }, {});

function requiredScopeForTool(name) {
  return TOOL_ACCESS.get(name)?.requiredScope || 'darklion:read';
}

function getToolAccessCatalog() {
  return [...TOOL_ACCESS.values()];
}

module.exports = { registerDarkLionTools, requiredScopeForTool, getToolAccessCatalog };
