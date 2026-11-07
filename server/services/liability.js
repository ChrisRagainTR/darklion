const { pool } = require('../db');
const { qbFetch } = require('./quickbooks');

// Scan all liability accounts for health issues
async function scanLiabilities(realmId) {
  // Use Classification = 'Liability' to catch ALL liability accounts regardless of
  // AccountType naming variations across QBO versions/regions
  const query = "SELECT * FROM Account WHERE Classification = 'Liability' MAXRESULTS 200";

  let data;
  try {
    data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);
  } catch (err) {
    // Surface clear errors for auth failures
    if (err.message && err.message.includes('401')) {
      const result = {
        error: 'QBO token expired — please reconnect your QuickBooks account',
        summary: { totalAccounts: 0, flaggedCount: 0, totalLiabilityBalance: 0 },
        flagged: [],
        checked: [],
      };
      return result;
    }
    throw err;
  }

  const accounts = data.QueryResponse?.Account || [];

  // Debug: log first raw account to help verify field names
  if (accounts.length > 0) {
    console.log(`[liability] QBO returned ${accounts.length} liability accounts for ${realmId}`);
    console.log(`[liability] Sample account fields:`, JSON.stringify(accounts[0], null, 2));
  } else {
    console.log(`[liability] No liability accounts returned from QBO for ${realmId}`);
  }

  if (accounts.length === 0) {
    const result = {
      message: 'No liability accounts found in QuickBooks. Make sure the company has Accounts Payable, Credit Card, or Liability accounts set up.',
      summary: { totalAccounts: 0, flaggedCount: 0, totalLiabilityBalance: 0 },
      flagged: [],
      checked: [],
    };
    // Still store the result
    const period = currentPeriod();
    await pool.query(`
      INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
      VALUES ($1, 'liability', $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [realmId, period, JSON.stringify(result), 0]);
    return result;
  }

  const checked = [];
  const flagged = [];

  for (const acct of accounts) {
    const rawBalance = Number(acct.CurrentBalance || acct.CurrentBalanceWithSubAccounts || 0);
    // QBO returns liability balances as negative numbers (credit-normal accounts).
    // Flip the sign so we work with the "balance sheet positive" convention:
    //   displayBalance > 0 = normal liability (company owes money)
    //   displayBalance < 0 = unusual debit balance (company is owed money / overpayment)
    const displayBalance = -rawBalance;
    const name = acct.FullyQualifiedName || acct.Name || '';
    const displayName = acct.Name || name;
    const subType = acct.AccountSubType || acct.AccountType || '';
    const accountType = acct.AccountType || '';

    const issues = [];

    // Check 1: Debit balance on a liability = unusual (means company is owed money / overpayment)
    if (displayBalance < 0) {
      issues.push({ type: 'negative_balance', message: `Debit balance: $${Math.abs(displayBalance).toLocaleString()} — unusual for a liability`, severity: 'warning' });
    }

    // Check 2: Zero balance on accounts that typically carry balances
    const expectsBalance = ['CreditCard', 'Credit Card', 'LongTermLiability', 'Long Term Liability'].includes(accountType) ||
                           ['CreditCard', 'LongTermLiability'].includes(subType);
    if (displayBalance === 0 && expectsBalance) {
      issues.push({ type: 'zero_balance', message: 'Zero balance — verify if expected', severity: 'info' });
    }

    // Check 3: Very large balance on credit cards (> $50k)
    if ((accountType === 'Credit Card' || accountType === 'CreditCard' || subType === 'CreditCard') && displayBalance > 50000) {
      issues.push({ type: 'high_balance', message: `High balance: $${displayBalance.toLocaleString()}`, severity: 'warning' });
    }

    // Check 4: Stale payroll liabilities (Other Current Liability with payroll-related name)
    if ((accountType === 'Other Current Liability' || accountType === 'OtherCurrentLiability') && displayBalance > 0) {
      const isPayroll = /payroll|tax|withhold|fica|futa|suta|401k|health\s*ins/i.test(name);
      if (isPayroll) {
        issues.push({ type: 'payroll_liability', message: `Payroll liability balance: $${displayBalance.toLocaleString()} — verify cleared`, severity: 'warning' });
      }
    }

    const balance = displayBalance; // use corrected sign from here on

    const entry = {
      name: name,           // FullyQualifiedName — matches QBO UI
      displayName,          // Short name
      id: acct.Id,
      accountType,
      subType,
      balance,
      active: acct.Active !== false,
      issues,
    };

    checked.push(entry);
    if (issues.filter(i => i.severity !== 'info').length > 0) {
      flagged.push(entry);
    }
  }

  // Sort flagged by severity then absolute balance
  flagged.sort((a, b) => {
    const aWarn = a.issues.some(i => i.severity === 'warning') ? 1 : 0;
    const bWarn = b.issues.some(i => i.severity === 'warning') ? 1 : 0;
    if (aWarn !== bWarn) return bWarn - aWarn;
    return Math.abs(b.balance) - Math.abs(a.balance);
  });

  const result = {
    summary: {
      totalAccounts: checked.length,
      flaggedCount: flagged.length,
      totalLiabilityBalance: checked.reduce((sum, c) => sum + c.balance, 0),
    },
    flagged,
    checked,
  };

  // Store scan result
  const period = currentPeriod();
  await pool.query(`
    INSERT INTO scan_results (realm_id, scan_type, period, result_data, flag_count)
    VALUES ($1, 'liability', $2, $3, $4)
  `, [realmId, period, JSON.stringify(result), flagged.length]);

  return result;
}

function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

module.exports = { scanLiabilities };
