'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { initializeLoginIdentities } = require('../../server/services/loginIdentitySchema');
const { resolveLoginFirm } = require('../../server/services/loginIdentity');

// Explicit opt-in: creates and drops only a synthetic local PostgreSQL database.
test('one email belongs to one firm across owner, staff, client, and spouse roles', { skip: !process.env.TEST_LOCAL_POSTGRES }, async () => {
  const database = `darklion_login_test_${process.pid}`;
  const postgres = (args, options = {}) => execFileSync('runuser', ['-u', 'postgres', '--', ...args], { encoding: 'utf8', ...options });
  const sql = text => postgres(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-d', database, '-c', text], { stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  postgres(['createdb', database]);
  try {
    sql(`CREATE TABLE firms(id SERIAL PRIMARY KEY, email TEXT);
      CREATE TABLE firm_users(id SERIAL PRIMARY KEY, firm_id INTEGER REFERENCES firms(id), email TEXT);
      CREATE TABLE people(id SERIAL PRIMARY KEY, firm_id INTEGER REFERENCES firms(id), email TEXT, spouse_email TEXT);
      INSERT INTO firms VALUES(1,'owner@one.invalid'),(2,'owner@two.invalid');
      INSERT INTO people VALUES(1,1,'client@one.invalid','spouse@one.invalid');
      INSERT INTO firm_users VALUES(1,1,'CLIENT@one.invalid');`);
    await initializeLoginIdentities({ query: async text => sql(text) });
    await initializeLoginIdentities({ query: async text => sql(text) });
    const db = { query: async (query, params) => ({ rows: JSON.parse(sql(`SELECT COALESCE(json_agg(t),'[]') FROM (${query.replaceAll('$1', "'" + params[0].replaceAll("'", "''") + "'")}) t`)) }) };
    assert.equal(await resolveLoginFirm('client@one.invalid', db), 1);
    assert.equal(await resolveLoginFirm('spouse@one.invalid', db), 1);
    assert.equal(await resolveLoginFirm('missing@one.invalid', db), null);
    sql("INSERT INTO firm_users VALUES(2,1,' SPOUSE@ONE.INVALID ')");
    assert.throws(() => sql("INSERT INTO firm_users VALUES(3,2,' Client@One.Invalid ')"), /another firm/);
    assert.throws(() => sql("INSERT INTO people VALUES(2,2,'new@two.invalid','client@one.invalid')"), /another firm/);
    assert.throws(() => sql("UPDATE people SET firm_id=2 WHERE id=1"), /another firm/);
    assert.throws(() => sql("UPDATE firms SET email='spouse@one.invalid' WHERE id=2"), /another firm/);
    assert.equal(sql('SELECT COUNT(*) FROM people'), '1');
    // Concurrent claims from different firms cannot both succeed.
    const concurrent = text => new Promise(resolve => {
      const child = spawn('runuser', ['-u', 'postgres', '--', 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-qAt', '-d', database]);
      child.stdout.resume(); child.stderr.resume(); child.on('close', resolve); child.stdin.end(text);
    });
    const results = await Promise.all([
      concurrent("BEGIN; INSERT INTO people VALUES(10,1,'race@example.invalid',''); SELECT pg_sleep(0.2); COMMIT;"),
      concurrent("BEGIN; INSERT INTO people VALUES(11,2,'RACE@example.invalid',''); COMMIT;")
    ]);
    assert.equal(results.filter(code => code === 0).length, 1);
    // Legacy conflicts fail closed, even without a completed migration.
    sql("ALTER TABLE people DISABLE TRIGGER client_login_identity; INSERT INTO people VALUES(20,2,'client@one.invalid','')");
    assert.equal(await resolveLoginFirm('client@one.invalid', db), null);
    await assert.rejects(initializeLoginIdentities({ query: async text => sql(text) }), /another firm/);
  } finally {
    postgres(['dropdb', '--force', database]);
  }
});
