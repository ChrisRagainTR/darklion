const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assembleToday, householdName } = require('../../server/services/advisorToday');

const now = new Date('2026-09-25T18:00:00Z').getTime();
const day = 86400000;
const signer = (o = {}) => ({ person_id: 1, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', spouse_name: 'Taylor Ellis', ...o });
const d = (o = {}) => ({ id: 1, tax_year: '2025', status: 'sent', company_id: null, sent_at: new Date(now - 6 * day), signers: [signer(), signer({ signer_role: 'spouse' })], ...o });

test('household names read naturally', () => {
  assert.equal(householdName('Jordan', 'Ellis', 'Taylor Ellis'), 'Jordan & Taylor Ellis');
  assert.equal(householdName('Maria', 'Ortiz', 'Sam Lee'), 'Maria Ortiz & Sam Lee');
  assert.equal(householdName('Kevin', 'Holt', ''), 'Kevin Holt');
});

test('returns land in the right work list with ages and actions', () => {
  const r = assembleToday({ taxYear: '2025', now, organizers: [], deliveries: [
    d({ id: 1 }),
    d({ id: 2, status: 'signed', signers: [signer({ signed_at: new Date(now - 1 * day) })] }),
    d({ id: 3, status: 'needs_changes', needs_changes_note: 'Home office is 240 sq ft', signers: [signer({ needs_changes_at: new Date(now - 2 * day) })] }),
    d({ id: 4, status: 'signed', filed_at: new Date(now - 3 * day), signers: [signer({ signed_at: new Date(now - 4 * day) })] }),
    d({ id: 5, status: 'signed', filed_at: new Date(now - 90 * day), filed_date_known: false, signers: [signer({ signed_at: new Date(now - 90 * day) })] }),
    d({ id: 6, status: 'signed', filed_at: new Date(now - 3 * day), accepted_at: new Date(now - 2 * day), signers: [signer()] }),
    d({ id: 7, company_id: 9, company_name: 'Ellis Design Studio LLC', status: 'approved', last_reminded_at: new Date(now - 2 * 3600 * 1000), signers: [signer({ approved_at: new Date() })] }),
  ] });
  assert.deepEqual(r.readyToEfile.items.map(i => i.id), [2]);
  assert.equal(r.changesRequested.items[0].note, 'Home office is 240 sq ft');
  assert.equal(r.changesRequested.items[0].days, 2);
  const waiting = r.waitingOnClients.items;
  assert.deepEqual(waiting.map(i => i.id).sort(), [1, 7]);
  const ellis = waiting.find(i => i.id === 1);
  assert.equal(ellis.name, 'Jordan & Taylor Ellis'); assert.equal(ellis.detail, 'Waiting on Jordan and Taylor to sign'); assert.equal(ellis.days, 6); assert.equal(ellis.canRemind, true);
  const biz = waiting.find(i => i.id === 7);
  assert.equal(biz.name, 'Ellis Design Studio LLC'); assert.equal(biz.href, '/crm/company/9'); assert.equal(biz.canRemind, false, 'reminded 2 hours ago');
  assert.deepEqual(r.filedAwaitingAcceptance.items.map(i => i.id), [4], 'returns filed before tracking are not listed');
  assert.equal(r.counts.accepted, 1); assert.equal(r.counts.acceptedThisWeek, 1);
});

test('organizers count as out or preparing until a return is sent; reopened ones wait on the client', () => {
  const o = (id, person_id, status, o2 = {}) => ({ id, person_id, tax_year: '2025', status, first_name: 'P' + id, last_name: 'X', updated_at: new Date(now - 10 * day), ...o2 });
  const r = assembleToday({ taxYear: '2025', now, deliveries: [d({ id: 1, signers: [signer({ person_id: 50 })] })], organizers: [
    o(1, 11, 'pending'), o(2, 12, 'in_progress'), o(3, 13, 'reopened'), o(4, 14, 'submitted'), o(5, 50, 'submitted'),
  ] });
  assert.equal(r.counts.organizersOut, 3); assert.equal(r.counts.preparing, 1, 'person 50 already has a return sent');
  const docs = r.waitingOnClients.items.find(i => i.type === 'documents');
  assert.equal(docs.detail, 'Asked for more documents'); assert.equal(docs.days, 10); assert.equal(docs.href, '/crm/person/13');
});

test('long lists are capped with a total', () => {
  const many = Array.from({ length: 12 }, (_, i) => d({ id: i + 1 }));
  const r = assembleToday({ taxYear: '2025', now, deliveries: many, organizers: [] });
  assert.equal(r.waitingOnClients.total, 12); assert.equal(r.waitingOnClients.items.length, 8);
});
