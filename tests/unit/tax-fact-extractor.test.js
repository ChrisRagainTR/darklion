'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('../fixtures/form1040-core-layout-anonymized.json');
const { extractCore1040Facts, applyVerifiedFacts } = require('../../server/services/taxFactExtractor');

test('extracts core Form 1040 amounts from visual line positions', () => {
  const extraction = extractCore1040Facts(fixture);
  const values = Object.fromEntries(
    Object.entries(extraction.facts).map(([key, data]) => [key, data.value])
  );

  assert.deepEqual(values, {
    tax_year: '2025',
    adjusted_gross_income: 100000,
    taxable_income: 80000,
    total_tax: 66693,
    total_payments: 11960,
    overpayment: 0,
    refund: 0,
    balance_due: 56415,
    estimated_tax_penalty: 1682,
  });
});

test('verified balance due wins over a zero refund without adding penalty twice', () => {
  const extraction = extractCore1040Facts(fixture);
  const result = applyVerifiedFacts({
    total_tax: 66693,
    total_payments: 56415,
    refund_or_owed_amount: 0,
    is_refund: true,
  }, extraction);

  assert.equal(result.total_tax, 66693);
  assert.equal(result.total_payments, 11960);
  assert.equal(result.refund_or_owed_amount, 56415);
  assert.equal(result.refund_or_balance_due, 56415);
  assert.equal(result.is_refund, false);
  assert.equal(result.estimated_tax_penalty, 1682);
});

test('a verified zero refund alone does not erase a nonzero AI balance due', () => {
  const result = applyVerifiedFacts({
    total_payments: 2000,
    refund_or_owed_amount: 5000,
    refund_or_balance_due: 5000,
    is_refund: false,
  }, {
    facts: { refund: { value: 0, confidence: 'verified', source: 'Form 1040 line 35a', snippet: '' } },
    missing: ['balance_due'],
    status: 'partial',
  });

  assert.equal(result.refund_or_owed_amount, 5000);
  assert.equal(result.is_refund, false);
});

test('rejects an AI payment amount that duplicates a verified amount owed', () => {
  const result = applyVerifiedFacts({
    total_tax: 66693,
    total_payments: 56415,
    refund_or_owed_amount: 56415,
    is_refund: false,
  }, {
    facts: { balance_due: { value: 56415, confidence: 'verified', source: 'Form 1040 line 37', snippet: '' } },
    missing: ['total_payments'],
    status: 'partial',
  });

  assert.equal(result.total_payments, null);
  assert.deepEqual(result.core_fact_reconciliation_issues, ['total_payments_duplicates_balance_due']);
});

test('malformed positional data degrades without inventing a line value', () => {
  const malformed = {
    text: 'Form 1040 (2023) 24 Total tax 99,999',
    pages: [{
      number: 1,
      width: 612,
      items: [
        { x: 40, y: 760, text: 'Form 1040 (2023)' },
        { x: 96, y: 535, text: '24' },
        { x: 120, y: 535, text: 'Total tax' },
        { x: 550, y: 535, text: '99,999' }
      ]
    }]
  };

  const extraction = extractCore1040Facts(malformed);
  assert.equal(extraction.facts.total_tax, undefined);
  assert.ok(extraction.missing.includes('total_tax'));
});

test('plain ambiguous label text is not promoted to a verified amount', () => {
  const extraction = extractCore1040Facts('Form 1040 (2021) 24 Total tax 99,999');
  assert.equal(extraction.facts.total_tax, undefined);
  assert.ok(extraction.missing.includes('total_tax'));
});

test('filing-status labels without a checked state are not treated as verified', () => {
  const extraction = extractCore1040Facts(
    'Form 1040 (2022) Single Married filing jointly Married filing separately Head of household'
  );
  assert.equal(extraction.facts.filing_status, undefined);
  assert.ok(extraction.missing.includes('filing_status'));
});
