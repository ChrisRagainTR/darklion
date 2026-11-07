'use strict';
const { completeText } = require('./managedInference');

// emmaDraft.js
// Generates a draft reply for a client message using Claude Haiku.
// Called non-blocking after a client message is received.
// Posts the draft as an internal note tagged with is_emma_draft=true.

const { pool } = require('../db');
const { archiveClientMessageCreatedFailClosed } = require('./communicationArchive');

async function generateDraft(threadId, firmId, personId, clientMessage) {
  try {
    const preferences=await require('./firmPreferences').getFirmPreferences(firmId);
    if(!preferences.aiEnabled)return {status:'disabled'};
    const thread=(await pool.query('SELECT id FROM message_threads WHERE id=$1 AND firm_id=$2 AND person_id=$3',[threadId,firmId,personId])).rows[0];
    if(!thread)return {status:'no_thread'};

    // ── 1. Load person context ────────────────────────────────────────────────
    const { rows: personRows } = await pool.query(
      `SELECT p.first_name, p.last_name, p.email, p.phone,
              p.filing_status, p.spouse_name, p.spouse_email,
              p.address_line1, p.city, p.state, p.zip, p.notes,
              r.name AS relationship_name
       FROM people p
       LEFT JOIN relationships r ON r.id = p.relationship_id
       WHERE p.id = $1 AND p.firm_id = $2`,
      [personId, firmId]
    );
    const person = personRows[0];
    if (!person) return { status: 'no_person' };

    const personName = `${person.first_name} ${person.last_name}`.trim();

    // ── 2. Load recent message history (last 30 days, last 20 messages) ───────
    const { rows: recentMsgs } = await pool.query(
      `SELECT m.body, m.sender_type, m.created_at,
              CASE WHEN m.sender_type = 'staff' THEN COALESCE(NULLIF(fu.display_name, ''), fu.name, 'Staff')
                   WHEN m.sender_type = 'agent' THEN 'Emma'
                   ELSE $1 END AS sender_name
       FROM messages m
       JOIN message_threads mt ON mt.id = m.thread_id
       LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
       WHERE mt.person_id = $2 AND mt.firm_id = $3
         AND m.is_internal = false
         AND m.created_at > NOW() - INTERVAL '30 days'
         AND m.id != (SELECT MAX(id) FROM messages WHERE thread_id = $4 AND sender_type = 'client')
       ORDER BY m.created_at DESC
       LIMIT 20`,
      [personName, personId, firmId, threadId]
    );
    const messageHistory = recentMsgs.reverse().map(m =>
      `[${new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${m.sender_name}]: ${m.body.slice(0, 400)}`
    ).join('\n');

    // ── 3. Load active pipeline jobs ──────────────────────────────────────────
    const { rows: pipelineJobs } = await pool.query(
      `SELECT pj.job_status, pj.notes,
              pi.name AS instance_name, pi.tax_year,
              ps.name AS current_stage,
              (SELECT string_agg(pju.body, ' | ' ORDER BY pju.created_at DESC)
               FROM pipeline_job_updates pju WHERE pju.job_id = pj.id AND pju.created_at > NOW() - INTERVAL '90 days'
               LIMIT 5) AS recent_notes
       FROM pipeline_jobs pj
       JOIN pipeline_instances pi ON pi.id = pj.instance_id
       JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
       WHERE pj.entity_type = 'person' AND pj.entity_id = $1
         AND pi.firm_id = $2 AND pj.job_status = 'active'
       ORDER BY pi.tax_year DESC`,
      [personId, firmId]
    );

    // Also check company pipelines
    const { rows: companyJobs } = await pool.query(
      `SELECT pj.job_status, pj.notes,
              pi.name AS instance_name, pi.tax_year,
              ps.name AS current_stage, c.company_name,
              (SELECT string_agg(pju.body, ' | ' ORDER BY pju.created_at DESC)
               FROM pipeline_job_updates pju WHERE pju.job_id = pj.id AND pju.created_at > NOW() - INTERVAL '90 days'
               LIMIT 5) AS recent_notes
       FROM pipeline_jobs pj
       JOIN pipeline_instances pi ON pi.id = pj.instance_id
       JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
       JOIN companies c ON c.id = pj.entity_id
       JOIN person_company_access pca ON pca.company_id = c.id AND pca.person_id = $1
       WHERE pj.entity_type = 'company' AND pi.firm_id = $2 AND pj.job_status = 'active'
       ORDER BY pi.tax_year DESC`,
      [personId, firmId]
    );

    const allJobs = [...pipelineJobs, ...companyJobs];
    const pipelineContext = allJobs.length > 0
      ? allJobs.map(j =>
          `- ${j.instance_name}${j.tax_year ? ` (${j.tax_year})` : ''}${j.company_name ? ` — ${j.company_name}` : ''}: Stage "${j.current_stage}"` +
          (j.recent_notes ? `\n  Staff notes: ${j.recent_notes.slice(0, 300)}` : '')
        ).join('\n')
      : 'No active pipeline jobs found.';

    // ── 4. Load relevant documents + extract text from key PDFs ────────────────
    const { rows: docs } = await pool.query(
      `SELECT d.id, d.display_name, d.folder_category, d.year, d.s3_key, d.s3_bucket, d.mime_type, d.created_at
       FROM documents d
       WHERE d.firm_id = $1
         AND ((d.owner_type = 'person' AND d.owner_id = $2)
              OR (d.owner_type = 'company' AND d.owner_id IN (
                SELECT pca.company_id FROM person_company_access pca WHERE pca.person_id = $2
              )))
         AND d.folder_category IN ('tax', 'bookkeeping', 'other')
       ORDER BY d.year DESC, d.created_at DESC
       LIMIT 50`,
      [firmId, personId]
    );
    const documentContext = docs.length > 0
      ? docs.map(d => `- ${d.display_name} (${d.folder_category}${d.year ? `, ${d.year}` : ''})`).join('\n')
      : 'No documents on file.';

    // Extract text from up to 3 most recent tax return PDFs
    let extractedDocText = '';
    try {
      const { extractPdfText } = require('./pdfExtract');
      const { downloadFile } = require('./s3');
      const taxReturns = docs.filter(d =>
        d.mime_type === 'application/pdf' &&
        d.folder_category === 'tax' &&
        d.display_name.toLowerCase().includes('tax return')
      ).slice(0, 5);

      for (const doc of taxReturns) {
        try {
          const buffer = await downloadFile({ key: doc.s3_key, bucket: doc.s3_bucket });
          const text = await extractPdfText(buffer);
          if (text && text.trim()) {
            extractedDocText += `\n\n=== ${doc.display_name} (${doc.year}) ===\n${text.slice(0, 15000)}`;
          }
        } catch(e) {
          console.log(`[emma-draft] Could not extract ${doc.display_name}: ${e.message}`);
        }
      }
    } catch(e) {
      console.log('[emma-draft] PDF extraction skipped:', e.message);
    }

    // ── 5. Load engagement letters ────────────────────────────────────────────
    const { rows: engagements } = await pool.query(
      `SELECT el.display_name, el.extracted_data, el.created_at
       FROM engagement_letters el
       WHERE el.firm_id = $1
         AND el.relationship_id = (SELECT relationship_id FROM people WHERE id = $2)
         AND el.status = 'active'
       ORDER BY el.created_at DESC
       LIMIT 3`,
      [firmId, personId]
    );
    const engagementContext = engagements.length > 0
      ? engagements.map(el => {
          const data = el.extracted_data || {};
          return `- ${el.display_name}: ${data.engagement_type || ''} engagement, $${data.monthly_price || '?'}/mo, signed by ${data.signed_by_name || '?'}`;
        }).join('\n')
      : 'No engagement letters on file.';

    // ── 6. Load QBO summary if connected ─────────────────────────────────────
    let qboContext = 'No QuickBooks connection.';
    const { rows: companies } = await pool.query(
      `SELECT c.company_name, c.realm_id, c.annual_revenue
       FROM companies c
       JOIN person_company_access pca ON pca.company_id = c.id
       WHERE pca.person_id = $1 AND c.firm_id = $2
         AND c.realm_id IS NOT NULL AND c.realm_id != '' AND c.realm_id NOT LIKE 'import-%'`,
      [personId, firmId]
    );
    if (companies.length > 0) {
      qboContext = companies.map(c =>
        `- ${c.company_name}: QBO connected${c.annual_revenue ? `, last 12mo revenue $${parseFloat(c.annual_revenue).toLocaleString()}` : ''}`
      ).join('\n');
    }

    // ── 7. Load firm info ─────────────────────────────────────────────────────
    const { rows: firmRows } = await pool.query(
      'SELECT display_name FROM firms WHERE id = $1', [firmId]
    );
    const firmName = firmRows[0]?.display_name || preferences.name;

    // ── 8. Build the prompt ───────────────────────────────────────────────────
    const prompt = `You are Emma, an AI assistant for ${firmName}, a CPA and wealth management firm. A client has sent a message and you need to draft a professional, helpful reply for a staff member to review and send.

Be warm but professional. Write in first person as if you are the advisor responding. Be specific — reference actual details from the client's file. If the answer requires citing a tax law, IRS rule, bookkeeping principle, or financial planning concept, include that context to make the response more helpful and credible.

If you don't have enough information to give a complete answer, draft a response that acknowledges the question and explains what the advisor will look into — never guess or fabricate numbers.

═══ CLIENT PROFILE ═══
Name: ${personName}
Filing Status: ${person.filing_status || 'Unknown'}${person.spouse_name ? ` — Married to ${person.spouse_name}` : ''}
Location: ${[person.city, person.state].filter(Boolean).join(', ') || 'Unknown'}
Relationship: ${person.relationship_name || 'Unknown'}
${person.notes ? `Advisor notes: ${person.notes}` : ''}

═══ ACTIVE PIPELINE / WORK STATUS ═══
${pipelineContext}

═══ DOCUMENTS ON FILE ═══
${documentContext}

═══ ENGAGEMENT / SERVICES ═══
${engagementContext}

═══ QUICKBOOKS / FINANCIALS ═══
${qboContext}

${extractedDocText ? `═══ TAX RETURN CONTENT (extracted) ═══${extractedDocText}

` : ''}═══ RECENT MESSAGE HISTORY ═══
${messageHistory || 'No prior messages.'}

═══ CLIENT'S CURRENT MESSAGE ═══
${clientMessage}

═══ INSTRUCTIONS ═══
Draft a reply that:
1. Directly addresses the client's question or concern
2. References specific details from their file where relevant (pipeline stage, documents, return status, etc.)
3. If the question involves tax law, bookkeeping, or financial planning — briefly cite the relevant rule, IRS code section, or principle to add credibility. You have access to actual tax return content above — use specific numbers, figures, and details from the return when relevant
4. Is ready to send with minimal or no editing
5. Is signed as the advisor (not as Emma — you are drafting for the advisor to send)
6. Is concise — 2-5 sentences for simple questions, up to 3 short paragraphs for complex ones

Draft reply only — no preamble, no "here is a draft", just the message text.`;

    // ── 9. Call Claude Haiku ──────────────────────────────────────────────────
    const draftText=(await completeText({firmId,feature:'reply-draft',maxTokens:600,prompt})).trim();
    if (!draftText) return { status: 'empty_draft' };

    // ── 10. Save as internal note with is_emma_draft flag ─────────────────────
    // Ensure column exists
    await pool.query(`
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_emma_draft BOOLEAN DEFAULT FALSE
    `).catch(() => {});

    // Use sender_id=1 (firm owner/system) for Emma draft messages
    // These are internal notes — sender_id is required by DB constraint
    const { rows: messageRows } = await pool.query(
      `INSERT INTO messages (thread_id, sender_type, sender_id, body, is_internal, is_emma_draft, created_at)
       VALUES ($1, 'agent', 1, $2, true, true, NOW())
       RETURNING id`,
      [threadId, draftText]
    );
    await archiveClientMessageCreatedFailClosed({ firmId, messageId: messageRows[0].id });

    await pool.query(
      'UPDATE message_threads SET last_message_at = NOW() WHERE id = $1',
      [threadId]
    );

    // Notify via Pusher
    // (pusher instance not available here — staff will see it on next poll/refresh)
    console.log(`[emma-draft] Generated draft for thread ${threadId}, person ${personId}`);
    return { status: 'ok', draftText: draftText.slice(0, 200) };

  } catch(e) {
    console.error('[emma-draft] Error generating draft:', e.message, e.stack?.split('\n').slice(0,3));
    return { status: 'error', error: e.message };
  }
}

module.exports = { generateDraft };
