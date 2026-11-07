const cron = require('node-cron');
const { pool } = require('./db');
const { formatPersonDisplayName } = require('./utils/displayName');
const { syncTransactions, getChartOfAccounts, writeBackTransaction } = require('./services/quickbooks');
const { categorizeTransactions, researchAllVendors } = require('./services/claude');
const { sendErrorAlert } = require('./services/alerts');

const CONFIDENCE_THRESHOLD = 0.80; // Auto-post above this

async function sendReviewEmail(realmId, lowConfTxns) {
  const company = (await pool.query('SELECT firm_id, company_name FROM companies WHERE realm_id=$1', [realmId])).rows[0];
  if (!company?.firm_id || !lowConfTxns.length) return;
  const { getFirmPreferences } = require('./services/firmPreferences');
  const preferences = await getFirmPreferences(company.firm_id);
  const legacyOwner = await require('./services/firmIntegrations').legacyIntegrationOwner(company.firm_id);
  const recipients = legacyOwner && process.env.NOTIFY_EMAIL
    ? process.env.NOTIFY_EMAIL.split(',').map(email => email.trim()).filter(Boolean)
    : (await pool.query("SELECT email FROM firm_users WHERE firm_id=$1 AND role IN ('owner','admin') AND accepted_at IS NOT NULL AND archived_at IS NULL", [company.firm_id])).rows.map(row => row.email);
  if (!recipients.length) return;
  const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dashboardUrl = new URL('/dashboard', process.env.PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:8080').href;
  await require('./services/email').sendEmail({
    to: recipients,
    fromName: preferences.name,
    subject: `DarkLion: ${lowConfTxns.length} transaction(s) need review`,
    html: `<p>${escape(company.company_name || 'Your company')} has ${lowConfTxns.length} transaction(s) ready for review.</p><p><a href="${escape(dashboardUrl)}">Review in DarkLion</a></p>`,
  });
}

async function autoPostHighConfidence(realmId) {
  const { rows: highConf } = await pool.query(
    "SELECT * FROM transactions WHERE realm_id = $1 AND status = 'categorized' AND ai_confidence >= $2",
    [realmId, CONFIDENCE_THRESHOLD]
  );

  if (highConf.length === 0) return { posted: 0 };

  const { rows: rules } = await pool.query(
    'SELECT vendor_name, category FROM category_rules WHERE realm_id = $1', [realmId]
  );
  const ruleMap = Object.fromEntries(rules.map(r => [r.vendor_name, r.category]));

  let posted = 0;
  for (const txn of highConf) {
    const ruleCategory = ruleMap[txn.vendor_name];
    if (ruleCategory && ruleCategory !== txn.ai_category) {
      await pool.query(
        "UPDATE transactions SET ai_category = $1, status = 'reviewed', updated_at = NOW() WHERE id = $2",
        [ruleCategory, txn.id]
      );
    } else {
      await pool.query(
        "UPDATE transactions SET status = 'reviewed', updated_at = NOW() WHERE id = $1",
        [txn.id]
      );
    }

    try {
      const category = ruleCategory || txn.ai_category;
      await writeBackTransaction(realmId, txn.qb_id, category);
      posted++;
    } catch (e) {
      console.error(`    Failed to write back ${txn.qb_id}:`, e.message);
    }
  }

  return { posted };
}

// Full pipeline: sync → research → categorize → auto-post → email
async function runFullPipeline(realmId) {
  const results = { synced: 0, researched: 0, categorized: 0, posted: 0, needsReview: 0 };

  // Step 1: Sync transactions from QuickBooks
  const syncResult = await syncTransactions(realmId);
  results.synced = syncResult.synced;
  console.log(`    Synced ${results.synced} transactions`);

  // Step 2: Research unknown vendors
  const vendorResult = await researchAllVendors(realmId);
  results.researched = vendorResult.researched;
  console.log(`    Researched ${results.researched} vendors`);

  // Step 3: Categorize pending transactions
  const coa = await getChartOfAccounts(realmId);
  const catResult = await categorizeTransactions(realmId, coa);
  results.categorized = catResult.categorized;
  console.log(`    Categorized ${results.categorized} transactions`);

  // Step 4: Auto-post high-confidence transactions to QuickBooks
  const postResult = await autoPostHighConfidence(realmId);
  results.posted = postResult.posted;
  console.log(`    Auto-posted ${results.posted} high-confidence transactions`);

  // Step 5: Email low-confidence transactions for review
  const { rows: lowConf } = await pool.query(
    "SELECT * FROM transactions WHERE realm_id = $1 AND status = 'categorized' AND (ai_confidence < $2 OR ai_confidence IS NULL) ORDER BY date DESC",
    [realmId, CONFIDENCE_THRESHOLD]
  );
  results.needsReview = lowConf.length;
  if (lowConf.length > 0) {
    console.log(`    ${lowConf.length} transactions need review — sending email`);
    await sendReviewEmail(realmId, lowConf);
  } else {
    console.log(`    All transactions auto-posted — no review needed`);
  }

  return results;
}

// ── Daily Conversation Summaries + Archive at 10 PM Eastern ─────────────────
function scheduleAt10PM() {
  cron.schedule('* * * * *', () => require('./services/summaryJobs').enqueueDueSummaries().catch(() => console.error('[scheduler] Summary enqueue unavailable')));
  // Use node-cron with timezone for reliable daily execution (fixes fragile setTimeout + TZ parse)
  cron.schedule('0 22 * * *', async () => {
    // ── Archive pipeline jobs sitting in terminal stages ──────────────────
    try {
      const { rows: terminalJobs } = await pool.query(`
        SELECT pj.id, pj.entity_type, pj.entity_id, pj.instance_id, pj.current_stage_id,
               pi.firm_id, pi.name AS instance_name, pi.tax_year,
               pt.name AS template_name
        FROM pipeline_jobs pj
        JOIN pipeline_stages ps ON ps.id = pj.current_stage_id
        JOIN pipeline_instances pi ON pi.id = pj.instance_id
        JOIN pipeline_templates pt ON pt.id = pi.template_id
        WHERE ps.is_terminal = true
          AND COALESCE(ps.hold_for_migration, false) = false
          AND COALESCE(pj.job_status, 'active') NOT IN ('archived', 'complete', 'completed')
      `);

      let archived = 0;
      for (const job of terminalJobs) {
        try {
          await pool.query(
            `UPDATE pipeline_jobs SET job_status = 'archived', updated_at = NOW() WHERE id = $1`,
            [job.id]
          );
          const taxYearInt = job.tax_year ? parseInt(job.tax_year) : null;
          await pool.query(
            `INSERT INTO pipeline_completions
               (firm_id, entity_type, entity_id, pipeline_instance_id, stage_id, pipeline_name, tax_year, job_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING`,
            [job.firm_id, job.entity_type, job.entity_id, job.instance_id, job.current_stage_id,
             job.instance_name || job.template_name, taxYearInt, job.id]
          );
          archived++;
        } catch(e) {
          console.error(`[scheduler] Archive job ${job.id} error:`, e.message);
        }
      }
      if (archived > 0) console.log(`[scheduler] Archived ${archived} pipeline jobs in terminal stages`);
    } catch(e) {
      console.error('[scheduler] Pipeline archival job error:', e.message);
      sendErrorAlert({ source: 'scheduler/pipeline-archival', error: e }).catch(() => {});
    }
  }, {
    timezone: 'America/New_York'
  });

  console.log('[scheduler] Daily summaries use each firm timezone; terminal archive runs at 10 PM Eastern');
}

// ── Blueleaf nightly sync — 8 AM UTC (overnight US time) ────────────────────
function startBlueleafSync() {
  const blueleafService = require('./services/blueleaf');

  cron.schedule('0 8 * * *', async () => {
    try {
      const { rows: people } = await pool.query(
        `SELECT p.id, p.firm_id, p.blueleaf_household_id, f.blueleaf_api_token
         FROM people p
         JOIN firms f ON f.id = p.firm_id
         WHERE p.financial_planning_enabled = true
           AND p.blueleaf_household_id IS NOT NULL
           AND f.blueleaf_api_token IS NOT NULL
           AND f.blueleaf_api_token != ''`
      );
      console.log(`[blueleaf] Nightly sync starting: ${people.length} people`);
      let synced = 0;
      let failed = 0;
      for (const person of people) {
        const startedAt = Date.now();
        try {
          await blueleafService.syncPerson(require('./utils/encryption').decrypt(person.blueleaf_api_token), person.id, person.blueleaf_household_id, person.firm_id, pool);
          synced++;
          console.log(`[blueleaf] Synced person ${person.id} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
        } catch (e) {
          failed++;
          console.error(`[blueleaf] Sync failed for person ${person.id}:`, e.message);
        }
      }
      console.log(`[blueleaf] Nightly sync complete: ${synced} synced, ${failed} failed`);
    } catch (e) {
      console.error('[blueleaf] Nightly sync error:', e.message);
      sendErrorAlert({ source: 'scheduler/blueleaf-sync', error: e }).catch(() => {});
    }
  });

  console.log('[blueleaf] Nightly sync scheduled (0 8 * * * UTC)');
}

function startScheduler() {
  // Run every 6 hours: full automated pipeline
  cron.schedule('0 */6 * * *', async () => {
    console.log(`[${new Date().toISOString()}] Overnight automation starting...`);

    try {
      const { rows: companies } = await pool.query('SELECT realm_id, company_name FROM companies');

      for (const company of companies) {
        const { realm_id, company_name } = company;
        console.log(`  Processing: ${company_name || realm_id}`);

        try {
          await runFullPipeline(realm_id);
        } catch (err) {
          console.error(`    Error processing ${company_name || realm_id}:`, err.message);
          sendErrorAlert({
            source: `scheduler/qbo-pipeline/${realm_id}`,
            error: err,
            context: { company: company_name || realm_id, realm_id },
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[scheduler] 6-hour pipeline tick error:', err.message);
      sendErrorAlert({ source: 'scheduler/qbo-pipeline-tick', error: err }).catch(() => {});
    }

    console.log(`[${new Date().toISOString()}] Overnight automation complete.`);
  });

  console.log('Scheduler started — runs every 6 hours (sync → research → categorize → auto-post → email)');
}

// ── Nightly statement reminder — runs at 9 AM Eastern ───────────────────────
// For each client_upload account where today == statement_day,
// send a reminder email to all portal-enabled people on that company.
function startStatementReminders() {
  // Run daily at 9 AM Eastern (14:00 UTC)
  cron.schedule('0 14 * * *', async () => {
    try {
      const { sendStatementReminder } = require('./services/email');
      const now = new Date();
      const todayDay = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', day: 'numeric' }));
      // Current month-to-remind about = previous month (statements due this month are for last month)
      const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const remindMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;

      // Find all client_upload accounts where statement_day matches today
      const { rows: schedules } = await pool.query(
        `SELECT ss.id, ss.realm_id, ss.account_name, ss.start_month, ss.statement_day,
                c.id AS company_id, c.company_name, c.firm_id,
                f.display_name AS firm_name
         FROM statement_schedules ss
         JOIN companies c ON c.realm_id = ss.realm_id
         JOIN firms f ON f.id = c.firm_id
         WHERE ss.access_method = 'client_upload'
           AND ss.statement_day = $1
           AND ss.start_month IS NOT NULL
           AND ss.start_month <> ''
           AND ss.start_month <= $2`,
        [todayDay, remindMonth]
      );

      let sent = 0;
      for (const sched of schedules) {
        // Skip if already uploaded for this month
        const { rows: existing } = await pool.query(
          `SELECT 1 FROM statement_monthly_status
           WHERE schedule_id = $1 AND month = $2 AND status IN ('uploaded','received')`,
          [sched.id, remindMonth]
        );
        if (existing.length) continue;

        // Find portal-enabled people with access to this company
        const { rows: people } = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.spouse_name, p.email, p.portal_invite_token
           FROM people p
           JOIN person_company_access pca ON pca.person_id = p.id
           WHERE pca.company_id = $1
             AND p.portal_enabled = true
             AND p.email IS NOT NULL
             AND p.email <> ''`,
          [sched.company_id]
        );

        const portalBase = process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080';
        const portalUrl = `${portalBase}/portal?tab=co-${sched.company_id}&subtab=statements`;

        // Fetch firm logo once per schedule
        let logoUrl = null;
        try {
          const { getFirmLogoUrl } = require('./services/email');
          logoUrl = await getFirmLogoUrl(sched.firm_id);
        } catch(e) { /* non-fatal */ }

        for (const person of people) {
          try {
            await sendStatementReminder({
              to: person.email,
              name: formatPersonDisplayName(person),
              firmName: sched.firm_name,
              firmId: sched.firm_id,
              logoUrl,
              companyName: sched.company_name,
              accountName: sched.account_name,
              month: remindMonth,
              portalUrl,
            });
            sent++;
          } catch(e) {
            console.error(`[statements] Reminder email failed for person ${person.id}:`, e.message);
          }
        }
      }

      if (sent > 0) console.log(`[statements] Sent ${sent} statement reminder email(s) for ${remindMonth}`);
    } catch(e) {
      console.error('[statements] Reminder job error:', e.message);
      sendErrorAlert({ source: 'scheduler/statement-reminders', error: e }).catch(() => {});
    }
  });

  console.log('[statements] Nightly reminder cron scheduled (9 AM Eastern daily)');
}

// ── Weekly MRR sync — Sunday 3 AM UTC ────────────────────────────────────────
function startWeeklyMRRSync() {
  cron.schedule('0 3 * * 0', async () => {
    console.log('[mrr-sync] Starting weekly MRR + revenue sync...');
    try {
      const { syncAllMRR } = require('./services/billingMrr');
      const { syncAllCompanyRevenue } = require('./services/revenueSync');
      const { rows: firms } = await pool.query('SELECT id FROM firms');
      for (const firm of firms) {
        await syncAllMRR(firm.id).catch(e =>
          console.error(`[mrr-sync] firm ${firm.id}:`, e.message)
        );
        await syncAllCompanyRevenue(firm.id).catch(e =>
          console.error(`[revenue-sync] firm ${firm.id}:`, e.message)
        );
      }
      console.log('[mrr-sync] Weekly MRR + revenue sync complete.');
    } catch(e) {
      console.error('[mrr-sync] Weekly sync error:', e.message);
      sendErrorAlert({ source: 'scheduler/mrr-weekly', error: e }).catch(() => {});
    }
  });
  console.log('[mrr-sync] Weekly MRR + revenue sync scheduled (Sunday 3 AM UTC)');
}

// ── Nightly firm metrics refresh — 4 AM UTC ───────────────────────────────
// Refreshes MRR + past-due flag (and any future cached metrics) for every firm
// so the dashboard /intel route can read from cache instead of hitting Stripe.
function startFirmMetricsRefresh() {
  cron.schedule('0 4 * * *', async () => {
    console.log('[metrics] Starting nightly firm metrics refresh...');
    try {
      const { refreshAllFirms } = require('./services/metrics');
      await refreshAllFirms();
      console.log('[metrics] Nightly firm metrics refresh complete.');
    } catch(e) {
      console.error('[metrics] Nightly refresh error:', e.message);
      sendErrorAlert({ source: 'scheduler/firm-metrics', error: e }).catch(() => {});
    }
  });
  console.log('[metrics] Nightly firm metrics refresh scheduled (4 AM UTC)');
}

// ── Bookkeeper nightly run — 11 PM Eastern (3 AM UTC) ──────────────────
// Runs AFTER QBO token refresh (2 AM UTC) to ensure valid tokens.
// For each QBO-connected company: pull uncategorized → map → AI research → code/flag.
function startBookkeeperScheduler() {
  cron.schedule('0 3 * * *', async () => {
    if (String(process.env.AUTO_BOOKKEEPER_ENABLED || 'true').toLowerCase() === 'false') {
      console.log(`[${new Date().toISOString()}] [bookkeeper] Nightly run skipped, AUTO_BOOKKEEPER_ENABLED=false`);
      return;
    }

    console.log(`[${new Date().toISOString()}] [bookkeeper] Nightly bookkeeper run starting...`);

    const { runBookkeeper } = require('./services/bookkeeper');

    try {
      const { rows: companies } = await pool.query(`
        SELECT DISTINCT c.realm_id, c.firm_id, c.company_name
        FROM companies c
        WHERE c.realm_id IS NOT NULL AND c.realm_id != ''
          AND c.firm_id IS NOT NULL
          AND c.auto_bookkeeper_enabled = TRUE
      `);

      let totalFound = 0, totalCoded = 0, totalReview = 0;

      for (const company of companies) {
        try {
          const result = await runBookkeeper(company.realm_id, company.firm_id);
          totalFound += result.txns_found || 0;
          totalCoded += (result.txns_auto_coded || 0) + (result.txns_ai_coded || 0);
          totalReview += result.txns_manual_review || 0;
          console.log(`  [bookkeeper] ${company.company_name || company.realm_id}: found=${result.txns_found} auto=${result.txns_auto_coded} ai=${result.txns_ai_coded} review=${result.txns_manual_review}`);
        } catch (err) {
          console.error(`  [bookkeeper] ${company.company_name || company.realm_id} FAILED:`, err.message);
        }
      }

      console.log(`[${new Date().toISOString()}] [bookkeeper] Nightly run complete: ${companies.length} companies, ${totalFound} found, ${totalCoded} coded, ${totalReview} for review`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [bookkeeper] Nightly run error:`, err.message);
      sendErrorAlert({ source: 'scheduler/bookkeeper-nightly', error: err }).catch(() => {});
    }
  });

  console.log('[bookkeeper] Nightly bookkeeper scheduled (11 PM Eastern / 3 AM UTC)');
}

// ── Bookkeeping questions reminder — daily at 10 AM Eastern (14:00 UTC) ──────────────
function startBookkeepingQuestionsReminder() {
  cron.schedule('0 14 * * *', async () => {
    try {
      const { sendBookkeepingQuestionsReminder } = require('./services/email');
      const { getFirmLogoUrl } = require('./services/email');
      const now = new Date();

      // Find transactions sent to client 3+ days ago that are still uncoded
      // Group by person (portal user) so we send one email per person
      // A person has access to companies via person_company_access
      const { rows: pending } = await pool.query(`
        SELECT DISTINCT ON (bu.realm_id, bu.txn_qb_id)
          bu.id, bu.realm_id, bu.company_name, bu.firm_id,
          bu.sent_to_client_at, c.id AS company_id, f.display_name AS firm_name
        FROM bookkeeper_uncoded bu
        JOIN companies c ON c.realm_id = bu.realm_id
        JOIN firms f ON f.id = bu.firm_id
        WHERE bu.sent_to_client = TRUE
          AND bu.coded_by_client = FALSE
          AND bu.sent_to_client_at <= NOW() - INTERVAL '3 days'
          AND (bu.amount IS NOT NULL AND bu.amount != 0)
        ORDER BY bu.realm_id, bu.txn_qb_id, bu.run_id DESC, bu.id DESC
      `);

      if (!pending.length) return;

      // Group by company_id, then find portal users with access
      const byCompany = {};
      for (const row of pending) {
        if (!byCompany[row.company_id]) {
          byCompany[row.company_id] = { count: 0, firmId: row.firm_id, firmName: row.firm_name };
        }
        byCompany[row.company_id].count++;
      }

      // For each company, find portal-enabled people with access
      // Aggregate per-person across all their companies
      const personMap = {}; // personId → { email, name, firmId, firmName, count }
      for (const [companyId, data] of Object.entries(byCompany)) {
        const { rows: people } = await pool.query(
          `SELECT p.id, p.first_name, p.last_name, p.spouse_name, p.email
           FROM people p
           JOIN person_company_access pca ON pca.person_id = p.id
           WHERE pca.company_id = $1
             AND p.portal_enabled = TRUE
             AND p.email IS NOT NULL AND p.email <> ''`,
          [companyId]
        );
        for (const person of people) {
          if (!personMap[person.id]) {
            personMap[person.id] = {
              email: person.email,
              name: formatPersonDisplayName(person),
              firmId: data.firmId,
              firmName: data.firmName,
              count: 0,
            };
          }
          personMap[person.id].count += data.count;
        }
      }

      const portalBase = process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080';
      const portalUrl = `${portalBase}/portal?tab=bookkeeping`;

      let sent = 0;
      for (const [personId, data] of Object.entries(personMap)) {
        try {
          let logoUrl = null;
          try { logoUrl = await getFirmLogoUrl(data.firmId); } catch(e) { /* non-fatal */ }
          await sendBookkeepingQuestionsReminder({
            to: data.email,
            name: data.name,
            firmName: data.firmName,
            firmId: data.firmId,
            logoUrl,
            count: data.count,
            portalUrl,
          });
          sent++;
        } catch(e) {
          console.error(`[bk-reminder] Email failed for person ${personId}:`, e.message);
        }
      }

      if (sent > 0) console.log(`[bk-reminder] Sent ${sent} bookkeeping question reminder(s)`);
    } catch(e) {
      console.error('[bk-reminder] Reminder job error:', e.message);
      sendErrorAlert({ source: 'scheduler/bk-reminder', error: e }).catch(() => {});
    }
  });
  console.log('[bk-reminder] Bookkeeping questions reminder scheduled (10 AM Eastern daily)');
}

module.exports = { sendReviewEmail, startScheduler, runFullPipeline, scheduleAt10PM, startBlueleafSync, startStatementReminders, startWeeklyMRRSync, startFirmMetricsRefresh, startBookkeeperScheduler, startBookkeepingQuestionsReminder };
