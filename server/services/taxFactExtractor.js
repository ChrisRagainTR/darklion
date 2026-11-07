'use strict';

function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || /^[-—]+$/.test(s)) return null;
  const negative = /^\(.*\)$/.test(s) || /^-/.test(s);
  s = s.replace(/[,$\s()]/g, '').replace(/^[+-]/, '');
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

function normalizeText(pdfText) {
  const sourceText = pdfText && typeof pdfText === 'object' && !Array.isArray(pdfText)
    ? pdfText.text
    : pdfText;
  const text = String(sourceText || '')
    .replace(/\r/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
  return {
    text,
    lines: text.split('\n').map(line => line.trim()).filter(Boolean),
    flat: text.replace(/\s+/g, ' ').trim(),
  };
}

function normalizedLayoutPages(pdfData) {
  if (!pdfData || typeof pdfData !== 'object' || !Array.isArray(pdfData.pages)) return [];
  return pdfData.pages.map((page, index) => ({
    number: Number(page.number) || index + 1,
    width: Number(page.width) || 612,
    items: Array.isArray(page.items)
      ? page.items.map(item => ({
        x: Number(item.x),
        y: Number(item.y),
        text: String(item.text || '').trim(),
      })).filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && item.text)
      : [],
  }));
}

function isForm1040Page(page) {
  const pageText = page.items.map(item => item.text).join(' ').replace(/\s+/g, ' ');
  return /\bForm\s*1040(?:-SR)?\b/i.test(pageText)
    || (/\b1040(?:-SR)?\b/i.test(pageText) && /U\.S\. Individual Income Tax Return/i.test(pageText));
}

function lineTokenMatches(text, line) {
  const compact = String(text || '').replace(/\s+/g, '').toLowerCase();
  const accepted = Array.isArray(line) ? line : [line];
  return accepted.some(candidate => {
    if (candidate === '35a') return compact === '35a' || compact === '35';
    return compact === candidate;
  });
}

function findLayoutAmount(pages, { line, label, source, maxLineHeight = 26 }) {
  for (const page of pages) {
    if (!isForm1040Page(page)) continue;
    const leftLimit = page.width * 0.4;
    const rightLimit = page.width * 0.55;
    const anchors = page.items.filter(item => item.x < leftLimit && lineTokenMatches(item.text, line));
    for (const anchor of anchors) {
      const region = page.items.filter(item => item.y <= anchor.y + 2 && item.y >= anchor.y - maxLineHeight);
      const regionText = region.map(item => item.text).join(' ').replace(/\s+/g, ' ');
      if (!label.test(regionText)) continue;

      const rightAnchor = region
        .filter(item => item.x >= rightLimit && lineTokenMatches(item.text, line))
        .sort((a, b) => b.x - a.x)[0];
      if (!rightAnchor) continue;

      const valueItem = page.items
        .filter(item => item.x > rightAnchor.x + 12 && Math.abs(item.y - rightAnchor.y) <= 2)
        .map(item => ({ item, value: parseAmount(item.text) }))
        .filter(candidate => candidate.value !== null)
        .sort((a, b) => Math.abs(a.item.y - rightAnchor.y) - Math.abs(b.item.y - rightAnchor.y) || b.item.x - a.item.x)[0];
      if (!valueItem) continue;

      return fact(
        valueItem.value,
        source,
        `Form 1040 line ${line}: ${regionText.replace(/\.{2,}/g, '').trim()}`
      );
    }
  }
  return null;
}

function findCoreAmount(pages, layoutSpec) {
  // Core money facts are only verified from visual Form 1040 positions. Flat PDF
  // text can place labels beside unrelated value blocks, so it is advisory only.
  return findLayoutAmount(pages, layoutSpec);
}

function sourceSnippet(flat, index, length = 180) {
  if (index < 0) return '';
  const start = Math.max(0, index - Math.floor(length / 2));
  return flat.slice(start, start + length).trim();
}

function fact(value, source, snippet, confidence = 'verified') {
  if (value === null || value === undefined || value === '') return null;
  return { value, confidence, source, snippet: snippet || '' };
}

function extractTaxYear(flat) {
  const patterns = [
    /Form\s+1040(?:-SR)?\s+\(?\s*(20\d{2})\s*\)?/i,
    /U\.S\.\s+Individual\s+Income\s+Tax\s+Return\s+(20\d{2})/i,
    /Tax\s+Return\s+Comparison\s+(20\d{2})/i,
    /\b(20\d{2})\s+Federal\s+Tax\s+Return/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(flat);
    if (match) return fact(match[1], 'Form 1040 header', sourceSnippet(flat, match.index));
  }
  return null;
}

