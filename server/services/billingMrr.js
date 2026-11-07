'use strict';

const { pool } = require('../db');

// Initialize Stripe clients (read-only restricted keys)
async function getStripeClient(account,firmId) {
  const match=(await require('./firmIntegrations').stripeAccounts(firmId)).find(a=>a.name===account);
  return match?require('stripe')(match.key,{apiVersion:'2024-12-18.acacia'}):null;
}

// Ensure billing config columns exist
async function ensureBillingCols() {
  await pool.query(`
    ALTER TABLE relationships
    ADD COLUMN IF NOT EXISTS billing_accounts TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS billing_emails TEXT[] DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS mrr NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS mrr_synced_at TIMESTAMPTZ DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS aum_billing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS aum_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS aum_annual_rate NUMERIC(8,4) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS aum_min_monthly_fee NUMERIC(10,2) DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS aum_override_monthly_fee NUMERIC(10,2) DEFAULT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relationship_aum_billing_lines (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      label TEXT DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      annual_rate NUMERIC(8,4) DEFAULT NULL,
      min_monthly_fee NUMERIC(10,2) DEFAULT NULL,
      override_monthly_fee NUMERIC(10,2) DEFAULT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS relationship_aum_billing_lines_relationship
      ON relationship_aum_billing_lines(firm_id, relationship_id, enabled);
  `);
}

