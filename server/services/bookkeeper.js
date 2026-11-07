'use strict';
const { completeText } = require('./managedInference');

/**
 * bookkeeper.js — Self-Learning Auto-Bookkeeper Service
 *
 * Nightly service that:
 * 1. Pulls uncategorized transactions from QBO
 * 2. Matches against vendor_mapping (self-built + manual)
 * 3. Uses AI research for unknowns (Claude Haiku)
 * 4. Auto-codes ≥80% confidence, flags rest for manager review
 * 5. Rebuilds vendor mapping from 24-month QBO history
 */

const { pool } = require('../db');
const { getChartOfAccounts, qbFetch, writeBackTransaction } = require('./quickbooks');

const QBO_QUERY_PAGE_SIZE = 1000;

// ═══════════════════════════════════════════════════════════════
// VENDOR NAME NORMALIZATION
// ═══════════════════════════════════════════════════════════════

const STRIP_SUFFIXES = /\b(llc|inc|corp|co|ltd|llp|lp|pllc|pc|pa|incorporated|corporation|company|limited)\b\.?/gi;
const ACH_NOISE_PATTERNS = [
  /ORIG CO NAME:/gi,
  /ORIG ID:[^\s]+/gi,
  /DESC DATE:[^\s]*/gi,
  /PPD ID:[^\s]+/gi,
  /CCD ID:[^\s]+/gi,
  /ID:[^\s]+/gi,
  /TRACE#[^\s]*/gi,
  /TRACE [^\s]*/gi,
  /PAYMENT/gi,
  /TRANSFER/gi,
  /COMMISSION/gi,
  /COMM/gi,
  /AF\d+/gi,
];

