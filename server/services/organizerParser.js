/**
 * organizerParser.js
 * Parses a Drake Software tax organizer PDF using pdf-parse.
 * Works with the actual text format pdf-parse produces from Drake PDFs.
 */

const pdfParse = require('pdf-parse');

// Payers your firm provides documents for (e.g. your custodian). Comma-separated
// in ORGANIZER_FIRM_PROVIDES_PAYERS; matched case-insensitively against payer names.
const FIRM_PROVIDES_PATTERNS = String(process.env.ORGANIZER_FIRM_PROVIDES_PAYERS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

const SECTION_ORDER = ['w2', '1099-r', '1099-div', '1099-int', '1099-nec', '1099-misc', '1099-g', 'k1', 'schedule-c', '1098', 'childcare', 'other'];

/**
 * Extract full text from PDF buffer.
 */
async function extractText(pdfBuffer) {
  const data = await pdfParse(pdfBuffer);
  return data.text;
}

/**
 * Parse checklist section — extract named payers between section headers.
 * Drake checklist format in pdf-parse output:
 *   "Section Header (Form XXXX)\n [  ]PAYER NAME\n [  ]PAYER NAME\n..."
 */
function extractChecklistSection(text, startPattern, endPattern) {
  const regex = new RegExp(startPattern + '([\\s\\S]*?)(?=' + endPattern + '|$)', 'i');
  const match = text.match(regex);
  if (!match) return [];

  const sectionText = match[1];
  // Lines that look like checklist items: " [  ]PAYER NAME" or "[  ] PAYER NAME".
  // Drake organizer PDFs also contain long questionnaire/instruction lines in the same text stream;
  // those are not source-document request items, so filter them out aggressively.
  const lines = sectionText.split('\n')
    .map(l => l.replace(/^\s*\[\s+\]\s*/, '').trim())
    .filter(isLikelySourceDocumentLine);
  return lines;
}

function isLikelySourceDocumentLine(line) {
  if (!line || line.length <= 2) return false;
  if (line.match(/^\[/)) return false;
  if (line.match(/^Page \d/i)) return false;
  if (line.match(/^Drake Software/i)) return false;
  if (line.match(/^Name:/i)) return false;
  if (line.match(/^\d{4}$/)) return false;
  if (/^(Yes|No)$/i.test(line)) return false;
  if (/^Form\s+1099/i.test(line)) return false;
  if (/^Other\s+(income|payments?)\b/i.test(line)) return false;
  if (/^Payments?\s*\(/i.test(line)) return false;
  if (/provide supporting documentation/i.test(line)) return false;
  if (/_{4,}/.test(line)) return false;

  const genericPatterns = [
    /^(State and City Refunds|Unemployment compensation|Credit Card, Debit Card|Reportable payment transactions)\b/i,
    /^(Digital Asset Proceeds|Proceeds from Real Estate|Real estate transactions)\b/i,
    /^(Sale of assets|Cancellation of debt|Educator classroom|Employee business|Contributions? to|Expenses related|Alimony|Student loan|Tuition and fees)\b/i,
    /^(Medical and dental|Real estate taxes|Other state and local taxes|Mortgage interest|Investment interest|Cash contributions|Noncash contributions)\b/i,
    /^(Unreimbursed employee|Investment expenses|Gambling losses)\b/i,
    /^(Partnerships, S Corporations, Estates, and Trusts|Self-employed Income|Miscellaneous Income|Nonemployee Compensation)\b/i,
  ];
  if (genericPatterns.some(pattern => pattern.test(line))) return false;

  // Accept obvious named payers/entities or masked account lines paired by the caller.
  if (/^\*+\d+/.test(line) || /^\d{4,}$/.test(line)) return true;
  if (/\b(LLC|INC|CORP|COMPANY|CO\.?|LP|LLP|LTD|BANK|BROKERAGE|FINANCIAL|FIDELITY|VANGUARD|SCHWAB|MORGAN|CHASE|WELLS|AMEX|PAYPAL|STRIPE|VENMO|GOODWILL)\b/i.test(line)) return true;
  // All-caps names from Drake are usually actual payer names; title-case questionnaire text is usually generic.
  if (/^[A-Z0-9&.,'’\- ]{4,}$/.test(line) && /[A-Z]/.test(line)) return true;
  return false;
}

/**
 * Parse all checklist items from the document.
 */
function parseChecklistItems(text) {
  const items = [];

  // W-2
  for (const line of extractChecklistSection(text,
    'Wages \\(Form W-2\\)',
    'IRA Distributions|Dividends \\(Form|Interest \\(Form|State and City|Credit Card|Partnerships|Digital Asset|Proceeds from Real Estate|Other Income|Payments')) {
    items.push({ section: 'w2', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  // 1099-R
  for (const line of extractChecklistSection(text,
    'IRA Distributions.*?\\(Form 1099-R\\)',
    'Dividends \\(Form|Interest \\(Form')) {
    items.push({ section: '1099-r', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  // 1099-DIV — account numbers appear inline with no space
  const divLines = extractChecklistSection(text,
    'Dividends \\(Form 1099-DIV\\)',
    'Interest \\(Form 1099-INT\\)');
  let i = 0;
  while (i < divLines.length) {
    const line = divLines[i];
    const next = divLines[i + 1] || '';
    // Account number lines: all asterisks/digits
    if (next.match(/^\*+\d+$/) || next.match(/^\d{4,}$/)) {
      items.push({ section: '1099-div', payerName: line, accountNumber: next, owner: 'joint', ein: '' });
      i += 2;
    } else {
      items.push({ section: '1099-div', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
      i++;
    }
  }

  // 1099-INT
  const intLines = extractChecklistSection(text,
    'Interest \\(Form 1099-INT\\)',
    'State and City|Credit Card|Partnerships|Miscellaneous|Nonemployee');
  i = 0;
  while (i < intLines.length) {
    const line = intLines[i];
    const next = intLines[i + 1] || '';
    if (next.match(/^\*+\d+/) || next.match(/^\d{4,}/)) {
      items.push({ section: '1099-int', payerName: line, accountNumber: next.replace(/\s+S\s*$/, ''), owner: 'joint', ein: '' });
      i += 2;
    } else {
      items.push({ section: '1099-int', payerName: line, accountNumber: '', owner: 'joint', ein: '' });
      i++;
    }
  }

  // 1099-NEC
  for (const line of extractChecklistSection(text,
    'Nonemployee Compensation.*?\\(Form 1099-NEC\\)',
    'State and City|Credit Card|Partnerships|Self-employed|Other Income')) {
    items.push({ section: '1099-nec', payerName: line, accountNumber: '', owner: 'spouse', ein: '' });
  }

  // 1099-MISC
  for (const line of extractChecklistSection(text,
    'Miscellaneous Income.*?\\(Form 1099-MISC\\)',
    'Nonemployee|1099-NEC|State and City')) {
    items.push({ section: '1099-misc', payerName: line, accountNumber: '', owner: 'spouse', ein: '' });
  }

  // K-1 (partnerships/S-corps)
  for (const line of extractChecklistSection(text,
    'Partnerships.*?\\(Schedule K-1\\)',
    'Brokerage|Self-employed|Other Income|Digital Asset|Proceeds from Real Estate|Payments')) {
    if (!line.match(/^(Form 1099|Real estate|Brokerage)/i)) {
      items.push({ section: 'k1', payerName: line, accountNumber: '', owner: 'taxpayer', ein: '' });
    }
  }

  // Schedule C
  for (const line of extractChecklistSection(text,
    'Self-employed Income.*?\\(Schedule C\\)',
    'Other Income|Payments')) {
    items.push({ section: 'schedule-c', payerName: line + ' — Income & Expense Records', accountNumber: '', owner: 'taxpayer', ein: '' });
  }

  return items;
}

/**
 * Parse detail pages for enrichment data (amounts, EINs, owner T/S/J).
 * These pages have a specific LD page marker pattern.
 */
function parseDetailData(text) {
  const enriched = [];

  // W-2 detail (S_INC.LD): "EMPLOYER NAMET127000"
  const incLd = text.match(/S_INC\.LD[\s\S]*?(?=Page \d+|S_INC[0-9]|Dividend Income)/);
  if (incLd) {
    const lines = incLd[0].split('\n');
    for (const line of lines) {
      // Format: "EMPLOYER NAMET127000" or "EMPLOYER NAMES100752"
      const m = line.match(/^(.+?)([TS])(\d[\d,]+)\s*$/);
      if (m && m[1].length > 3 && !m[1].match(/^(Name|Payer|Employer|Drake|JULIA)/i)) {
        enriched.push({
          section: 'w2',
          payerName: m[1].trim(),
          owner: m[2] === 'T' ? 'taxpayer' : 'spouse',
          prior_year_amount: parseFloat(m[3].replace(/,/g, '')),
        });
      }
    }
  }

  // K-1 detail (S_E2.LD): "T47-5178066 ALPIINROK PHYSIATRY INC"
  const e2Ld = text.match(/S_E2\.LD[\s\S]*?(?=General Information|Schedule F|Page \d+\s+General)/);
  if (e2Ld) {
    const lines = e2Ld[0].split('\n');
    for (const line of lines) {
      const m = line.match(/^([TS])([\d-]{9,12})\s+(.+)$/);
      if (m) {
        enriched.push({
          section: 'k1',
          payerName: m[3].trim(),
          ein: m[2].trim(),
          owner: m[1] === 'T' ? 'taxpayer' : 'spouse',
        });
      }
    }
  }

  // 1098 mortgage (S_OTHER.LD): "LENDER NAME77772"
  const otherLd = text.match(/S_OTHER\.LD[\s\S]*?(?=Page \d+\s*$|Additional Deductions|$)/);
  if (otherLd) {
    const segment = otherLd[0];
    // Pattern: lender name immediately followed by amount (no space in pdf-parse output)
    const m = segment.match(/([A-Z][A-Z\s]+(?:BANK|MORTGAGE|FINANCIAL|CREDIT|LOAN|TRUST|SAVINGS|FEDERAL)[A-Z\s]*)(\d[\d,]+)/i);
    if (m) {
      enriched.push({
        section: '1098',
        payerName: m[1].trim(),
        owner: 'joint',
        prior_year_amount: parseFloat(m[2].replace(/,/g, '')),
      });
    }
  }

  // Interest detail (S_INC2.LD): payer + account + amounts
  const inc2Ld = text.match(/S_INC2\.LD[\s\S]*?(?=Sale of Capital|S_INC3|Page \d+\s+Sale)/);
  if (inc2Ld) {
    const lines = inc2Ld[0].split('\n').map(l => l.trim()).filter(Boolean);
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      // Format: "T MICHIGAN STATE UNIVERSITY FED CU"
      const m = line.match(/^([TSJ])\s+(.{5,})/);
      if (m && !m[2].match(/^(JULIA|Name:|Page|\d{4}|Payer|Account|Dividend|Interest|Ordinary)/i)) {
        const owner = m[1] === 'T' ? 'taxpayer' : m[1] === 'S' ? 'spouse' : 'joint';
        // Next line might be account number, line after that might be amount
        const next1 = lines[j + 1] || '';
        const next2 = lines[j + 2] || '';
        const acct = next1.match(/^\*+\d+/) ? next1.replace(/\s+S\s*$/, '') : '';
        const amtLine = acct ? next2 : next1;
        const amt = amtLine.match(/^(\d[\d,]+)\s*$/);
        enriched.push({
          section: '1099-int',
          payerName: m[2].trim(),
          accountNumber: acct,
          owner,
          prior_year_amount: amt ? parseFloat(amt[1].replace(/,/g, '')) : null,
        });
      }
    }
  }

  // Student loan interest (Detail worksheet)
  const studentLoanMatch = text.match(/MOHELA\s+([\d,]+)|AIDVANTAGE.*?\s+([\d,]+)/g);
  if (studentLoanMatch) {
    for (const m of studentLoanMatch) {
      const parts = m.match(/^(.+?)\s+([\d,]+)$/);
      if (parts) {
        enriched.push({
          section: 'other',
          payerName: parts[1].trim() + ' — Student Loan Interest',
          owner: 'taxpayer',
          prior_year_amount: parseFloat(parts[2].replace(/,/g, '')),
        });
      }
    }
  }

  // Schedule C detail
  const schedC = text.match(/S_C\.LD[\s\S]*?(?=S_DETAIL|General Property|Page \d+\s+General Prop)/);
  if (schedC) {
    const bizMatch = schedC[0].match(/([A-Z][A-Z\s]+LLC|[A-Z][A-Z\s]+INC|[A-Z][A-Z\s]+CORP)/);
    if (bizMatch) {
      const einMatch = schedC[0].match(/([TS])\s*([\d-]{9,11})/);
      enriched.push({
        section: 'schedule-c',
        payerName: bizMatch[1].trim() + ' — Income & Expense Records',
        ein: einMatch ? einMatch[2] : '',
        owner: einMatch && einMatch[1] === 'S' ? 'spouse' : 'taxpayer',
      });
    }
  }

  // Childcare — S_TPINFO.LD2
  const childPage = text.match(/S_TPINFO\.LD2[\s\S]*?(?=Wages & Salaries|S_INC\.LD)/);
  if (childPage) {
    // Look for care provider: name line followed by address line then EIN then amounts
    const providerMatch = childPage[0].match(/([A-Z][A-Z\s]+(?:SCHOOL|CENTER|ACADEMY|CARE|CHURCH|PRESCHOOL|TRINITY|MONTESSORI)[A-Z\s]*)\s*[\d\*]+\s+[^\n]+\n[^\n]*\n[^\n]*?([\d,]{4,})/i);
    if (providerMatch) {
      enriched.push({
        section: 'childcare',
        payerName: providerMatch[1].trim() + ' — Childcare/Tuition Statement',
        owner: 'joint',
        prior_year_amount: parseFloat(providerMatch[2].replace(/,/g, '')),
      });
    }
  }

  return enriched;
}

/**
 * Merge checklist items with detail enrichment.
 */
function mergeItems(checklistItems, detailItems) {
  const merged = [...checklistItems];

  for (const detail of detailItems) {
    const idx = merged.findIndex(item =>
      item.section === detail.section &&
      (item.payerName.toLowerCase().slice(0, 8) === detail.payerName.toLowerCase().slice(0, 8) ||
       detail.payerName.toLowerCase().slice(0, 8) === item.payerName.toLowerCase().slice(0, 8))
    );

    if (idx >= 0) {
      if (detail.ein) merged[idx].ein = detail.ein;
      if (detail.owner && detail.owner !== 'joint') merged[idx].owner = detail.owner;
      if (detail.prior_year_amount) merged[idx].prior_year_amount = detail.prior_year_amount;
      if (detail.accountNumber) merged[idx].accountNumber = detail.accountNumber;
    } else if (['1098', 'childcare', 'other'].includes(detail.section)) {
      const exists = merged.some(m => m.section === detail.section &&
        m.payerName.toLowerCase().slice(0, 8) === detail.payerName.toLowerCase().slice(0, 8));
      if (!exists) merged.push(detail);
    }
  }

  return merged;
}

function flagFirmProvidedItems(items, firmCompanyNames = [], useFirmPayerDefaults = false) {
  return items.map(item => ({
    ...item,
    sentinel_provides:
      (useFirmPayerDefaults && FIRM_PROVIDES_PATTERNS.some(p => p.test(item.payerName))) ||
      (item.section === 'k1' && firmCompanyNames.some(name =>
        item.payerName.toLowerCase().includes(name.toLowerCase().slice(0, 8))
      )),
  }));
}

function deduplicateItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.section}:${item.payerName.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 18)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Main export: parse a Drake organizer PDF buffer.
 */
async function parseOrganizerPdf(pdfBuffer, firmCompanyNames = [], { useFirmPayerDefaults = false } = {}) {
  const text = await extractText(pdfBuffer);

  // Client name: "JULIA E CARP***-**-****"
  const nameMatch = text.match(/([A-Z][A-Z\s&]+(?:LLC|INC|LP)?)\*{3}-\*{2}-\*{4}/);
  const clientName = nameMatch ? nameMatch[1].trim() : 'Unknown Client';
  const yearMatch = text.match(/\b(202\d)\b/);
  const taxYear = yearMatch ? yearMatch[1] : '2025';

  const checklistItems = parseChecklistItems(text);
  const detailItems = parseDetailData(text);

  let items = mergeItems(checklistItems, detailItems);
  items = deduplicateItems(items);
  items = flagFirmProvidedItems(items, firmCompanyNames, useFirmPayerDefaults);

  items = items
    .sort((a, b) => {
      const ai = SECTION_ORDER.indexOf(a.section);
      const bi = SECTION_ORDER.indexOf(b.section);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map((item, i) => ({ ...item, display_order: i }));

  return { clientName, taxYear, items };
}

module.exports = { parseOrganizerPdf, flagFirmProvidedItems };