function extractCore1040Facts(pdfText) {
  const { flat } = normalizeText(pdfText);
  const pages = normalizedLayoutPages(pdfText);
  const facts = {
    tax_year: extractTaxYear(flat),
    // Labels for every filing status are printed on Form 1040. Without a checked
    // control state, plain text cannot verify which one applies.
    filing_status: null,
    adjusted_gross_income: findCoreAmount(pages, {
      line: ['11a', '11b', '11'], label: /Adjusted gross income/i, source: 'Form 1040 line 11',
    }),
    taxable_income: findCoreAmount(pages, {
      line: '15', label: /Taxable income/i, source: 'Form 1040 line 15',
    }),
    total_tax: findCoreAmount(pages, {
      line: '24', label: /Total tax/i, source: 'Form 1040 line 24',
    }),
    total_payments: findCoreAmount(pages, {
      line: '33', label: /Total payments/i, source: 'Form 1040 line 33',
    }),
    overpayment: findCoreAmount(pages, {
      line: '34', label: /overpaid/i, source: 'Form 1040 line 34',
    }),
    refund: findCoreAmount(pages, {
      line: '35a', label: /refunded to you/i, source: 'Form 1040 line 35a',
    }),
    balance_due: findCoreAmount(pages, {
      line: '37', label: /Amount you owe/i, source: 'Form 1040 line 37', maxLineHeight: 28,
    }),
    estimated_tax_penalty: findCoreAmount(pages, {
      line: '38', label: /Estimated tax penalty/i, source: 'Form 1040 line 38',
    }),
  };

  const present = Object.fromEntries(Object.entries(facts).filter(([, v]) => v));
  const missing = Object.keys(facts).filter(key => !facts[key]);
  return {
    facts: present,
    missing,
    status: missing.length ? 'partial' : 'verified',
    extracted_at: new Date().toISOString(),
  };
}

function compactVerifiedFacts(extraction) {
  const facts = extraction?.facts || {};
  return Object.fromEntries(Object.entries(facts).map(([key, data]) => [key, data.value]));
}

function verifiedFactsFromReport(reportData) {
  const facts = reportData?.verified_facts;
  return facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : {};
}

function finiteAmount(value) {
  const amount = typeof value === 'number' ? value : parseAmount(value);
  return Number.isFinite(amount) ? amount : null;
}

function resolveRefundOrBalance(reportData, facts = verifiedFactsFromReport(reportData)) {
  const value = key => facts[key] && typeof facts[key] === 'object' ? finiteAmount(facts[key].value) : null;
  const balanceDue = value('balance_due');
  const refund = value('refund');

  if (balanceDue !== null && balanceDue > 0) return { amount: balanceDue, isRefund: false };
  if (refund !== null && refund > 0) return { amount: refund, isRefund: true };
  if (balanceDue === 0 && refund === 0) return { amount: 0, isRefund: false };

  const aiAmount = finiteAmount(reportData?.refund_or_owed_amount ?? reportData?.refund_or_balance_due);
  if (aiAmount !== null && aiAmount > 0) return { amount: aiAmount, isRefund: reportData?.is_refund === true };
  if (balanceDue === 0) return { amount: 0, isRefund: false };
  if (refund === 0) return { amount: 0, isRefund: true };
  return aiAmount === null ? null : { amount: aiAmount, isRefund: reportData?.is_refund === true };
}

function applyVerifiedFacts(reportData, extraction) {
  const data = { ...(reportData || {}) };
  const facts = extraction?.facts || {};
  const values = compactVerifiedFacts(extraction);
  if (values.tax_year) {
    data.tax_year = values.tax_year;
    data.client = { ...(data.client || {}), tax_year: values.tax_year };
  }
  if (values.filing_status) {
    data.filing_status = values.filing_status;
    data.client = { ...(data.client || {}), filing_status: values.filing_status };
  }
  if (values.adjusted_gross_income !== undefined) data.adjusted_gross_income = values.adjusted_gross_income;
  if (values.taxable_income !== undefined) data.taxable_income = values.taxable_income;
  if (values.total_tax !== undefined) data.total_tax = values.total_tax;

  const reconciliationIssues = [];
  if (values.total_payments !== undefined) {
    data.total_payments = values.total_payments;
  } else if (
    finiteAmount(values.balance_due) > 0
    && finiteAmount(data.total_payments) === finiteAmount(values.balance_due)
  ) {
    data.total_payments = null;
    reconciliationIssues.push('total_payments_duplicates_balance_due');
  }

  const outcome = resolveRefundOrBalance(data, facts);
  if (outcome) {
    data.refund_or_owed_amount = outcome.amount;
    data.refund_or_balance_due = outcome.amount;
    data.is_refund = outcome.isRefund;
  }
  if (values.overpayment !== undefined) data.overpayment = values.overpayment;
  if (values.estimated_tax_penalty !== undefined) data.estimated_tax_penalty = values.estimated_tax_penalty;
  if (reconciliationIssues.length) data.core_fact_reconciliation_issues = reconciliationIssues;
  data.verified_facts = facts;
  data.verified_fact_status = extraction?.status || 'none';
  data.verified_fact_missing = extraction?.missing || [];
  return data;
}

module.exports = {
  extractCore1040Facts,
  compactVerifiedFacts,
  applyVerifiedFacts,
  resolveRefundOrBalance,
  parseAmount,
};
