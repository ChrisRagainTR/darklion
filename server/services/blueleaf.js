'use strict';

const BASE_URL = 'https://secure.blueleaf.com';

// Per-household custodian migration configs can be stored on the person record.
const DEFAULT_MIGRATION_CONFIGS = {};

function migrationConfigForHousehold(householdId, personConfig) {
  if (personConfig?.migrations?.length) return personConfig;
  return DEFAULT_MIGRATION_CONFIGS[String(householdId)] || null;
}

// ── XML helpers ───────────────────────────────────────────────────────────────

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[1].trim());
  }
  return results;
}

function parseNumber(str) {
  const n = parseFloat((str || '').replace(/[$,]/g, ''));
  return isNaN(n) ? 0 : n;
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

async function blueleafGet(token, path) {
  const url = `${BASE_URL}${path}`;
  const auth = Buffer.from(`${token}:x`).toString('base64');
  const res = await fetch(url, {
    headers: {
      'Authorization': `Basic ${auth}`,
      'Accept': 'application/xml',
    },
  });
  if (!res.ok) {
    throw new Error(`Blueleaf API error: ${res.status} ${res.statusText} — ${path}`);
  }
  return res.text();
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchHouseholds(token) {
  const xml = await blueleafGet(token, '/api/v1/households.xml');
  const householdBlocks = extractAllTags(xml, 'household');
  return householdBlocks.map(block => ({
    id: extractTag(block, 'id'),
    email: extractTag(block, 'email'),
    fullName: extractTag(block, 'full-name'),
  }));
}

async function fetchHouseholdDetail(token, householdId) {
  const xml = await blueleafGet(token, `/api/v1/households/${householdId}.xml`);
  const householdBlock = extractTag(xml, 'household') || xml;

  const accountBlocks = extractAllTags(householdBlock, 'account');
  const accounts = accountBlocks.map(ab => {
    const holdingBlocks = extractAllTags(ab, 'holding');
    // account-type is a nested block — display-name may be self-closing (<display-name nil="true"/>)
    const accountTypeBlock = extractTag(ab, 'account-type');
    // Try display-name first (non-self-closing), fall back to name
    const rawDisplayName = extractTag(accountTypeBlock, 'display-name');
    const rawName = extractTag(accountTypeBlock, 'name');
    // Self-closing tags return empty string from extractTag — use name as fallback
    const accountTypeDisplay = (rawDisplayName && !rawDisplayName.includes('<') ? rawDisplayName : rawName) || '';
    // balance is a nested block: <balance><value>123.00</value><period>2025-01-01</period></balance>
    const balanceBlock = extractTag(ab, 'balance');
    const balanceValue = parseNumber(extractTag(balanceBlock, 'value')) || parseNumber(extractTag(ab, 'current-net-value'));
    return {
      id: extractTag(ab, 'id'),
      name: extractTag(ab, 'name'),
      institutionName: extractTag(ab, 'institution-name'),
      accountNumber: extractTag(ab, 'account-number'),
      accountType: accountTypeDisplay,
      currentNetValue: parseNumber(extractTag(ab, 'current-net-value')),
      balance: balanceValue,
      holdings: holdingBlocks.map(hb => ({
        id: extractTag(hb, 'id') || extractTag(hb, 'holding-id'),
        description: extractTag(hb, 'description'),
        ticker: extractTag(hb, 'ticker-name') || extractTag(hb, 'ticker'),
        companyName: extractTag(hb, 'company-name'),
        price: parseNumber(extractTag(hb, 'price')),
        value: parseNumber(extractTag(hb, 'value')),
        quantity: parseNumber(extractTag(hb, 'quantity')),
      })),
    };
  });

  return {
    id: extractTag(householdBlock, 'id') || householdId,
    fullName: extractTag(householdBlock, 'full-name'),
    email: extractTag(householdBlock, 'email'),
    accounts,
  };
}

function accountBalanceFromBlock(accountBlock) {
  const balanceBlock = extractTag(accountBlock, 'balance');
  return parseNumber(extractTag(balanceBlock, 'value')) || parseNumber(extractTag(accountBlock, 'current-net-value'));
}

function accountSummaryFromBlock(accountBlock) {
  const accountTypeBlock = extractTag(accountBlock, 'account-type');
  const rawDisplayName = extractTag(accountTypeBlock, 'display-name');
  const rawName = extractTag(accountTypeBlock, 'name');
  const accountType = (rawDisplayName && !rawDisplayName.includes('<') ? rawDisplayName : rawName) || '';
  return {
    id: extractTag(accountBlock, 'id'),
    name: extractTag(accountBlock, 'name'),
    institutionName: extractTag(accountBlock, 'institution-name'),
    accountNumber: extractTag(accountBlock, 'account-number'),
    accountType,
    balance: accountBalanceFromBlock(accountBlock),
  };
}

function isPerformanceEligibleAccount(account) {
  const type = String(account.accountType || '').toLowerCase();
  const name = String(account.name || '').toLowerCase();
  const balance = Number(account.balance || 0);

  // Blueleaf's performance report excludes accounts where performance is not
  // available (notably checking and debt/credit-card accounts). Matching that
  // population avoids dragging household returns down with bank/debt balances.
  if (balance < 0) return false;
  if (type.includes('checking') || name.includes('checking')) return false;
  if (type.includes('credit') || name.includes('credit card')) return false;
  if (type.includes('debt') || name.includes('debt')) return false;

  return true;
}

function excludedMigrationAccountsForDate(migrationConfig, date) {
  const exclude = new Set();
  const migrations = Array.isArray(migrationConfig?.migrations) ? migrationConfig.migrations : [];
  for (const migration of migrations) {
    const migrationDate = migration.migrationDate || migration.migration_date;
    if (!migrationDate) continue;
    const fromAccounts = Array.isArray(migration.fromAccounts || migration.from_accounts)
      ? (migration.fromAccounts || migration.from_accounts).map(String)
      : [];
    const toAccounts = Array.isArray(migration.toAccounts || migration.to_accounts)
      ? (migration.toAccounts || migration.to_accounts).map(String)
      : [];

    // Before the migration, count the old custodian side and suppress the new
    // custodian side if Blueleaf backfills duplicate history. On/after the
    // migration, count the new side and suppress the old side.
    const accountsToExclude = date < migrationDate ? toAccounts : fromAccounts;
    for (const accountId of accountsToExclude) exclude.add(accountId);
  }
  return exclude;
}

async function fetchHouseholdBalance(token, householdId, date, options = {}) {
  const path = `/api/v1/households/${householdId}.xml?date=${date}`;
  const xml = await blueleafGet(token, path);
  // Sum all account balances at the given date
  const householdBlock = extractTag(xml, 'household') || xml;
  const accountBlocks = extractAllTags(householdBlock, 'account');
  const excludeAccountIds = excludedMigrationAccountsForDate(options.migrationConfig, date);
  let total = 0;
  for (const ab of accountBlocks) {
    const account = accountSummaryFromBlock(ab);
    const accountId = account.id;
    if (excludeAccountIds.has(String(accountId))) continue;
    if (options.performanceOnly && !isPerformanceEligibleAccount(account)) continue;
    total += account.balance;
  }
  return total;
}

async function fetchHouseholdPerformanceAccounts(token, householdId, date, options = {}) {
  const path = `/api/v1/households/${householdId}.xml?date=${date}`;
  const xml = await blueleafGet(token, path);
  const householdBlock = extractTag(xml, 'household') || xml;
  const accountBlocks = extractAllTags(householdBlock, 'account');
  const excludeAccountIds = excludedMigrationAccountsForDate(options.migrationConfig, date);
  return accountBlocks
    .map(accountSummaryFromBlock)
    .filter(account => !excludeAccountIds.has(String(account.id)))
    .filter(isPerformanceEligibleAccount);
}

function parseTransactionBlocks(xml) {
  return extractAllTags(xml, 'transaction').map(block => ({
    id: extractTag(block, 'id'),
    accountId: extractTag(block, 'account-id'),
    period: extractTag(block, 'period') || (extractTag(block, 'transaction-date') || '').slice(0, 10),
    transactionDate: extractTag(block, 'transaction-date'),
    amount: parseNumber(extractTag(block, 'amount')),
    category: extractTag(block, 'transaction-category'),
    description: extractTag(block, 'description').replace(/\s+/g, ' ').trim(),
  }));
}

async function fetchHouseholdTransactions(token, householdId, options = {}) {
  const transactions = [];
  const minDate = options.minDate || null;

  // Blueleaf exposes transactions in paginated id/date order. There is no
  // documented date filter, but arbitrary page reads work, so for current-year
  // performance we walk backward from the newest page and stop once a page is
  // entirely before the earliest period we need.
  const firstXml = await blueleafGet(token, `/api/v1/households/${householdId}/transactions.xml?since_id=0&page=0`);
  const firstPageTransactions = parseTransactionBlocks(firstXml);
  const totalPages = parseInt(extractTag(firstXml, 'total_pages'), 10);

  if (!Number.isFinite(totalPages) || totalPages <= 1 || !minDate) {
    for (const txn of firstPageTransactions) transactions.push(txn);

    for (let page = 1; page < 1000; page++) {
      const xml = await blueleafGet(token, `/api/v1/households/${householdId}/transactions.xml?since_id=0&page=${page}`);
      const pageTransactions = parseTransactionBlocks(xml);
      if (!pageTransactions.length) break;
      transactions.push(...pageTransactions);

      const currentPage = parseInt(extractTag(xml, 'current_page'), 10);
      const pageTotal = parseInt(extractTag(xml, 'total_pages'), 10);
      if (Number.isFinite(pageTotal) && Number.isFinite(currentPage) && currentPage >= pageTotal - 1) break;
    }

    return transactions;
  }

  for (let page = totalPages - 1; page >= 0; page--) {
    const xml = page === 0
      ? firstXml
      : await blueleafGet(token, `/api/v1/households/${householdId}/transactions.xml?since_id=0&page=${page}`);
    const pageTransactions = parseTransactionBlocks(xml);
    if (!pageTransactions.length) continue;

    transactions.push(...pageTransactions.filter(txn => txn.period && txn.period >= minDate));

    const newestOnPage = pageTransactions
      .map(txn => txn.period)
      .filter(Boolean)
      .sort()
      .pop();
    if (newestOnPage && newestOnPage < minDate) break;
  }

  return transactions.sort((a, b) => (a.period || '').localeCompare(b.period || '') || String(a.id).localeCompare(String(b.id)));
}

function startOfQuarter(date) {
  const m = date.getMonth(); // 0-indexed
  const q = Math.floor(m / 3) * 3;
  return new Date(date.getFullYear(), q, 1);
}

function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

function isClientFlowTransaction(txn) {
  const category = (txn.category || '').toLowerCase();
  const description = txn.description || '';

  // Match Blueleaf performance: deposits, withdrawals, and transfer flows are
  // treated as net deposits/withdrawals. Internal journal pairs usually cancel
  // out naturally at the household level, while unpaired core-account transfers
  // are part of Blueleaf's displayed net flow.
  if (/for sec withhold/i.test(description)) return false;
  if (!description.trim() && Math.abs(txn.amount || 0) > 100000) return false;

  if (category === 'deposit') return true;
  if (category === 'withdrawal') return true;
  if (category === 'transfer') return true;

  // Fallback for occasional mapping oddities. Keep this intentionally narrow so
  // internal sweep trades like "BANK DEPOSIT PROGRAM" are not counted.
  if (/^(ach in|ach out|check in|check out)\b/i.test(description)) return true;

  return false;
}

function periodReturn({ startBalance, endBalance, startDate, endDate, transactions, eligibleAccountIds = null }) {
  if (!startBalance || startBalance === 0) return { returnValue: null, flowAdjustedReturn: null, simpleReturn: null };

  const clientFlows = transactions
    .filter(txn => txn.period >= startDate && txn.period <= endDate)
    .filter(txn => !eligibleAccountIds || eligibleAccountIds.has(String(txn.accountId)))
    .filter(isClientFlowTransaction);

  const deposits = clientFlows
    .filter(txn => txn.amount > 0)
    .reduce((sum, txn) => sum + txn.amount, 0);
  const withdrawals = clientFlows
    .filter(txn => txn.amount < 0)
    .reduce((sum, txn) => sum + Math.abs(txn.amount), 0);
  const netFlows = clientFlows.reduce((sum, txn) => sum + txn.amount, 0);
  const performanceGainLoss = endBalance - startBalance - netFlows;
  const simpleReturn = performanceGainLoss / startBalance;

  // Use a simple Modified Dietz denominator for a better one-period return when
  // flows occur mid-period. With no flows, this equals the simple return.
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const totalDays = Math.max(1, (end - start) / 86400000);
  const weightedFlows = clientFlows.reduce((sum, txn) => {
    const flowDate = new Date(`${txn.period}T00:00:00Z`);
    const weight = Math.max(0, Math.min(1, ((end - flowDate) / 86400000) / totalDays));
    return sum + txn.amount * weight;
  }, 0);
  const dietzDenominator = startBalance + weightedFlows;
  const flowAdjustedReturn = dietzDenominator ? performanceGainLoss / dietzDenominator : simpleReturn;

  return {
    // Top-level value stays intentionally simple per Chris: start/end balances
    // adjusted only for client deposits and withdrawals. Modified Dietz is kept
    // as audit detail, but not displayed by default.
    returnValue: simpleReturn,
    flowAdjustedReturn,
    simpleReturn,
    startBalance,
    endBalance,
    rawBalanceChange: endBalance - startBalance,
    deposits,
    withdrawals,
    netFlows,
    performanceGainLoss,
    clientFlowCount: clientFlows.length,
    clientFlows: clientFlows.map(txn => ({
      id: txn.id,
      accountId: txn.accountId,
      date: txn.period,
      category: txn.category,
      amount: txn.amount,
      description: txn.description,
    })),
  };
}

function balancesAreEffectivelyEqual(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) < 1;
}

async function findEffectiveStartDate(token, householdId, desiredStart, endDate, options = {}) {
  const endBalance = await fetchHouseholdBalance(token, householdId, endDate, { ...options, performanceOnly: true });
  const desiredBalance = await fetchHouseholdBalance(token, householdId, desiredStart, { ...options, performanceOnly: true });

  // If Blueleaf has a real distinct balance at the requested start, use it.
  // Some households return today's balance for early dates before performance
  // history begins; in that case, walk forward to the first available baseline.
  if (!balancesAreEffectivelyEqual(desiredBalance, endBalance)) {
    return { start: desiredStart, balance: desiredBalance, endBalance };
  }

  const start = new Date(`${desiredStart}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  let previous = desiredStart;

  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
    const date = toDateStr(d);
    const balance = await fetchHouseholdBalance(token, householdId, date, { ...options, performanceOnly: true });
    if (!balancesAreEffectivelyEqual(balance, endBalance)) {
      const prevDate = new Date(`${previous}T00:00:00Z`);
      for (let day = new Date(prevDate); day <= d; day.setUTCDate(day.getUTCDate() + 1)) {
        const dayStr = toDateStr(day);
        const dayBalance = await fetchHouseholdBalance(token, householdId, dayStr, { ...options, performanceOnly: true });
        if (!balancesAreEffectivelyEqual(dayBalance, endBalance)) {
          return { start: dayStr, balance: dayBalance, endBalance };
        }
      }
      return { start: date, balance, endBalance };
    }
    previous = date;
  }

  return { start: desiredStart, balance: desiredBalance, endBalance };
}

async function calculatePerformance(token, householdId, options = {}) {
  const migrationConfig = migrationConfigForHousehold(householdId, options.migrationConfig || null);
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const startOfQtr = startOfQuarter(now);

  // Last month: first day of previous month → first day of current month
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = startOfMonth;

  // Last quarter: start of previous quarter → start of current quarter
  const startOfLastQtr = new Date(startOfQtr);
  startOfLastQtr.setMonth(startOfLastQtr.getMonth() - 3);
  const endOfLastQtr = startOfQtr;

  const today = toDateStr(now);
  const periods = {
    mtd: { start: toDateStr(startOfMonth), end: today },
    qtd: { start: toDateStr(startOfQtr), end: today },
    ytd: { start: toDateStr(startOfYear), end: today },
    lastMonth: { start: toDateStr(startOfLastMonth), end: toDateStr(endOfLastMonth) },
    lastQuarter: { start: toDateStr(startOfLastQtr), end: toDateStr(endOfLastQtr) },
  };

  const performanceBalanceOptions = { migrationConfig, performanceOnly: true };
  const ytdEffective = await findEffectiveStartDate(token, householdId, periods.ytd.start, periods.ytd.end, performanceBalanceOptions);
  periods.ytd.requestedStart = periods.ytd.start;
  periods.ytd.start = ytdEffective.start;
  periods.ytd.effectiveStart = ytdEffective.start;

  const balanceDates = [...new Set(Object.values(periods).flatMap(p => [p.start, p.end]))];
  const earliestTransactionDate = Object.values(periods)
    .map(p => p.start)
    .sort()[0];
  const [transactions, balanceEntries, performanceAccounts] = await Promise.all([
    fetchHouseholdTransactions(token, householdId, { minDate: earliestTransactionDate }),
    Promise.all(balanceDates.map(async date => [date, await fetchHouseholdBalance(token, householdId, date, performanceBalanceOptions)])),
    fetchHouseholdPerformanceAccounts(token, householdId, today, { migrationConfig }),
  ]);
  const balances = Object.fromEntries(balanceEntries);
  const eligibleAccountIds = new Set(performanceAccounts.map(account => String(account.id)));

  const details = {};
  for (const [key, period] of Object.entries(periods)) {
    details[key] = periodReturn({
      startBalance: balances[period.start],
      endBalance: balances[period.end],
      startDate: period.start,
      endDate: period.end,
      transactions,
      eligibleAccountIds,
    });
    details[key].requestedStart = period.requestedStart || period.start;
    details[key].effectiveStart = period.effectiveStart || period.start;
  }

  return {
    mtd: details.mtd.returnValue,
    qtd: details.qtd.returnValue,
    ytd: details.ytd.returnValue,
    lastMonth: details.lastMonth.returnValue,
    lastQuarter: details.lastQuarter.returnValue,
    threeYear: null,
    method: 'flow_adjusted_simple',
    migrationConfigApplied: Boolean(migrationConfig?.migrations?.length),
    performanceAccountIds: [...eligibleAccountIds],
    periods,
    details,
  };
}

async function syncPerson(token, personId, householdId, firmId, pool) {
  const { rows: [personConfig] } = await pool.query(
    'SELECT blueleaf_migration_config FROM people WHERE id = $1 AND firm_id = $2',
    [personId, firmId]
  );
  const migrationConfig = migrationConfigForHousehold(householdId, personConfig?.blueleaf_migration_config || null);

  const [detail, performance] = await Promise.all([
    fetchHouseholdDetail(token, householdId),
    calculatePerformance(token, householdId, { migrationConfig }),
  ]);

  const rawBalance = detail.accounts.reduce((sum, a) => sum + (a.balance || a.currentNetValue || 0), 0);
  const today = toDateStr(new Date());

  const { rows } = await pool.query(
    `INSERT INTO blueleaf_snapshots
       (firm_id, person_id, blueleaf_household_id, snapshot_date, performance, accounts, raw_balance, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (person_id, snapshot_date)
     DO UPDATE SET
       performance = EXCLUDED.performance,
       accounts = EXCLUDED.accounts,
       raw_balance = EXCLUDED.raw_balance,
       synced_at = NOW()
     RETURNING *`,
    [firmId, personId, householdId, today, JSON.stringify(performance), JSON.stringify(detail.accounts), rawBalance]
  );

  return { ...rows[0], detail, performance };
}

module.exports = { fetchHouseholds, fetchHouseholdDetail, fetchHouseholdBalance, fetchHouseholdTransactions, fetchHouseholdPerformanceAccounts, calculatePerformance, syncPerson };
