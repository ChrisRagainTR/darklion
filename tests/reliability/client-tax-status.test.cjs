const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleStatus, shapeDelivery, trackerSteps, upcomingEstimatedPayments } = require('../../server/services/clientTaxStatus');

const person = { first_name: 'Jordan' };
const today = '2026-09-25';
function delivery(overrides = {}) {
  return { id: 7, company_id: null, tax_year: '2025', status: 'sent', tax_summary: {}, tax_report_data: null, created_at: new Date('2026-09-25T14:00:00Z'), ...overrides };
}
function signer(overrides = {}) {
  return { delivery_id: 7, person_id: 1, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', spouse_name: 'Taylor Ellis', ...overrides };
}
function status({ rows = [], signers = [], organizer = null, signerRole = 'taxpayer' } = {}) {
  const deliveries = rows.map(row => ({ row, view: shapeDelivery(row, signers, { personId: 1, signerRole }) }));
  return assembleStatus({ person, taxYear: '2025', companies: [], deliveries, organizer, today });
}
const org = (status, resolved = 0) => ({ status, progress: { total: 14, resolved }, requestedItems: status === 'reopened' ? [{ id: 1, name: 'Fidelity' }] : [] });
const current = s => s.tracker.find(step => step.state === 'current')?.label;

test('each season state maps to the right stage, tracker step, and Home action', () => {
  const idle = status();
  assert.equal(idle.stage, 'idle'); assert.equal(idle.tracker, null); assert.deepEqual(idle.actions, []);

  const ready = status({ organizer: org('pending') });
  assert.equal(ready.stage, 'organizer_ready'); assert.equal(current(ready), 'Organizer'); assert.equal(ready.actions[0].type, 'organizer');

  const inProgress = status({ organizer: org('in_progress', 9) });
  assert.equal(inProgress.stage, 'organizer_in_progress');

  const more = status({ organizer: org('reopened', 14) });
  assert.equal(more.stage, 'more_documents'); assert.equal(current(more), 'We prepare'); assert.equal(more.actions[0].count, 1);

  const preparing = status({ organizer: org('submitted', 14) });
  assert.equal(preparing.stage, 'preparing'); assert.equal(current(preparing), 'We prepare'); assert.deepEqual(preparing.actions, []);
});

test('a sent return moves each spouse through review, sign, and waiting independently', () => {
  const both = [signer(), signer({ signer_role: 'spouse' })];
  const review = status({ rows: [delivery()], signers: both, organizer: org('submitted', 14) });
  assert.equal(review.stage, 'review'); assert.equal(current(review), 'Review & sign'); assert.equal(review.actions[0].type, 'tax_return');
  assert.deepEqual(review.personalReturn.signers.map(s => [s.name, s.isMe]), [['Jordan Ellis', true], ['Taylor Ellis', false]]);

  const approved = [signer({ approved_at: new Date() }), signer({ signer_role: 'spouse' })];
  assert.equal(status({ rows: [delivery()], signers: approved }).stage, 'sign');

  const oneSigned = [signer({ approved_at: new Date(), signed_at: new Date() }), signer({ signer_role: 'spouse' })];
  const waiting = status({ rows: [delivery()], signers: oneSigned });
  assert.equal(waiting.stage, 'signed_waiting'); assert.deepEqual(waiting.actions, []);
  assert.equal(status({ rows: [delivery()], signers: oneSigned, signerRole: 'spouse' }).stage, 'review', 'the spouse still has their own review');
});

test('change requests, signing, filing, and acceptance', () => {
  const s = [signer({ needs_changes_at: new Date('2026-09-26T20:18:00Z'), needs_changes_note: 'Home office is 240 sq ft' })];
  const changes = status({ rows: [delivery({ status: 'needs_changes', needs_changes_note: 'Home office is 240 sq ft' })], signers: s });
  assert.equal(changes.stage, 'changes_requested'); assert.equal(changes.personalReturn.changeRequest.note, 'Home office is 240 sq ft');
  assert.equal(changes.personalReturn.changeRequest.by, 'Jordan Ellis');

  const signed = [signer({ signed_at: new Date() })];
  assert.equal(status({ rows: [delivery({ status: 'signed' })], signers: signed }).stage, 'signed');
  const filed = status({ rows: [delivery({ status: 'signed', filed_at: new Date() })], signers: signed });
  assert.equal(filed.stage, 'filed'); assert.ok(filed.tracker.every(step => step.state === 'done'));
  assert.equal(status({ rows: [delivery({ status: 'signed', filed_at: new Date(), accepted_at: new Date() })], signers: signed }).stage, 'accepted');
  const legacy = status({ rows: [delivery({ status: 'signed', filed_at: new Date(), filed_date_known: false })], signers: signed });
  assert.equal(legacy.stage, 'filed'); assert.equal(legacy.personalReturn.filedDateKnown, false, 'launch backfill hides the filing date');
});

test('business returns skip the organizer step and never drive the personal stage', () => {
  assert.deepEqual(trackerSteps('review', { hasOrganizer: false }).map(s => s.state), ['done', 'current', 'upcoming']);
  const biz = delivery({ id: 9, company_id: 4, company_name: 'Ellis Design Studio LLC' });
  const result = status({ rows: [biz], signers: [signer({ delivery_id: 9 })] });
  assert.equal(result.stage, 'idle'); assert.equal(result.businessReturns[0].kind, 'business'); assert.equal(result.actions[0].deliveryId, 9);
});

test('estimated payments are future due-date reminders only, from the latest return summary', () => {
  const report = {
    federal_estimated_payments: [
      { quarter: '3rd', due_date: 'September 15, 2026', amount: '$2,900' },
      { quarter: '4th', due_date: 'January 15, 2027', amount: '$2,900' },
    ],
    state_estimated_payments: [{ state: 'Georgia', quarter: '4th', due_date: 'January 15, 2027', amount: '$600' }, { state: 'Georgia', quarter: '?', due_date: 'someday', amount: '$1' }],
  };
  const rows = upcomingEstimatedPayments(report, today);
  assert.deepEqual(rows.map(r => [r.jurisdiction, r.dueDate, r.amount]), [['Federal', '2027-01-15', '$2,900'], ['Georgia', '2027-01-15', '$600']]);
  assert.ok(rows.every(r => !('paid' in r)));
});
