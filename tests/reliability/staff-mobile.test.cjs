// Staff iPhone app: return stages, next actions, and client list filters.
const test = require('node:test');
const assert = require('node:assert/strict');
const { staffReturnView, listStatus } = require('../../server/services/staffMobile');

const now = Date.parse('2026-09-26T12:00:00Z');
const hoursAgo = h => new Date(now - h * 3600000).toISOString();
const signer = (o = {}) => ({ delivery_id: 1, person_id: 1, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', spouse_name: 'Taylor Ellis', ...o });
const ret = (o = {}) => ({ id: 1, tax_year: '2025', status: 'sent', sent_at: hoursAgo(48), ...o });

test('waiting return names who signed and who has not, and allows a reminder', () => {
  const v = staffReturnView(ret(), [signer({ signed_at: hoursAgo(10) }), signer({ signer_role: 'spouse' })], now);
  assert.equal(v.stage, 'waiting');
  assert.equal(v.summary, 'Jordan signed · Waiting on Taylor');
  assert.equal(v.canRemind, true);
  assert.equal(v.signers[1].name, 'Taylor Ellis');
});

test('a reminder inside the 20-hour window is not offered again', () => {
  const v = staffReturnView(ret({ last_reminded_at: hoursAgo(3) }), [signer()], now);
  assert.equal(v.canRemind, false);
  assert.equal(v.remindedAt, hoursAgo(3));
});

test('fully signed returns become ready to e-file, then e-filed, then accepted', () => {
  const signed = [signer({ signed_at: hoursAgo(5) })];
  assert.equal(staffReturnView(ret({ status: 'signed' }), signed, now).stage, 'ready');
  assert.equal(staffReturnView(ret({ status: 'signed', filed_at: hoursAgo(2) }), signed, now).stage, 'filed');
  const accepted = staffReturnView(ret({ status: 'signed', filed_at: hoursAgo(48), accepted_at: hoursAgo(1) }), signed, now);
  assert.equal(accepted.stage, 'accepted');
  assert.equal(accepted.canRemind, false);
});

test('change requests carry the client note', () => {
  const v = staffReturnView(ret({ status: 'needs_changes' }), [signer({ needs_changes_at: hoursAgo(4), needs_changes_note: 'Home office is 240 sq ft' })], now);
  assert.equal(v.stage, 'changes_requested');
  assert.equal(v.changeNote, 'Home office is 240 sq ft');
  assert.equal(v.summary, 'Jordan asked for changes');
});

test('client list filters: waiting to sign, organizer out, ready to e-file', () => {
  const waiting = staffReturnView(ret(), [signer()], now);
  const ready = staffReturnView(ret({ status: 'signed' }), [signer({ signed_at: hoursAgo(1) })], now);
  assert.equal(listStatus({ ret: waiting, now }).bucket, 'waiting');
  assert.equal(listStatus({ ret: ready, now }).bucket, 'ready');
  assert.equal(listStatus({ organizer: { status: 'in_progress', created_at: new Date(now - 21 * 86400000).toISOString() }, now }).label, 'Organizer out · 21 days');
  assert.equal(listStatus({ organizer: { status: 'submitted' }, now }).bucket, null);
  assert.equal(listStatus({ now }), null);
});

