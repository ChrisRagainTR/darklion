'use strict';

// Operator-only fixture creation. Never runs as part of app startup.
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const { assertRuntimeSafety, isolatedStaging } = require('../server/services/runtimeSafety');

async function seedStaging(env = process.env) {
  assertRuntimeSafety(env);
  if (!isolatedStaging(env) || env.STAGING_FIXTURE_CONFIRMATION !== 'synthetic-only') throw new Error('SYNTHETIC_STAGING_CONFIRMATION_REQUIRED');
  if ((env.STAGING_STAFF_PASSWORD || '').length < 20 || (env.STAGING_CLIENT_PASSWORD || '').length < 20) throw new Error('STRONG_FIXTURE_PASSWORDS_REQUIRED');
  const pool = new Pool({ connectionString: env.DATABASE_URL, ssl: env.DB_SSL === 'false' ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE firms IN EXCLUSIVE MODE');
    const names = ['alpha', 'beta'];
    const slugs = names.map(n => 'darklion-staging-' + n);
    const existing = await client.query('SELECT slug FROM firms');
    if (existing.rows.some(row => !slugs.includes(row.slug))) throw new Error('REFUSING_NON_FIXTURE_DATABASE');
    const staffHash = await bcrypt.hash(env.STAGING_STAFF_PASSWORD, 12);
    const clientHash = await bcrypt.hash(env.STAGING_CLIENT_PASSWORD, 12);
    const fixtures = [];
    for (const name of names) {
      const slug = 'darklion-staging-' + name, firmName = 'Synthetic ' + name.toUpperCase();
      const staffEmail = `staff-${name}@darklion.example.invalid`, clientEmail = 'client@darklion.example.invalid';
      const { rows: [firm] } = await client.query(`INSERT INTO firms (name,email,password_hash,slug)
        VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO UPDATE SET password_hash=EXCLUDED.password_hash
        RETURNING id`, [firmName, staffEmail, staffHash, slug]);
      const { rows: [staff] } = await client.query(`INSERT INTO firm_users (firm_id,name,email,password_hash,role,accepted_at)
        VALUES ($1,'Synthetic Owner',$2,$3,'owner',NOW())
        ON CONFLICT (firm_id,email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id`, [firm.id, staffEmail, staffHash]);
      let { rows: [relationship] } = await client.query('SELECT id FROM relationships WHERE firm_id=$1 AND name=$2', [firm.id,'Synthetic Household']);
      if (!relationship) ({ rows: [relationship] } = await client.query('INSERT INTO relationships (firm_id,name) VALUES ($1,$2) RETURNING id', [firm.id,'Synthetic Household']));
      let { rows: [person] } = await client.query('SELECT id FROM people WHERE firm_id=$1 AND email=$2', [firm.id,clientEmail]);
      if (!person) ({ rows: [person] } = await client.query(`INSERT INTO people
        (firm_id,relationship_id,first_name,last_name,email,portal_enabled,portal_password_hash)
        VALUES ($1,$2,'Synthetic','Client',$3,true,$4) RETURNING id`, [firm.id,relationship.id,clientEmail,clientHash]));
      else await client.query('UPDATE people SET portal_password_hash=$1 WHERE id=$2 AND firm_id=$3', [clientHash,person.id,firm.id]);
      fixtures.push({ slug, firmId: firm.id, firmName, staffUserId: staff.id, staffEmail, personId: person.id, clientEmail, relationshipId: relationship.id });
    }
    await client.query('COMMIT');
    return fixtures;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); await pool.end(); }
}
if (require.main === module) seedStaging().then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { seedStaging };