function accountValue(account = {}) {
  const candidates = [account.currentNetValue, account.balance, account.value, account.current_value, account.marketValue];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

async function buildAumLineSummary(line, firmId) {
  const personId = line.person_id;
  if (!personId) return { ...line, configured: false, reason: 'No Blueleaf household selected.', monthly_fee: 0 };

  const { rows: personRows } = await pool.query(
    `SELECT id, first_name, last_name, email, blueleaf_household_id, blueleaf_hidden_accounts
     FROM people WHERE id = $1 AND firm_id = $2`,
    [personId, firmId]
  );
  const person = personRows[0];
  if (!person?.blueleaf_household_id) return { ...line, configured: false, person_id: personId, reason: 'Selected person has no Blueleaf household.', monthly_fee: 0 };

  const { rows: snapRows } = await pool.query(
    `SELECT * FROM blueleaf_snapshots WHERE firm_id = $1 AND person_id = $2 ORDER BY snapshot_date DESC LIMIT 1`,
    [firmId, personId]
  );
  const snapshot = snapRows[0];
  if (!snapshot) return { ...line, configured: false, person_id: personId, reason: 'No Blueleaf snapshot found.', monthly_fee: 0 };

  const hidden = Array.isArray(person.blueleaf_hidden_accounts) ? person.blueleaf_hidden_accounts.map(String) : [];
  const accounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const includedAccounts = accounts.filter(a => !hidden.includes(String(a.id)));
  const includedBalance = includedAccounts.reduce((sum, a) => sum + accountValue(a), 0);
  const fallbackBalance = Number(snapshot.raw_balance || 0);
  const billableAum = includedAccounts.length ? includedBalance : fallbackBalance;
  const annualRate = Number(line.annual_rate || 0);
  const baseMonthly = annualRate > 0 ? (billableAum * (annualRate / 100) / 12) : 0;
  const minMonthly = Number(line.min_monthly_fee || 0);
  const override = line.override_monthly_fee != null ? Number(line.override_monthly_fee) : null;
  const monthlyFee = override != null && Number.isFinite(override)
    ? override
    : Math.max(baseMonthly, Number.isFinite(minMonthly) ? minMonthly : 0);
  const personName = `${person.first_name || ''} ${person.last_name || ''}`.trim() || person.email || 'Blueleaf household';

  return {
    id: line.id,
    label: line.label || personName,
    enabled: line.enabled !== false,
    configured: true,
    person_id: person.id,
    person_name: personName,
    blueleaf_household_id: person.blueleaf_household_id,
    snapshot_date: snapshot.snapshot_date,
    synced_at: snapshot.synced_at,
    billable_aum: Math.round(billableAum * 100) / 100,
    raw_balance: Math.round(fallbackBalance * 100) / 100,
    annual_rate: annualRate,
    annual_fee: Math.round(billableAum * (annualRate / 100) * 100) / 100,
    monthly_fee: Math.round(monthlyFee * 100) / 100,
    min_monthly_fee: minMonthly || null,
    override_monthly_fee: override,
    included_account_count: includedAccounts.length,
    hidden_account_count: accounts.length - includedAccounts.length,
    accounts: includedAccounts.map(a => ({
      id: a.id,
      name: a.name || a.accountName || 'Account',
      institutionName: a.institutionName || '',
      accountType: a.accountType || '',
      balance: Math.round(accountValue(a) * 100) / 100,
    })),
  };
}

async function getAumBillingSummary(relId, firmId) {
  await ensureBillingCols();
  const { rows: relRows } = await pool.query(
    `SELECT id, name, aum_billing_enabled, aum_person_id, aum_annual_rate, aum_min_monthly_fee, aum_override_monthly_fee
     FROM relationships WHERE id = $1 AND firm_id = $2`,
    [relId, firmId]
  );
  const rel = relRows[0];
  if (!rel) return { enabled: false, configured: false, lines: [], monthly_fee: 0 };

  const { rows: dbLines } = await pool.query(
    `SELECT id, person_id, label, enabled, annual_rate, min_monthly_fee, override_monthly_fee
     FROM relationship_aum_billing_lines
     WHERE relationship_id = $1 AND firm_id = $2
     ORDER BY id`,
    [relId, firmId]
  );

  let sourceLines = dbLines;
  if (!sourceLines.length && rel.aum_billing_enabled) {
    sourceLines = [{
      id: null,
      person_id: rel.aum_person_id,
      label: '',
      enabled: true,
      annual_rate: rel.aum_annual_rate,
      min_monthly_fee: rel.aum_min_monthly_fee,
      override_monthly_fee: rel.aum_override_monthly_fee,
    }];
  }

  const enabled = sourceLines.some(line => line.enabled !== false) || !!rel.aum_billing_enabled;
  if (!enabled) return { enabled: false, configured: false, lines: [], monthly_fee: 0 };

  const lines = [];
  for (const line of sourceLines.filter(l => l.enabled !== false)) {
    lines.push(await buildAumLineSummary(line, firmId));
  }
  const configuredLines = lines.filter(l => l.configured);
  const monthlyFee = configuredLines.reduce((sum, line) => sum + (Number(line.monthly_fee) || 0), 0);
  const billableAum = configuredLines.reduce((sum, line) => sum + (Number(line.billable_aum) || 0), 0);
  const annualFee = configuredLines.reduce((sum, line) => sum + (Number(line.annual_fee) || 0), 0);

  return {
    enabled: true,
    configured: configuredLines.length > 0,
    relationship_id: rel.id,
    relationship_name: rel.name,
    lines,
    line_count: configuredLines.length,
    monthly_fee: Math.round(monthlyFee * 100) / 100,
    billable_aum: Math.round(billableAum * 100) / 100,
    annual_fee: Math.round(annualFee * 100) / 100,
    reason: configuredLines.length ? null : (lines[0]?.reason || 'No configured IAS/AUM billing lines.'),
  };
}


// Sync MRR for a single relationship from Stripe + AUM billing
async function syncRelationshipMRR(relId, firmId) {
  const { rows } = await pool.query(
    'SELECT billing_accounts, billing_emails FROM relationships WHERE id=$1 AND firm_id=$2',
    [relId, firmId]
  );
  if (!rows.length) return;
  const { billing_accounts = [], billing_emails = [] } = rows[0];

  let mrr = 0;
  for (const account of billing_accounts) {
    const stripe = await getStripeClient(account,firmId);
    if (!stripe) continue;
    for (const email of billing_emails) {
      try {
        const custList = await stripe.customers.list({ email, limit: 5 });
        for (const cust of custList.data) {
          const subList = await stripe.subscriptions.list({
            customer: cust.id, status: 'active', limit: 20,
            expand: ['data.items.data.price'],
          });
          for (const sub of subList.data) {
            for (const item of sub.items.data) {
              const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
              mrr += item.price?.recurring?.interval === 'year' ? amt / 12 : amt;
            }
          }
        }
      } catch(e) { /* non-fatal */ }
    }
  }

  const aum = await getAumBillingSummary(relId, firmId);
  if (aum.enabled && aum.configured && aum.monthly_fee > 0) mrr += aum.monthly_fee;

  await pool.query(
    'UPDATE relationships SET mrr=$1, mrr_synced_at=NOW() WHERE id=$2',
    [Math.round(mrr * 100) / 100, relId]
  );
  return mrr;
}

// Sync MRR for ALL relationships — pulls all Stripe subs at once (same as forecast)
async function syncAllMRR(firmId) {
  const STRIPE_ACCOUNTS = await require('./firmIntegrations').stripeAccounts(firmId);

  // Build account|email -> MRR map so each relationship only counts the
  // Stripe accounts it is linked to (matches the live relationship summary).
  const emailMrr = {}; // "account|lowercased email" -> mrr

  for (const acct of STRIPE_ACCOUNTS) {
    const stripe = await getStripeClient(acct.name,firmId);
    if (!stripe) continue;
    try {
      let starting_after;
      while (true) {
        const params = { status: 'active', limit: 100, expand: ['data.items.data.price', 'data.customer'] };
        if (starting_after) params.starting_after = starting_after;
        const page = await stripe.subscriptions.list(params);
        for (const sub of page.data) {
          const cust = sub.customer;
          const email = ((typeof cust === 'object' ? cust.email : null) || '').toLowerCase();
          if (!email) continue;
          let monthly = 0;
          for (const item of sub.items.data) {
            const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
            monthly += item.price?.recurring?.interval === 'year' ? amt / 12 : amt;
          }
          const mapKey = `${acct.name}|${email}`;
          emailMrr[mapKey] = (emailMrr[mapKey] || 0) + monthly;
        }
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }
    } catch(e) {
      console.error(`[billing] syncAllMRR Stripe fetch ${acct.name}:`, e.message);
    }
  }

  // Load all configured relationships
  const { rows } = await pool.query(
    `SELECT id, billing_accounts, billing_emails FROM relationships WHERE firm_id=$1
     AND (
       (billing_accounts IS NOT NULL AND array_length(billing_accounts,1) > 0 AND billing_emails IS NOT NULL AND array_length(billing_emails,1) > 0)
       OR aum_billing_enabled = TRUE
     )`,
    [firmId]
  );

  // Match and update
  for (const rel of rows) {
    let mrr = 0;
    for (const account of (rel.billing_accounts || [])) {
      for (const email of (rel.billing_emails || [])) {
        mrr += emailMrr[`${account}|${email.trim().toLowerCase()}`] || 0;
      }
    }
    const aum = await getAumBillingSummary(rel.id, firmId);
    if (aum.enabled && aum.configured && aum.monthly_fee > 0) mrr += aum.monthly_fee;
    await pool.query(
      'UPDATE relationships SET mrr=$1, mrr_synced_at=NOW() WHERE id=$2',
      [Math.round(mrr * 100) / 100, rel.id]
    ).catch(e => console.error(`[billing] syncMRR update rel ${rel.id}:`, e.message)
    );
  }
}

module.exports = {
  getStripeClient,
  ensureBillingCols,
  getAumBillingSummary,
  syncRelationshipMRR,
  syncAllMRR,
};
