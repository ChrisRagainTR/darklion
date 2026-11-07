'use strict';

const { Router } = require('express');
const { pool } = require('../db');

const router = Router();

const { getStripeClient, ensureBillingCols, getAumBillingSummary, syncRelationshipMRR, syncAllMRR } = require('../services/billingMrr');

// GET /:relId/config — get billing config for this relationship
router.get('/:relId/config', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  try {
    await ensureBillingCols();
    const { rows } = await pool.query(
      `SELECT billing_accounts, billing_emails, aum_billing_enabled, aum_person_id, aum_annual_rate,
              aum_min_monthly_fee, aum_override_monthly_fee
       FROM relationships WHERE id = $1 AND firm_id = $2`,
      [relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: people } = await pool.query(
      `SELECT id, first_name, last_name, email, financial_planning_enabled, blueleaf_household_id
       FROM people WHERE relationship_id = $1 AND firm_id = $2 ORDER BY first_name, last_name, id`,
      [relId, firmId]
    );
    const { rows: aumLines } = await pool.query(
      `SELECT id, person_id, label, enabled, annual_rate, min_monthly_fee, override_monthly_fee
       FROM relationship_aum_billing_lines
       WHERE relationship_id = $1 AND firm_id = $2
       ORDER BY id`,
      [relId, firmId]
    );
    const aumSummary = await getAumBillingSummary(relId, firmId);
    res.json({
      available_accounts: (await require('../services/firmIntegrations').stripeAccounts(firmId)).map(({name,label})=>({name,label})),
      billing_accounts: rows[0].billing_accounts || [],
      billing_emails: rows[0].billing_emails || [],
      aum_billing_enabled: !!rows[0].aum_billing_enabled,
      aum_person_id: rows[0].aum_person_id,
      aum_annual_rate: rows[0].aum_annual_rate,
      aum_min_monthly_fee: rows[0].aum_min_monthly_fee,
      aum_override_monthly_fee: rows[0].aum_override_monthly_fee,
      aum_people: people,
      aum_lines: aumLines,
      aum_summary: aumSummary,
    });
  } catch (err) {
    console.error('GET /billing/:relId/config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /:relId/config — update billing config
router.put('/:relId/config', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  const {
    billing_accounts = [],
    billing_emails = [],
    aum_billing_enabled = false,
    aum_person_id = null,
    aum_annual_rate = null,
    aum_min_monthly_fee = null,
    aum_override_monthly_fee = null,
    aum_lines = null,
  } = req.body;
  try {
    await ensureBillingCols();
    const { rows } = await pool.query(
      'SELECT id FROM relationships WHERE id = $1 AND firm_id = $2',
      [relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const validAccounts = (await require('../services/firmIntegrations').stripeAccounts(firmId)).map(a=>a.name);
    const accounts = billing_accounts.filter(a => validAccounts.includes(a));
    const emails = billing_emails.map(e => e.trim()).filter(Boolean);
    const cleanAumPersonId = Number.isInteger(Number(aum_person_id)) && Number(aum_person_id) > 0 ? Number(aum_person_id) : null;
    const cleanRate = aum_annual_rate === '' || aum_annual_rate == null ? null : Number(aum_annual_rate);
    const cleanMin = aum_min_monthly_fee === '' || aum_min_monthly_fee == null ? null : Number(aum_min_monthly_fee);
    const cleanOverride = aum_override_monthly_fee === '' || aum_override_monthly_fee == null ? null : Number(aum_override_monthly_fee);
    if ((cleanRate != null && (!Number.isFinite(cleanRate) || cleanRate < 0 || cleanRate > 10)) ||
        (cleanMin != null && (!Number.isFinite(cleanMin) || cleanMin < 0)) ||
        (cleanOverride != null && (!Number.isFinite(cleanOverride) || cleanOverride < 0))) {
      return res.status(400).json({ error: 'Invalid IAS/AUM billing values' });
    }

    await pool.query(
      `UPDATE relationships
       SET billing_accounts = $1, billing_emails = $2,
           aum_billing_enabled = $3, aum_person_id = $4, aum_annual_rate = $5,
           aum_min_monthly_fee = $6, aum_override_monthly_fee = $7
       WHERE id = $8 AND firm_id = $9`,
      [accounts, emails, !!aum_billing_enabled, cleanAumPersonId, cleanRate, cleanMin, cleanOverride, relId, firmId]
    );

    if (Array.isArray(aum_lines)) {
      await pool.query('DELETE FROM relationship_aum_billing_lines WHERE relationship_id = $1 AND firm_id = $2', [relId, firmId]);
      for (const line of aum_lines.slice(0, 20)) {
        const linePersonId = Number.isInteger(Number(line.person_id)) && Number(line.person_id) > 0 ? Number(line.person_id) : null;
        const lineRate = line.annual_rate === '' || line.annual_rate == null ? null : Number(line.annual_rate);
        const lineMin = line.min_monthly_fee === '' || line.min_monthly_fee == null ? null : Number(line.min_monthly_fee);
        const lineOverride = line.override_monthly_fee === '' || line.override_monthly_fee == null ? null : Number(line.override_monthly_fee);
        if (!linePersonId && !line.label) continue;
        if ((lineRate != null && (!Number.isFinite(lineRate) || lineRate < 0 || lineRate > 10)) ||
            (lineMin != null && (!Number.isFinite(lineMin) || lineMin < 0)) ||
            (lineOverride != null && (!Number.isFinite(lineOverride) || lineOverride < 0))) {
          return res.status(400).json({ error: 'Invalid IAS/AUM billing line values' });
        }
        await pool.query(
          `INSERT INTO relationship_aum_billing_lines
             (firm_id, relationship_id, person_id, label, enabled, annual_rate, min_monthly_fee, override_monthly_fee)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [firmId, relId, linePersonId, String(line.label || '').trim(), line.enabled !== false, lineRate, lineMin, lineOverride]
        );
      }
    }
    syncRelationshipMRR(relId, firmId).catch(e => console.error('[billing] syncMRR post-save:', e.message));
    const aumSummary = await getAumBillingSummary(relId, firmId);
    const { rows: savedAumLines } = await pool.query(
      `SELECT id, person_id, label, enabled, annual_rate, min_monthly_fee, override_monthly_fee
       FROM relationship_aum_billing_lines
       WHERE relationship_id = $1 AND firm_id = $2
       ORDER BY id`,
      [relId, firmId]
    );
    const { rows: people } = await pool.query(
      `SELECT id, first_name, last_name, email, financial_planning_enabled, blueleaf_household_id
       FROM people WHERE relationship_id = $1 AND firm_id = $2 ORDER BY first_name, last_name, id`,
      [relId, firmId]
    );
    res.json({
      billing_accounts: accounts,
      billing_emails: emails,
      aum_billing_enabled: !!aum_billing_enabled,
      aum_person_id: cleanAumPersonId,
      aum_annual_rate: cleanRate,
      aum_min_monthly_fee: cleanMin,
      aum_override_monthly_fee: cleanOverride,
      aum_people: people,
      aum_lines: savedAumLines,
      aum_summary: aumSummary,
    });
  } catch (err) {
    console.error('PUT /billing/:relId/config error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /:relId/summary — fetch live Stripe data + IAS/AUM billing data
router.get('/:relId/summary', async (req, res) => {
  const firmId = req.firm.id;
  const { relId } = req.params;
  try {
    await ensureBillingCols();
    const { rows } = await pool.query(
      'SELECT billing_accounts, billing_emails FROM relationships WHERE id = $1 AND firm_id = $2',
      [relId, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const { billing_accounts = [], billing_emails = [] } = rows[0];
    const aumSummary = await getAumBillingSummary(relId, firmId);
    const hasAum = !!(aumSummary.enabled && aumSummary.configured && aumSummary.monthly_fee > 0);

    if ((!billing_accounts.length || !billing_emails.length) && !hasAum) {
      return res.json({ configured: false, accounts: [], aum_summary: aumSummary });
    }

    const ACCOUNT_LABELS = { default: process.env.STRIPE_ACCOUNT_LABEL || 'Stripe' };

    const results = [];

    if (billing_accounts.length && billing_emails.length) {
      for (const account of billing_accounts) {
        const stripe = await getStripeClient(account,firmId);
        if (!stripe) {
          results.push({ account, label: ACCOUNT_LABELS[account] || account, error: 'Stripe key not configured', customers: [] });
          continue;
        }

        const customers = [];

        for (const email of billing_emails) {
          try {
            const custList = await stripe.customers.list({ email, limit: 5 });
            for (const cust of custList.data) {
              const subList = await stripe.subscriptions.list({
                customer: cust.id,
                limit: 10,
                expand: ['data.items.data.price'],
              });

              const invList = await stripe.invoices.list({ customer: cust.id, limit: 5 });

              const subscriptions = subList.data.map(sub => ({
                id: sub.id,
                status: sub.status,
                current_period_end: sub.current_period_end,
                cancel_at_period_end: sub.cancel_at_period_end,
                items: sub.items.data.map(item => ({
                  description: item.price?.nickname || item.price?.product_name || item.price?.lookup_key || 'Subscription',
                  amount: (item.price?.unit_amount || 0) / 100,
                  currency: item.price?.currency || 'usd',
                  interval: item.price?.recurring?.interval || 'month',
                  quantity: item.quantity || 1,
                })),
                total_monthly: sub.items.data.reduce((sum, item) => {
                  const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
                  const interval = item.price?.recurring?.interval;
                  return sum + (interval === 'year' ? amt / 12 : amt);
                }, 0),
              }));

              const invoices = invList.data.map(inv => ({
                id: inv.id,
                number: inv.number,
                amount_due: inv.amount_due / 100,
                amount_paid: inv.amount_paid / 100,
                status: inv.status,
                paid: inv.paid,
                created: inv.created,
                period_start: inv.period_start,
                period_end: inv.period_end,
                hosted_invoice_url: inv.hosted_invoice_url,
              }));

              customers.push({
                id: cust.id,
                name: cust.name || email,
                email: cust.email,
                subscriptions,
                invoices,
                total_monthly: subscriptions.reduce((sum, sub) => sum + sub.total_monthly, 0),
              });
            }
          } catch (stripeErr) {
            console.error(`Stripe error for ${account}/${email}:`, stripeErr.message);
            customers.push({ email, error: stripeErr.message });
          }
        }

        results.push({
          account,
          label: ACCOUNT_LABELS[account] || account,
          customers,
          total_monthly: customers.reduce((sum, c) => sum + (c.total_monthly || 0), 0),
        });
      }
    }

    const stripeMrr = results.reduce((sum, account) => sum + (account.total_monthly || 0), 0);
    const total_mrr = stripeMrr + (aumSummary.monthly_fee || 0);
    const has_past_due = results.some(a =>
      a.customers.some(c => c.subscriptions?.some(sub => sub.status === 'past_due'))
    );

    console.log(`[billing] ${relId} summary: ${results.length} accounts, ${results.reduce((sum, a)=>sum+(a.customers?.length||0),0)} customers, MRR $${total_mrr.toFixed(2)}`);
    res.json({ configured: true, accounts: results, total_mrr, stripe_mrr: stripeMrr, has_past_due, aum_summary: aumSummary });
  } catch (err) {
    console.error('GET /billing/:relId/summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /firm-mrr — aggregate MRR across all relationships for this firm
router.get('/firm-mrr', async (req, res) => {
  const firmId = req.firm.id;
  try {
    await ensureBillingCols();

    // Get all relationships that have billing configured
    const { rows: rels } = await pool.query(
      `SELECT id, billing_accounts, billing_emails FROM relationships
       WHERE firm_id=$1 AND (
         (billing_accounts IS NOT NULL AND billing_emails IS NOT NULL
          AND array_length(billing_accounts, 1) > 0 AND array_length(billing_emails, 1) > 0)
         OR aum_billing_enabled = TRUE
       )`,
      [firmId]
    );

    if (!rels.length) return res.json({ mrr: 0, past_due: false });

    // Collect all unique account+email pairs
    const pairs = new Map(); // account -> Set<email>
    for (const rel of rels) {
      for (const account of (rel.billing_accounts || [])) {
        if (!pairs.has(account)) pairs.set(account, new Set());
        for (const email of (rel.billing_emails || [])) {
          pairs.get(account).add(email);
        }
      }
    }

    let totalMrr = 0;
    let hasPastDue = false;

    for (const [account, emails] of pairs) {
      const stripe = await getStripeClient(account,firmId);
      if (!stripe) continue;

      for (const email of emails) {
        try {
          const custList = await stripe.customers.list({ email, limit: 5 });
          for (const cust of custList.data) {
            const subList = await stripe.subscriptions.list({
              customer: cust.id,
              status: 'all',
              limit: 20,
              expand: ['data.items.data.price'],
            });
            for (const sub of subList.data) {
              if (sub.status === 'past_due') hasPastDue = true;
              if (sub.status !== 'active') continue;
              for (const item of sub.items.data) {
                const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
                const interval = item.price?.recurring?.interval;
                totalMrr += interval === 'year' ? amt / 12 : amt;
              }
            }
          }
        } catch (e) {
          // Skip errors for individual customers — don't fail the whole request
          console.error(`[firm-mrr] Stripe error ${account}/${email}:`, e.message);
        }
      }
    }

    for (const rel of rels) {
      const aum = await getAumBillingSummary(rel.id, firmId);
      if (aum.enabled && aum.configured && aum.monthly_fee > 0) totalMrr += aum.monthly_fee;
    }

    res.json({ mrr: Math.round(totalMrr * 100) / 100, past_due: hasPastDue });
  } catch (err) {
    console.error('GET /billing/firm-mrr error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/sync-mrr — trigger full MRR sync for this firm
router.post('/sync-mrr', async (req, res) => {
  const firmId = req.firm.id;
  try {
    await syncAllMRR(firmId);
    const { rows } = await pool.query(
      'SELECT COUNT(*) AS updated FROM relationships WHERE firm_id=$1 AND mrr > 0',
      [firmId]
    );
    res.json({ ok: true, updated: parseInt(rows[0].updated) });
  } catch(e) {
    console.error('[billing] sync-mrr error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
