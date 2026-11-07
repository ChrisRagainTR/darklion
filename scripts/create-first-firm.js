'use strict';
// Creates the first firm and its owner login on a fresh self-hosted install.
// Usage:
//   FIRM_NAME="Smith & Co. CPAs" OWNER_NAME="Jane Smith" OWNER_EMAIL=jane@yourfirm.com \
//   OWNER_PASSWORD='choose-a-long-password' npm run bootstrap
const bcrypt = require('bcrypt');
const { pool, initDB } = require('../server/db');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error('Set ' + name + ' before running the bootstrap script.');
  return value;
}

async function main() {
  const name = required('FIRM_NAME');
  const ownerName = required('OWNER_NAME');
  const email = required('OWNER_EMAIL').toLowerCase();
  const password = required('OWNER_PASSWORD');
  if (password.length < 12) throw new Error('OWNER_PASSWORD must be at least 12 characters.');
  const slug = (process.env.FIRM_SLUG || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

  await initDB();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM firm_users WHERE LOWER(email)=$1', [email]);
    if (existing.rows.length) throw new Error('A user with that email already exists.');
    const hash = await bcrypt.hash(password, 12);
    const firm = (await client.query(
      "INSERT INTO firms(name,email,password_hash,slug,plan,display_name,contact_email) VALUES($1,$2,$3,$4,'self_hosted',$1,$2) RETURNING id",
      [name, email, hash, slug],
    )).rows[0];
    await client.query(
      "INSERT INTO firm_users(firm_id,name,email,password_hash,role,accepted_at) VALUES($1,$2,$3,$4,'owner',NOW())",
      [firm.id, ownerName, email, hash],
    );
    await client.query(
      'INSERT INTO firm_preferences(firm_id,settings) VALUES($1,$2) ON CONFLICT (firm_id) DO NOTHING',
      [firm.id, JSON.stringify({ edition: 'existing', notificationFallback: 'owners', aiEnabled: true })],
    );
    await client.query('COMMIT');
    console.log('Created firm ' + firm.id + ' (' + slug + '). Sign in at ' + (process.env.APP_URL || 'http://localhost:8080') + '/login');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main().then(() => pool.end()).catch(async error => {
  console.error(error.message);
  process.exitCode = 1;
  await pool.end().catch(() => {});
});