function cleanVendorDescriptor(name) {
  if (!name) return '';

  let cleaned = String(name);
  for (const pattern of ACH_NOISE_PATTERNS) cleaned = cleaned.replace(pattern, ' ');

  return cleaned
    .replace(/[_*#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,:;\-\/\s]+$/, '');
}

function normalizeVendorName(name) {
  if (!name) return '';
  return cleanVendorDescriptor(name)
    .toLowerCase()
    .replace(STRIP_SUFFIXES, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,]+$/, '');
}

function buildVendorCandidates(name) {
  const raw = String(name || '').trim();
  const cleaned = cleanVendorDescriptor(raw);
  const variants = [raw, cleaned]
    .map(v => v.trim())
    .filter(Boolean);

  const unique = [];
  const seen = new Set();
  for (const v of variants) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(v);
  }
  return unique;
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════

async function runBookkeeper(realmId, firmId) {
  const runId = await createRunRecord(realmId, firmId);
  console.log(`[bookkeeper] Starting run ${runId} for realm ${realmId}`);

  try {
    // Get company name for report
    const { rows: companyRows } = await pool.query(
      'SELECT company_name FROM companies WHERE realm_id = $1 LIMIT 1',
      [realmId]
    );
    const companyName = companyRows[0]?.company_name || '';

    // Step 1: Get chart of accounts (needed for AI research prompt)
    const chartOfAccounts = await getChartOfAccounts(realmId);

    // Step 2: Rebuild vendor mapping from 24-month history FIRST
    // This ensures historical coding patterns are available before AI is called
    // Manual mappings are protected and will never be overwritten
    console.log(`[bookkeeper] Rebuilding vendor mapping before processing...`);
    await rebuildVendorMapping(realmId, firmId);

    // Step 3: Pull uncategorized transactions from QBO
    const uncategorizedTxns = await fetchUncategorizedTransactions(realmId, chartOfAccounts);
    console.log(`[bookkeeper] Found ${uncategorizedTxns.length} uncategorized transactions for ${companyName || realmId}`);

    if (!uncategorizedTxns.length) {
      await completeRun(runId, { txns_found: 0 });
      return { success: true, txns_found: 0, runId };
    }

    // Step 3: Build set of txn_qb_ids that were already sent to client.
    // Those should stay locked, but plain pending items should be eligible for re-evaluation on rerun.
    const { rows: sentToClientRows } = await pool.query(
      `SELECT DISTINCT txn_qb_id FROM bookkeeper_uncoded
       WHERE realm_id = $1 AND sent_to_client = TRUE`,
      [realmId]
    );
    const sentToClientIds = new Set(sentToClientRows.map(r => r.txn_qb_id));

    // Step 4: Process each transaction
    let autoCoded = 0, aiCoded = 0, needsReview = 0, failed = 0, newMappings = 0;

    for (const txn of uncategorizedTxns) {
      if (sentToClientIds.has(txn.Id)) {
        console.log(`[bookkeeper] Skipping txn ${txn.Id} — already sent to client`);
        needsReview++;
        continue;
      }

      await pool.query(
        `DELETE FROM bookkeeper_uncoded
         WHERE realm_id = $1 AND txn_qb_id = $2 AND status = 'pending' AND sent_to_client = FALSE`,
        [realmId, txn.Id]
      );
      try {
        const result = await processTransaction(realmId, firmId, runId, txn, chartOfAccounts, companyName);
        if (result.action === 'auto-mapped') autoCoded++;
        else if (result.action === 'ai-coded') { aiCoded++; newMappings++; }
        else if (result.action === 'needs-review') needsReview++;
      } catch (err) {
        console.warn(`[bookkeeper] Failed to process txn ${txn.Id}: ${err.message}`);
        failed++;
      }
    }

    await completeRun(runId, {
      txns_found: uncategorizedTxns.length,
      txns_auto_coded: autoCoded,
      txns_ai_coded: aiCoded,
      txns_manual_review: needsReview,
      txns_failed: failed,
      new_mappings_created: newMappings,
    });

    console.log(`[bookkeeper] Run ${runId} complete: found=${uncategorizedTxns.length} auto=${autoCoded} ai=${aiCoded} review=${needsReview} failed=${failed}`);

    return {
      success: true,
      runId,
      txns_found: uncategorizedTxns.length,
      txns_auto_coded: autoCoded,
      txns_ai_coded: aiCoded,
      txns_manual_review: needsReview,
      txns_failed: failed,
      new_mappings_created: newMappings,
    };
  } catch (err) {
    console.error(`[bookkeeper] Run ${runId} failed: ${err.message}`);
    await failRun(runId, err.message);
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════
// FETCH UNCATEGORIZED TRANSACTIONS FROM QBO
// ═══════════════════════════════════════════════════════════════

async function fetchUncategorizedTransactions(realmId, chartOfAccounts) {
  // Find uncategorized accounts
  const uncategorizedAccts = chartOfAccounts.filter(a => {
    const name = (a.Name || '').toLowerCase();
    const fqn = (a.FullyQualifiedName || '').toLowerCase();
    return name.includes('uncategorized') || fqn.includes('uncategorized') ||
           name === 'ask my accountant' || fqn === 'ask my accountant';
  });

  if (!uncategorizedAccts.length) {
    console.log('[bookkeeper] No uncategorized accounts found in chart of accounts');
    return [];
  }

  const allTxns = [];
  const sinceDate = daysAgo(90); // Look back 90 days
  const today = new Date().toISOString().split('T')[0];

  // Use the GeneralLedger report API — supports filtering by account ID directly.
  // One API call per uncategorized account gives us exactly the transactions we need.
  for (const acct of uncategorizedAccts) {
    try {
      // Include debt_amt and credit_amt columns for accurate amounts
      const params = `start_date=${sinceDate}&end_date=${today}&account=${acct.Id}&columns=tx_date,txn_type,doc_num,memo,vend_name,debt_amt,credit_amt&minorversion=75`;
      const data = await qbFetch(realmId, `/reports/GeneralLedger?${params}`);

      // Check if report has data
      const noData = data.Header?.Option?.find(o => o.Name === 'NoReportData')?.Value;
      if (noData === 'true') {
        console.log(`[bookkeeper] No transactions in ${acct.Name} (acct ${acct.Id})`);
        continue;
      }

      // Parse report rows — Section > Rows > Row (type=Data)
      const sections = data.Rows?.Row || [];
      for (const section of sections) {
        const txnRows = section.Rows?.Row || [];
        for (const row of txnRows) {
          if (row.type !== 'Data') continue;
          const cols = row.ColData || [];
          const txnDate = cols[0]?.value || '';
          const txnType = cols[1]?.value || 'Expense';
          const txnId = cols[1]?.id || '';      // QBO transaction ID
          const docNum = cols[2]?.value || '';
          const vendorName = cols[3]?.value || '';
          const memo = cols[4]?.value || '';
          // Amount: debt_amt is col 5, credit_amt is col 6 (0-indexed)
          const debtStr = cols[5]?.value || '0';
          const creditStr = cols[6]?.value || '0';
          const debt = parseFloat(debtStr.replace(/[,$]/g, '')) || 0;
          const credit = parseFloat(creditStr.replace(/[,$]/g, '')) || 0;
          const amount = Math.abs(debt || credit);

          // Skip empty/summary rows and zero-amount transactions
          if (!txnDate || !txnId) continue;
          if (amount === 0) {
            console.log(`[bookkeeper] Skipping zero-amount txn ${txnId} (${vendorName}) - likely column mismatch`);
            continue;
          }

          allTxns.push({
            Id: txnId,
            TxnDate: txnDate,
            TotalAmt: Math.abs(amount),
            EntityRef: vendorName ? { name: vendorName } : null,
            PrivateNote: memo,
            DocNum: docNum,
            _txnType: txnType,
            _accountName: acct.Name,
            _accountId: acct.Id,
            _realmId: realmId,
          });
        }
      }
      console.log(`[bookkeeper] Found ${allTxns.length} transactions in ${acct.Name}`);
    } catch (e) {
      console.warn(`[bookkeeper] GeneralLedger query failed for ${acct.Name}: ${e.message}`);
    }
  }

  // De-duplicate by QBO ID + type (same txn might appear in multiple queries)
  const seen = new Set();
  return allTxns.filter(t => {
    const key = `${t.Id}-${t._txnType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ═══════════════════════════════════════════════════════════════
// PROCESS A SINGLE TRANSACTION
// ═══════════════════════════════════════════════════════════════

async function processTransaction(realmId, firmId, runId, txn, chartOfAccounts, companyName) {
  const vendorName = extractVendorName(txn);
  const vendorCandidates = buildVendorCandidates(vendorName);
  const amount = txn.TotalAmt || 0;
  const description = txn.PrivateNote || txn.Line?.[0]?.Description || '';
  const txnType = txn._txnType || 'Purchase';
  const txnDate = txn.TxnDate || '';

  // Check if vendor is just a check number (can't map these)
  if (vendorName.match(/^check\s*#?\s*\d+$/i) || vendorName.match(/^\d{3,5}$/) || vendorName.toLowerCase() === 'unknown vendor') {
    await recordUncodedTransaction(firmId, realmId, companyName, runId, txn, { account_name: '', confidence: 0, reasoning: 'No vendor identified (check number only)' });
    console.log(`[bookkeeper] → uncoded (check#): ${txn.DocNum || txn.Id}`);
    return { action: 'needs-review' };
  }



  const direction = detectDirection(txn);

  // Step 1: Check vendor_mapping for match (direction-aware)
  const mapping = await findVendorMapping(realmId, vendorCandidates, direction);

  if (mapping) {
    if (!isDirectionCompatible(mapping.account_name, direction, txnType)) {
      await recordUncodedTransaction(firmId, realmId, companyName, runId, txn, {
        account_name: mapping.account_name,
        confidence: Math.min(mapping.confidence || 0, 40),
        reasoning: `Mapped account conflicts with detected transaction direction (${direction})`
      });
      console.log(`[bookkeeper] → uncoded (direction mismatch mapping): ${vendorName} → ${mapping.account_name}`);
      return { action: 'needs-review' };
    }
    // Step 1.5: Check amount range guard rail
    if (mapping.min_amount !== null && mapping.max_amount !== null) {
      const minAllowed = Number(mapping.min_amount) * 0.8; // 20% below min
      const maxAllowed = Number(mapping.max_amount) * 1.2; // 20% above max
      if (amount < minAllowed || amount > maxAllowed) {
        await recordUncodedTransaction(firmId, realmId, companyName, runId, txn, {
          account_name: mapping.account_name,
          confidence: Math.min(mapping.confidence || 0, 40),
          reasoning: `Amount $${amount.toLocaleString()} outside typical range $${Number(mapping.min_amount).toLocaleString()}-$${Number(mapping.max_amount).toLocaleString()} (±20%)`
        });
        console.log(`[bookkeeper] → uncoded (amount outlier): ${vendorName} $${amount}`);
        return { action: 'needs-review' };
      }
    }

    // Amount is within range → auto-code
    // Auto-code using existing mapping
    try {
      await writeBackTransaction(realmId, txn.Id, mapping.account_name, txnType, {
        originalAccount: txn._accountName || '',
      });
      // Determine coded_by value: use source type for tracking
      const codedBy = mapping.source === 'opposite-direction-fallback' ? 'opp-dir-fallback' : 'auto';
      await recordCodedTransaction(realmId, firmId, runId, txn, mapping.account_name, codedBy, mapping.confidence);
      await incrementMappingUsage(mapping.id);
      console.log(`[bookkeeper] Auto-coded: ${vendorName} → ${mapping.account_name} (${mapping.source} ${mapping.confidence}%)`);
      return { action: 'auto-mapped' };
    } catch (err) {
      console.warn(`[bookkeeper] Auto-code write-back failed for ${vendorName}: ${err.message}`);
      // Fall through to add to uncoded report
    }
  }

  // Step 2: No mapping or write-back failed → AI research
  const aiResult = await researchVendor(vendorName, description, amount, txnType, chartOfAccounts, firmId);

  if (aiResult.confidence >= 80) {
    if (!isDirectionCompatible(aiResult.account_name, direction, txnType)) {
      await recordUncodedTransaction(firmId, realmId, companyName, runId, txn, {
        ...aiResult,
        confidence: Math.min(aiResult.confidence || 0, 40),
        reasoning: `Suggested account conflicts with detected transaction direction (${direction})`
      });
      console.log(`[bookkeeper] → uncoded (direction mismatch ai): ${vendorName} → ${aiResult.account_name}`);
      return { action: 'needs-review' };
    }
    // AI is confident enough → auto-code
    try {
      await writeBackTransaction(realmId, txn.Id, aiResult.account_name, txnType, {
        originalAccount: txn._accountName || '',
      });

      // Find QBO account ID for the mapping
      const matchedAcct = chartOfAccounts.find(a => a.Name === aiResult.account_name);
      const accountId = matchedAcct?.Id || '';

      // Save as AI-researched mapping
      await upsertVendorMapping(realmId, firmId, vendorName, aiResult.account_name, accountId, 'ai-research', aiResult.confidence, direction);
      await recordCodedTransaction(realmId, firmId, runId, txn, aiResult.account_name, 'ai-research', aiResult.confidence);
      console.log(`[bookkeeper] AI-coded: ${vendorName} → ${aiResult.account_name} (${aiResult.confidence}%)`);
      return { action: 'ai-coded' };
    } catch (err) {
      console.warn(`[bookkeeper] AI code write-back failed for ${vendorName}: ${err.message}`);
      // Fall through to uncoded report
    }
  }

  // Step 3: Low confidence or write-back failed → daily uncoded report
  await recordUncodedTransaction(firmId, realmId, companyName, runId, txn, aiResult);
  console.log(`[bookkeeper] Needs review: ${vendorName} — AI suggested ${aiResult.account_name} (${aiResult.confidence}%)`);
  return { action: 'needs-review' };
}

// ═══════════════════════════════════════════════════════════════
// EXTRACT VENDOR NAME FROM QBO TRANSACTION
// ═══════════════════════════════════════════════════════════════

function extractVendorName(txn) {
  // EntityRef is the primary vendor reference
  if (txn.EntityRef?.name) return txn.EntityRef.name;

  // For deposits, check line-level entity refs
  if (txn.Line) {
    for (const line of txn.Line) {
      if (line.DepositLineDetail?.Entity?.name) return line.DepositLineDetail.Entity.name;
    }
  }

  // Fall back to memo/description
  if (txn.PrivateNote) return txn.PrivateNote.substring(0, 60);
  if (txn.Line?.[0]?.Description) return txn.Line[0].Description.substring(0, 60);

  return 'Unknown Vendor';
}

// ═══════════════════════════════════════════════════════════════
// VENDOR MAPPING LOOKUP (exact + fuzzy)
// ═══════════════════════════════════════════════════════════════

async function findVendorMapping(realmId, vendorCandidates, direction) {
  direction = direction || 'expense';
  const candidates = Array.isArray(vendorCandidates) ? vendorCandidates.filter(Boolean) : [vendorCandidates].filter(Boolean);
  const normalizedCandidates = [...new Set(candidates.map(normalizeVendorName).filter(Boolean))];

  for (const vendorName of candidates) {
    const { rows: exact } = await pool.query(
      'SELECT * FROM vendor_mapping WHERE realm_id = $1 AND vendor_name = $2 AND direction = $3 ORDER BY confidence DESC, usage_count DESC NULLS LAST LIMIT 1',
      [realmId, vendorName, direction]
    );
    if (exact.length) return exact[0];
  }

  for (const normalizedVendor of normalizedCandidates) {
    const { rows: normalized } = await pool.query(
      'SELECT * FROM vendor_mapping WHERE realm_id = $1 AND vendor_name_normalized = $2 AND direction = $3 ORDER BY confidence DESC, usage_count DESC NULLS LAST LIMIT 1',
      [realmId, normalizedVendor, direction]
    );
    if (normalized.length) return normalized[0];
  }

  return null;
}

// Determine if a transaction is income (money in) or expense (money out)
// Do NOT trust the uncategorized bucket name for semantic meaning.
// In this system, Uncategorized Income / Expense are just feed catch buckets.
function detectDirection(txn) {
  const txnType = (txn._txnType || '').toLowerCase();
  const accountName = (txn._accountName || '').toLowerCase();

  // True money-in transaction types
  if (['deposit', 'salesreceipt', 'sales receipt', 'invoice', 'payment', 'receivepayment', 'receive payment'].includes(txnType)) {
    return 'income';
  }

  // Credit card credits reduce card balances or reverse prior charges.
  // Treat them as expense-side / contra-expense direction, never normal income.
  if (['credit card credit', 'creditcardcredit'].includes(txnType)) {
    return 'expense';
  }

  // True money-out transaction types
  if (['expense', 'purchase', 'credit card charge', 'creditcardcharge', 'credit card expense', 'creditcardexpense', 'check', 'bill', 'bill payment', 'billpaymentcheck', 'cashpurchase', 'cashexpense'].includes(txnType)) {
    return 'expense';
  }

  // Only use account names when they are real business accounts, not the uncategorized feed buckets.
  if (accountName && !accountName.includes('uncategorized')) {
    if (accountName.includes('income')) return 'income';
    if (accountName.includes('expense') || accountName.includes('cost of goods sold')) return 'expense';
  }

  // Safe fallback: default to expense unless we have a strong money-in signal.
  return 'expense';
}

function isDirectionCompatible(accountName, direction, txnType) {
  const name = String(accountName || '').toLowerCase();
  const txnTypeNorm = String(txnType || '').toLowerCase();
  if (!name) return true;

  const looksIncome = name.includes('income') || name.includes('revenue') || name.includes('sales');
  const looksExpense = name.includes('expense') || name.includes('bank charges') || name.includes('meals') || name.includes('advertising') || name.includes('supplies') || name.includes('owner\'s pay') || name.includes('personal expenses') || name.includes('distribution') || name.includes('cost of goods sold');

  if (txnTypeNorm === 'credit card credit' || txnTypeNorm === 'creditcardcredit') {
    // Credit card credits should not auto-post into normal expense buckets.
    // They need explicit human review unless we later add a safer contra-expense rule.
    if (looksExpense) return false;
  }

  if (direction === 'expense' && looksIncome) return false;
  if (direction === 'income' && looksExpense) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════
// AI RESEARCH — CLASSIFY UNKNOWN VENDOR
// ═══════════════════════════════════════════════════════════════

async function researchVendor(vendorName, description, amount, txnType, chartOfAccounts, firmId) {
  // Build account list from actual CoA (expense + income accounts only)
  const relevantTypes = ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Income', 'Other Income'];
  const accountNames = chartOfAccounts
    .filter(a => relevantTypes.includes(a.AccountType))
    .map(a => a.Name)
    .filter(Boolean);

  if (!accountNames.length) {
    return { account_name: '', confidence: 0, reasoning: 'No expense/income accounts found in chart of accounts' };
  }

  const isIncome = txnType === 'Deposit' || txnType === 'SalesReceipt' || txnType === 'Invoice';

  const prompt = `You are a CPA bookkeeping assistant classifying a business transaction into a QuickBooks GL account.

VENDOR: ${vendorName}
TRANSACTION TYPE: ${txnType}
AMOUNT: $${Number(amount).toFixed(2)}
MEMO/DESCRIPTION: ${description || '(none)'}
DIRECTION: ${isIncome ? 'INCOME (money received)' : 'EXPENSE (money paid out)'}

This client's Chart of Accounts includes these ${isIncome ? 'income' : 'expense'} accounts:
${accountNames.join('\n')}

Instructions:
1. Identify what kind of business "${vendorName}" is
2. Match to the EXACT account name from the list above (must be a verbatim match)
3. Rate your confidence 0-100 based on how certain you are

Return ONLY valid JSON, no other text:
{"account_name":"exact account name from list","confidence":85,"reasoning":"one sentence why"}`;

  try {
    const text = (await completeText({firmId,feature:'bookkeeping-classification',prompt,maxTokens:200})).trim();

    // Parse JSON from response (handle markdown code blocks)
    let jsonStr = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonStr = jsonMatch[0];

    const parsed = JSON.parse(jsonStr);

    // Validate that the suggested account actually exists in the CoA
    const accountExists = accountNames.some(a => a.toLowerCase() === (parsed.account_name || '').toLowerCase());
    if (!accountExists && parsed.confidence > 0) {
      // AI suggested a non-existent account — reduce confidence
      parsed.confidence = Math.min(parsed.confidence, 40);
      parsed.reasoning = `(AI suggested "${parsed.account_name}" which is not in the chart of accounts) ${parsed.reasoning || ''}`;
    }

    return {
      account_name: parsed.account_name || '',
      confidence: Math.max(0, Math.min(100, parseInt(parsed.confidence) || 0)),
      reasoning: parsed.reasoning || '',
    };
  } catch (err) {
    console.warn(`[bookkeeper] AI research failed for "${vendorName}": ${err.message}`);
    return { account_name: '', confidence: 0, reasoning: `AI error: ${err.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// REBUILD VENDOR MAPPING FROM 24-MONTH QBO HISTORY
// ═══════════════════════════════════════════════════════════════

async function fetchAllQboQueryRows(realmId, entityName, dateStr) {
  const allRows = [];
  let startPosition = 1;

  while (true) {
    const query = `SELECT * FROM ${entityName} WHERE TxnDate >= '${dateStr}' STARTPOSITION ${startPosition} MAXRESULTS ${QBO_QUERY_PAGE_SIZE}`;
    const data = await qbFetch(realmId, `/query?query=${encodeURIComponent(query)}`);
    const rows = data.QueryResponse?.[entityName] || [];
    allRows.push(...rows);

    if (rows.length < QBO_QUERY_PAGE_SIZE) break;
    startPosition += QBO_QUERY_PAGE_SIZE;
  }

  return allRows;
}

async function rebuildVendorMapping(realmId, firmId) {
  console.log(`[bookkeeper] Rebuilding vendor mapping from 24-month history for realm ${realmId}`);

  const twoYearsAgo = new Date();
  twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
  const dateStr = twoYearsAgo.toISOString().split('T')[0];

  // Get chart of accounts to identify uncategorized accounts
  let chartOfAccounts;
  try {
    chartOfAccounts = await getChartOfAccounts(realmId);
  } catch (e) {
    console.warn(`[bookkeeper] CoA query failed during rebuild: ${e.message}`);
    return 0;
  }

  const uncategorizedIds = new Set(
    chartOfAccounts
      .filter(a => {
        const name = (a.Name || '').toLowerCase();
        return name.includes('uncategorized') || name === 'ask my accountant';
      })
      .map(a => a.Id)
  );

  // Skip vendors that are just check numbers
  const isCheckVendor = name => name.match(/^check\s*#?\s*\d+$/i) || name.match(/^\d{3,5}$/) || !name;

  // ── EXPENSE SIDE: Pull all Purchases from last 24 months ──
  // vendorAccounts[direction][vendor][accountName] = { count, id }
  const vendorAccounts = { expense: {}, income: {} };
  // Track all amounts per vendor for min/max calculation
  const allAmounts = { expense: {}, income: {} };

  try {
    const purchases = await fetchAllQboQueryRows(realmId, 'Purchase', dateStr);
    for (const p of purchases) {
      const vendor = p.EntityRef?.name;
      if (!vendor || isCheckVendor(vendor)) continue;
      for (const line of (p.Line || [])) {
        const acctRef = line.AccountBasedExpenseLineDetail?.AccountRef;
        if (!acctRef?.name || !acctRef?.value) continue;
        if (uncategorizedIds.has(acctRef.value)) continue;
        if (!vendorAccounts.expense[vendor]) {
          vendorAccounts.expense[vendor] = {};
          allAmounts.expense[vendor] = [];
        }
        if (!vendorAccounts.expense[vendor][acctRef.name]) {
          vendorAccounts.expense[vendor][acctRef.name] = { count: 0, id: acctRef.value };
        }
        vendorAccounts.expense[vendor][acctRef.name].count++;
        if (p.TotalAmt) allAmounts.expense[vendor].push(Number(p.TotalAmt));
      }
    }
    console.log(`[bookkeeper] Expense history: ${purchases.length} purchases scanned`);
  } catch (e) {
    console.warn(`[bookkeeper] Purchase history query failed: ${e.message}`);
  }

  // ── INCOME SIDE: Pull Deposits from last 24 months ──
  try {
    const deposits = await fetchAllQboQueryRows(realmId, 'Deposit', dateStr);
    for (const d of deposits) {
      for (const line of (d.Line || [])) {
        const entity = line.DepositLineDetail?.Entity;
        const acctRef = line.DepositLineDetail?.AccountRef;
        const vendor = entity?.name || d.EntityRef?.name;
        if (!vendor || isCheckVendor(vendor) || !acctRef?.name || !acctRef?.value) continue;
        if (uncategorizedIds.has(acctRef.value)) continue;
        if (!vendorAccounts.income[vendor]) {
          vendorAccounts.income[vendor] = {};
          allAmounts.income[vendor] = [];
        }
        if (!vendorAccounts.income[vendor][acctRef.name]) {
          vendorAccounts.income[vendor][acctRef.name] = { count: 0, id: acctRef.value };
        }
        vendorAccounts.income[vendor][acctRef.name].count++;
        if (d.TotalAmt) allAmounts.income[vendor].push(Number(d.TotalAmt));
      }
    }
    console.log(`[bookkeeper] Income history: ${deposits.length} deposits scanned`);
  } catch (e) {
    console.warn(`[bookkeeper] Deposit history query failed: ${e.message}`);
  }

  // ── INCOME SIDE: Pull SalesReceipts from last 24 months ──
  try {
    const receipts = await fetchAllQboQueryRows(realmId, 'SalesReceipt', dateStr);
    for (const sr of receipts) {
      const vendor = sr.CustomerRef?.name || sr.EntityRef?.name;
      if (!vendor || isCheckVendor(vendor)) continue;
      for (const line of (sr.Line || [])) {
        const acctRef = line.SalesItemLineDetail?.ItemAccountRef;
        if (!acctRef?.name || !acctRef?.value) continue;
        if (uncategorizedIds.has(acctRef.value)) continue;
        if (!vendorAccounts.income[vendor]) {
          vendorAccounts.income[vendor] = {};
          allAmounts.income[vendor] = allAmounts.income[vendor] || [];
        }
        if (!vendorAccounts.income[vendor][acctRef.name]) {
          vendorAccounts.income[vendor][acctRef.name] = { count: 0, id: acctRef.value };
        }
        vendorAccounts.income[vendor][acctRef.name].count++;
        if (sr.TotalAmt) allAmounts.income[vendor].push(Number(sr.TotalAmt));
      }
    }
  } catch (e) {
    console.warn(`[bookkeeper] SalesReceipt history query failed: ${e.message}`);
  }

  // ── Create/update mappings for vendors with clear patterns ──
  let created = 0;
  for (const direction of ['expense', 'income']) {
    for (const [vendor, accounts] of Object.entries(vendorAccounts[direction])) {
      const entries = Object.entries(accounts);
      const totalTxns = entries.reduce((sum, [, v]) => sum + v.count, 0);
      if (totalTxns < 1) continue;

      entries.sort((a, b) => b[1].count - a[1].count);
      const [topAccountName, topData] = entries[0];
      const dominance = topData.count / totalTxns;

      if (dominance >= 0.5) {
        const confidence = Math.round(dominance * 100);
        // Calculate min/max from all transactions for this vendor
        const amounts = allAmounts[direction][vendor] || [];
        if (amounts.length >= 2) {
          amounts.sort((a, b) => a - b);
          // Use 5th and 95th percentile to exclude outliers
          const minIdx = Math.floor(amounts.length * 0.05);
          const maxIdx = Math.floor(amounts.length * 0.95);
          const minAmount = amounts[Math.max(0, minIdx)];
          const maxAmount = amounts[Math.min(amounts.length - 1, maxIdx)];

          const wasCreated = await upsertVendorMapping(
            realmId, firmId, vendor, topAccountName, topData.id, 'auto-learned', confidence, direction, minAmount, maxAmount
          );
          if (wasCreated) created++;
        } else {
          const wasCreated = await upsertVendorMapping(
            realmId, firmId, vendor, topAccountName, topData.id, 'auto-learned', confidence, direction, null, null
          );
          if (wasCreated) created++;
        }
      }
    }
  }

  const totalTxns = Object.values(vendorAccounts.expense).reduce((s,v) => s + Object.values(v).reduce((s2,d) => s2+d.count, 0), 0)
    + Object.values(vendorAccounts.income).reduce((s,v) => s + Object.values(v).reduce((s2,d) => s2+d.count, 0), 0);
  console.log(`[bookkeeper] Mapping rebuild complete: ${created} new/updated mappings from ${totalTxns} historical transactions (expense + income)`);
  return created;
}

// ═══════════════════════════════════════════════════════════════
// DATABASE HELPERS
// ═══════════════════════════════════════════════════════════════

async function upsertVendorMapping(realmId, firmId, vendorName, accountName, accountId, source, confidence, direction, minAmount, maxAmount) {
  const normalized = normalizeVendorName(vendorName);
  direction = direction || 'expense';

  // Never overwrite manual mappings with auto-learned ones
  const { rows: existing } = await pool.query(
    'SELECT source FROM vendor_mapping WHERE realm_id = $1 AND vendor_name = $2 AND direction = $3',
    [realmId, vendorName, direction]
  );
  if (existing.length && existing[0].source === 'manual' && source !== 'manual') {
    return false; // Don't overwrite manual entries
  }

  const { rowCount } = await pool.query(`
    INSERT INTO vendor_mapping
      (firm_id, realm_id, vendor_name, vendor_name_normalized, direction, account_name, account_id, source, confidence, min_amount, max_amount)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (realm_id, vendor_name, direction) DO UPDATE SET
      account_name = EXCLUDED.account_name,
      account_id = EXCLUDED.account_id,
      source = CASE WHEN vendor_mapping.source = 'manual' THEN vendor_mapping.source ELSE EXCLUDED.source END,
      confidence = CASE WHEN vendor_mapping.source = 'manual' THEN vendor_mapping.confidence ELSE EXCLUDED.confidence END,
      min_amount = COALESCE(EXCLUDED.min_amount, vendor_mapping.min_amount),
      max_amount = COALESCE(EXCLUDED.max_amount, vendor_mapping.max_amount),
      vendor_name_normalized = EXCLUDED.vendor_name_normalized,
      updated_at = NOW()
  `, [firmId, realmId, vendorName, normalized, direction, accountName, accountId || '', source, confidence, minAmount, maxAmount]);

  return rowCount > 0;
}

async function incrementMappingUsage(mappingId) {
  await pool.query(
    'UPDATE vendor_mapping SET usage_count = usage_count + 1, last_used_at = NOW() WHERE id = $1',
    [mappingId]
  ).catch(() => {}); // non-fatal
}

async function recordCodedTransaction(realmId, firmId, runId, txn, accountName, codedBy, confidence) {
  const vendorName = extractVendorName(txn);
  const description = txn.PrivateNote || txn.Line?.[0]?.Description || '';

  await pool.query(`
    INSERT INTO transactions
      (realm_id, qb_id, txn_type, date, amount, description, vendor_name,
       original_account, ai_category, ai_confidence, status,
       firm_id, bookkeeper_run_id, coded_by, coded_account, coded_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'categorized', $11, $12, $13, $14, NOW())
    ON CONFLICT (realm_id, qb_id) DO UPDATE SET
      status = 'categorized',
      coded_by = EXCLUDED.coded_by,
      coded_account = EXCLUDED.coded_account,
      coded_at = NOW(),
      bookkeeper_run_id = EXCLUDED.bookkeeper_run_id,
      ai_category = EXCLUDED.ai_category,
      ai_confidence = EXCLUDED.ai_confidence,
      updated_at = NOW()
  `, [
    realmId, txn.Id, txn._txnType || 'Purchase', txn.TxnDate || '', txn.TotalAmt || 0,
    description, vendorName, txn._accountName || '',
    accountName, confidence || null,
    firmId, runId, codedBy, accountName,
  ]);
}

async function recordUncodedTransaction(firmId, realmId, companyName, runId, txn, aiResult) {
  const vendorName = extractVendorName(txn);
  const description = txn.PrivateNote || txn.Line?.[0]?.Description || '';

  await pool.query(`
    INSERT INTO bookkeeper_uncoded
      (firm_id, realm_id, company_name, run_id, txn_qb_id, txn_type, txn_date,
       vendor_name, amount, description, original_account,
       ai_suggested_account, ai_confidence, ai_reasoning)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  `, [
    firmId, realmId, companyName, runId,
    txn.Id, txn._txnType || 'Purchase', txn.TxnDate || '',
    vendorName, txn.TotalAmt || 0, description, txn._accountName || '',
    aiResult.account_name || '', aiResult.confidence || 0, aiResult.reasoning || '',
  ]);
}

async function createRunRecord(realmId, firmId) {
  const { rows } = await pool.query(`
    INSERT INTO bookkeeper_runs (realm_id, firm_id, status, started_at)
    VALUES ($1, $2, 'running', NOW())
    RETURNING id
  `, [realmId, firmId]);
  return rows[0].id;
}

async function completeRun(runId, stats) {
  await pool.query(`
    UPDATE bookkeeper_runs
    SET status = 'completed',
        txns_found = $1, txns_auto_coded = $2, txns_ai_coded = $3,
        txns_manual_review = $4, txns_failed = $5, new_mappings_created = $6,
        completed_at = NOW()
    WHERE id = $7
  `, [
    stats.txns_found || 0, stats.txns_auto_coded || 0, stats.txns_ai_coded || 0,
    stats.txns_manual_review || 0, stats.txns_failed || 0, stats.new_mappings_created || 0,
    runId,
  ]);
}

async function failRun(runId, errorMessage) {
  await pool.query(
    'UPDATE bookkeeper_runs SET status = $1, error_message = $2, completed_at = NOW() WHERE id = $3',
    ['failed', errorMessage, runId]
  );
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// Scan-only: pull uncategorized txns from QBO and save to bookkeeper_uncoded
// without running AI categorization. Used by the Rescan button.
async function scanOnlyBookkeeper(realmId, firmId) {
  const { rows: coRows } = await pool.query(
    'SELECT company_name FROM companies WHERE realm_id = $1 AND firm_id = $2',
    [realmId, firmId]
  );
  const companyName = coRows[0]?.company_name || '';

  const runId = await createRunRecord(realmId, firmId);
  const chartOfAccounts = await getChartOfAccounts(realmId);
  const uncategorizedTxns = await fetchUncategorizedTransactions(realmId, chartOfAccounts);

  console.log(`[bookkeeper:scan-only] Found ${uncategorizedTxns.length} uncategorized txns for ${companyName}`);

  // Get existing pending txn_qb_ids so we don't double-insert
  const { rows: existing } = await pool.query(
    `SELECT DISTINCT txn_qb_id FROM bookkeeper_uncoded
     WHERE realm_id = $1 AND status = 'pending'`,
    [realmId]
  );
  const existingIds = new Set(existing.map(r => r.txn_qb_id));

  let inserted = 0;
  for (const txn of uncategorizedTxns) {
    if (existingIds.has(txn.Id)) continue; // already in DB
    const vendorName = extractVendorName(txn);
    const description = txn.PrivateNote || txn.Line?.[0]?.Description || '';
    await pool.query(`
      INSERT INTO bookkeeper_uncoded
        (firm_id, realm_id, company_name, run_id, txn_qb_id, txn_type, txn_date,
         vendor_name, amount, description, original_account,
         ai_suggested_account, ai_confidence, ai_reasoning)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '', 0, '')
    `, [
      firmId, realmId, companyName, runId,
      txn.Id, txn._txnType || 'Purchase', txn.TxnDate || '',
      vendorName, txn.TotalAmt || 0, description, txn._accountName || '',
    ]);
    inserted++;
  }

  await completeRun(runId, {
    txns_found: uncategorizedTxns.length,
    txns_auto_coded: 0,
    txns_ai_coded: 0,
    txns_manual_review: inserted,
    txns_failed: 0,
    new_mappings_created: 0,
  });

  return { success: true, txns_found: uncategorizedTxns.length, txns_new: inserted, runId };
}

module.exports = {
  runBookkeeper,
  scanOnlyBookkeeper,
  rebuildVendorMapping,
  researchVendor,
  normalizeVendorName,
  processTransaction,
  findVendorMapping,
  fetchUncategorizedTransactions,
};
