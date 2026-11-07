'use strict';
const { pool } = require('../db');
const { ensureBillingCols, getAumBillingSummary } = require('./billingMrr');

function getStripe(key) {
  return require('stripe')(key, { apiVersion: '2024-12-18.acacia' });
}

function buildMonthlyTotals(customers, forecastYear) {
  return Array.from({ length: 12 }, (_, monthIndex) => {
    const monthCustomers = customers.map(customer => customer.months[monthIndex]);
    const collected = monthCustomers
      .filter(month => month.status === 'paid')
      .reduce((sum, month) => sum + month.amount, 0);
    const past_due = monthCustomers
      .filter(month => month.status === 'past_due')
      .reduce((sum, month) => sum + month.amount, 0);
    const upcoming = monthCustomers
      .filter(month => month.status === 'upcoming')
      .reduce((sum, month) => sum + month.amount, 0);
    return {
      month: `${forecastYear}-${String(monthIndex + 1).padStart(2, '0')}`,
      collected,
      past_due,
      upcoming,
      projected: collected + past_due + upcoming,
    };
  });
}

async function buildRevenueForecast({ firmId, year = new Date().getFullYear(), now = new Date() }) {
  const STRIPE_ACCOUNTS = await require('./firmIntegrations').stripeAccounts(firmId);
  const forecastYear = parseInt(year, 10) || now.getFullYear();
    // Collect all customers + subscriptions + invoices from both accounts (in parallel)
    const allCustomers = [];

    await Promise.all(STRIPE_ACCOUNTS.map(async (acct) => {
      const stripe = getStripe(acct.key);

      // Page through all active subscriptions
      let subs = [];
      let starting_after = undefined;
      while (true) {
        const params = { status: 'active', limit: 100, expand: ['data.items.data.price', 'data.customer'] };
        if (starting_after) params.starting_after = starting_after;
        const page = await stripe.subscriptions.list(params);
        subs.push(...page.data);
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }

      // Also get past_due subscriptions
      let pastDueSubs = [];
      starting_after = undefined;
      while (true) {
        const params = { status: 'past_due', limit: 100, expand: ['data.items.data.price', 'data.customer'] };
        if (starting_after) params.starting_after = starting_after;
        const page = await stripe.subscriptions.list(params);
        pastDueSubs.push(...page.data);
        if (!page.has_more) break;
        starting_after = page.data[page.data.length - 1].id;
      }

      const allSubs = [...subs, ...pastDueSubs];

      // Group by customer
      const custMap = {};
      for (const sub of allSubs) {
        const cust = sub.customer;
        const custId = typeof cust === 'string' ? cust : cust.id;
        const email = (typeof cust === 'object' ? cust.email : null) || '';
        const name = (typeof cust === 'object' ? cust.name : null) || email;

        if (!custMap[custId]) {
          custMap[custId] = { custId, email, name, account: acct.label, subscriptions: [], monthlyAmount: 0 };
        }

        // Calculate monthly amount
        let monthly = 0;
        const lineItems = sub.items.data.map(item => {
          const amt = (item.price?.unit_amount || 0) / 100 * (item.quantity || 1);
          const interval = item.price?.recurring?.interval;
          const monthly_equiv = interval === 'year' ? amt / 12 : amt;
          monthly += monthly_equiv;
          return {
            description: item.price?.nickname || item.price?.lookup_key || 'Subscription',
            amount: amt,
            interval: interval || 'month',
            monthly_equiv,
          };
        });

        custMap[custId].subscriptions.push({
          id: sub.id,
          status: sub.status,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
          cancel_at_period_end: sub.cancel_at_period_end,
          billing_cycle_anchor: sub.billing_cycle_anchor,
          items: lineItems,
          monthly,
        });
        custMap[custId].monthlyAmount += monthly;
      }

      // Fetch invoices for all customers in parallel (10 at a time to avoid rate limits)
      const yearStart = Math.floor(new Date(forecastYear, 0, 1).getTime() / 1000);
      const yearEnd = Math.floor(new Date(forecastYear + 1, 0, 1).getTime() / 1000);
      const custEntries = Object.entries(custMap);

      // Batch into groups of 10 for parallel fetching
      for (let i = 0; i < custEntries.length; i += 10) {
        const batch = custEntries.slice(i, i + 10);
        await Promise.all(batch.map(async ([custId, cust]) => {
          try {
            const invList = await stripe.invoices.list({
              customer: custId,
              // Fetch last 18 months to ensure we capture invoices whose created date
              // may be slightly before yearStart (e.g. Dec 31 for Jan 1 billing)
              created: { gte: yearStart - 86400 * 15, lt: yearEnd },
              limit: 50,
            });
            cust.invoices = invList.data.map(inv => ({
              id: inv.id,
              // Use amount_paid if collected, otherwise amount_due (covers ACH delay, net terms)
              amount: inv.paid ? (inv.amount_paid || inv.amount_due) / 100 : inv.amount_due / 100,
              status: inv.status,
              paid: inv.paid,
              period_start: inv.period_start,
              period_end: inv.period_end,
              due_date: inv.due_date,
              created: inv.created,
            }));
          } catch(e) {
            cust.invoices = [];
          }
        }));
      }

      for (const cust of Object.values(custMap)) {
        allCustomers.push(cust);
      }
    })); // end Promise.all accounts

    await ensureBillingCols();
    const { rows: aumRelationships } = await pool.query(
      `SELECT id, name FROM relationships WHERE firm_id = $1 AND aum_billing_enabled = TRUE ORDER BY name`,
      [firmId]
    );
    for (const rel of aumRelationships) {
      const aum = await getAumBillingSummary(rel.id, firmId);
      if (!aum.enabled || !aum.configured || !aum.monthly_fee) continue;
      for (const line of (aum.lines || []).filter(l => l.configured && l.monthly_fee > 0)) {
        allCustomers.push({
          custId: `aum-${rel.id}-${line.id || line.person_id}`,
          email: line.person_name || '',
          name: line.label ? `${rel.name} — ${line.label}` : rel.name,
          account: 'IAS / AUM',
          source: 'aum',
          billing_day: 15,
          subscriptions: [{
            id: `aum-${rel.id}-${line.id || line.person_id}`,
            status: 'active',
            billing_cycle_anchor: Math.floor(new Date(forecastYear, 0, 15).getTime() / 1000),
            items: [{
              description: `${Number(line.annual_rate || 0).toFixed(2)}% AUM fee on $${Number(line.billable_aum || 0).toLocaleString()} billable assets`,
              amount: line.monthly_fee,
              interval: 'month',
              monthly_equiv: line.monthly_fee,
            }],
            monthly: line.monthly_fee,
          }],
          invoices: [],
          monthlyAmount: line.monthly_fee,
        });
      }
    }

    // Sort by monthly amount descending
    allCustomers.sort((a, b) => b.monthlyAmount - a.monthlyAmount);

    // Build monthly grid for the requested year
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth(); // 0-indexed

    const customers = allCustomers.map(cust => {
      const months = Array.from({ length: 12 }, (_, i) => {
        const monthStart = Math.floor(new Date(forecastYear, i, 1).getTime() / 1000);
        const monthEnd = Math.floor(new Date(forecastYear, i + 1, 1).getTime() / 1000);

        // Find invoice for this month — match by period_start (most reliable for Stripe subscriptions)
        const inv = (cust.invoices || []).find(inv =>
          inv.amount > 0 && (
            (inv.period_start >= monthStart && inv.period_start < monthEnd) ||
            ((!inv.period_start) && inv.created >= monthStart && inv.created < monthEnd)
          )
        );

        let status, amount;
        if (inv) {
          status = inv.paid ? 'paid' : (inv.status === 'open' ? 'past_due' : inv.status);
          amount = inv.amount;
        } else if (forecastYear > currentYear || (forecastYear === currentYear && i > currentMonth)) {
          // Future month — use projected amount if subscription is active
          const hasActiveSub = cust.subscriptions.some(s => s.status === 'active' || s.status === 'past_due');
          status = hasActiveSub ? 'upcoming' : 'none';
          amount = hasActiveSub ? cust.monthlyAmount : 0;
        } else if (forecastYear < currentYear) {
          status = 'none';
          amount = 0;
        } else {
          // Past month this year (or current month) with no invoice — could be annual billing, gap, or not yet invoiced
          // Only mark as upcoming if it's the current month AND the subscription billing date is in the future
          if (forecastYear === currentYear && i === currentMonth) {
            const today = now.getDate();
            const hasActiveSub = cust.subscriptions.some(s => s.status === 'active' || s.status === 'past_due');
            if (cust.source === 'aum') {
              // IAS/AUM fees bill on the 15th; keep them projected through the 15th and drop starting the 16th.
              status = hasActiveSub && today <= (cust.billing_day || 15) ? 'upcoming' : 'none';
              amount = status === 'upcoming' ? cust.monthlyAmount : 0;
            } else {
              const nextBillDate = cust.subscriptions.length > 0
                ? new Date((cust.subscriptions[0].billing_cycle_anchor || 0) * 1000).getDate()
                : 0;
              // Only upcoming if billing date is in the future this month (hasn't been invoiced yet)
              if (hasActiveSub && nextBillDate > today) {
                status = 'upcoming';
                amount = cust.monthlyAmount;
              } else {
                status = 'none';
                amount = 0;
              }
            }
          } else {
            status = 'none';
            amount = 0;
          }
        }

        return { status, amount: amount || 0 };
      });

      const collected = months.filter(m => m.status === 'paid').reduce((s, m) => s + m.amount, 0);
      const pastDue = months.filter(m => m.status === 'past_due').reduce((s, m) => s + m.amount, 0);
      const upcoming = months.filter(m => m.status === 'upcoming').reduce((s, m) => s + m.amount, 0);
      const annual = cust.monthlyAmount * 12;

      return {
        custId: cust.custId,
        email: cust.email,
        name: cust.name,
        account: cust.account,
        source: cust.source || 'stripe',
        billing_day: cust.billing_day || null,
        monthlyAmount: cust.monthlyAmount,
        annual,
        collected,
        pastDue,
        upcoming,
        months,
        subscriptions: cust.subscriptions,
      };
    }).filter(c => c.monthlyAmount > 0); // only customers with active subscriptions

    // Summary totals
    const totals = {
      annual: customers.reduce((s, c) => s + c.annual, 0),
      collected: customers.reduce((s, c) => s + c.collected, 0),
      pastDue: customers.reduce((s, c) => s + c.pastDue, 0),
      upcoming: customers.reduce((s, c) => s + c.upcoming, 0),
    };

    const monthly_totals = buildMonthlyTotals(customers, forecastYear);

    return {
      generated_at: now.toISOString(),
      year: forecastYear,
      customers,
      totals,
      monthly_totals,
      assumptions: {
        sources: ['stripe_active_subscriptions', 'stripe_past_due_subscriptions', 'aum_billing'],
        annual_definition: 'Current monthly recurring amount multiplied by 12.',
        projected_definition: 'Paid, past-due, or upcoming recurring revenue assigned to each month.',
        baseline_assumption: 'Current recurring amounts continue unchanged; churn, growth, cancellations, and AUM market movement are not modeled.',
        excludes: ['one_time_revenue', 'unsigned_proposals', 'non_recurring_qbo_revenue'],
      },
    };
}

module.exports = { buildMonthlyTotals, buildRevenueForecast };
