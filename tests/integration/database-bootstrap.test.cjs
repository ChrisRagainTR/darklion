'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Dedicated disposable Postgres only; never use DATABASE_URL from a developer's
// live environment. CI supplies a fresh service named darklion_bootstrap_test.
test('empty database initializes, then restarts without changing fixture records', async t => {
  const target = new URL(process.env.DATABASE_BOOTSTRAP_TEST_URL || 'http://unset.invalid');
  assert.ok(['postgres:', 'postgresql:'].includes(target.protocol));
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname));
  assert.equal(target.pathname, '/darklion_bootstrap_test');
  process.env.DATABASE_URL = target.toString();
  process.env.DB_SSL = 'false';
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  const { pool, initDB } = require('../../server/db');
  t.after(() => pool.end());
  const before = await pool.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='public'");
  assert.equal(before.rows[0].count, 0, 'Refusing to reuse a populated database');
  await initDB();
  const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='statement_monthly_status' AND column_name='document_id'");
  assert.equal(columns.rowCount, 1);
  const foreignKey = await pool.query("SELECT 1 FROM pg_constraint WHERE conrelid='statement_monthly_status'::regclass AND confrelid='documents'::regclass AND contype='f'");
  assert.equal(foreignKey.rowCount, 1);
  const { rows: [firm] } = await pool.query("INSERT INTO firms (name,email,password_hash,slug) VALUES ('Synthetic Restart','restart@example.invalid','not-a-login-hash','synthetic-restart') RETURNING id");
  const brandingFields = 'display_name, logo_url, portal_icon_url, portal_logo_style, primary_color, tagline, contact_email, phone, website, address';
  const initialBranding = (await pool.query(`SELECT ${brandingFields} FROM firms WHERE id=$1`, [firm.id])).rows[0];
  assert.equal(initialBranding.primary_color, '#C9A84C');
  assert.equal(initialBranding.display_name, null);
  await pool.query("UPDATE firms SET display_name='Synthetic Brand', portal_icon_url='logos/test/icon.png', portal_logo_style='icon', primary_color='#123456' WHERE id=$1", [firm.id]);
  await initDB();
  assert.equal((await pool.query('SELECT name FROM firms WHERE id=$1', [firm.id])).rows[0].name, 'Synthetic Restart');
  assert.equal((await pool.query('SELECT role FROM firm_users WHERE firm_id=$1', [firm.id])).rows[0].role, 'owner');
  const restartedBranding = (await pool.query(`SELECT ${brandingFields} FROM firms WHERE id=$1`, [firm.id])).rows[0];
  assert.equal(restartedBranding.display_name, 'Synthetic Brand');
  assert.equal(restartedBranding.primary_color, '#123456');
  await t.test('archive-failed messages stay out of previews, searches, and counts', async () => {
    const { verifyMessageVisibility } = require('./message-visibility.cjs');
    await verifyMessageVisibility(pool, firm.id);
  });
  await t.test('pending archive retries persist the actual R2 receipt and attachment references', async () => {
    const { verifyArchiveReceipts } = require('./archive-receipts.cjs');
    await verifyArchiveReceipts(pool, firm.id);
  });
  await t.test('firm rollout, company ownership, and legacy reference boundaries hold across two firms', async () => {
    const { verifyFirmBoundaries } = require('./firm-boundaries.cjs');
    await verifyFirmBoundaries(pool, firm.id, initDB);
  });
  await t.test('agent inbox matches staff-specific archive state', async () => {
    await require('./inbox-archive.cjs').verifyInboxArchive(pool);
  });
  await t.test('staff chat CRM queries execute and isolate firm records', async () => {
    await require('./chat-crm.cjs').verifyChatCrm(pool);
  });
  await t.test('public firm enrollment and account lifecycle',async t=>{
    await require('./public-offer.cjs').verifyPublicOffer(pool,t);
  });
  await t.test('platform administration and read-only support boundaries',async t=>{
    await require('./admin-center.cjs').verifyAdminCenter(pool,t);
  });

});
