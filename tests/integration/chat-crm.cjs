'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function verifyChatCrm(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Temporary fixtures intentionally include corrupt cross-firm links, to
    // verify the bot cannot expose another firm's counts or relationship names.
    await client.query(`
      CREATE TEMP TABLE relationships(id int, firm_id int, name text) ON COMMIT DROP;
      CREATE TEMP TABLE people(id int, firm_id int, relationship_id int, first_name text, last_name text) ON COMMIT DROP;
      CREATE TEMP TABLE companies(id int, firm_id int, relationship_id int, company_name text, entity_type text) ON COMMIT DROP;
      INSERT INTO relationships VALUES (1,1,'Alpha'),(2,2,'Beta');
      INSERT INTO people VALUES (1,1,1,'Alpha','Person'),(2,2,1,'Foreign','Person'),(3,1,2,'Broken','Link');
      INSERT INTO companies VALUES (1,1,1,'Alpha Company','LLC'),(2,2,1,'Foreign Company','LLC'),(3,1,2,'Broken Company','LLC');
    `);
    const source = fs.readFileSync(require.resolve('../../server/routes/emma-chat'), 'utf8');
    const toolSource = source.slice(source.indexOf('async function executeEmmaTool('), source.indexOf('\n/**\n * Format a tool result'));
    const execute = vm.runInNewContext(toolSource + '\nexecuteEmmaTool', {pool: client, process: {env: {}}});
    const all = await execute('list_crm', {}, 1);
    assert.equal(all.relationships.length,1);
    assert.equal(all.relationships[0].name,'Alpha');
    assert.equal(Number(all.relationships[0].people_count),1);
    assert.equal(Number(all.relationships[0].company_count),1);
    assert.equal(all.people.length,2);
    assert.equal(all.people.find(p=>p.id===3).relationship,null);
    assert.equal(all.companies.length,2);
    assert.equal(all.companies.find(c=>c.id===3).relationship,null);
    for (const type of ['relationships','people','companies']) {
      const filtered = await execute('list_crm',{entity_type:type},1);
      assert.deepEqual(Object.keys(filtered),[type]);
      assert.equal(filtered[type].length,all[type].length);
    }
    const other = await execute('list_crm',{},2);
    assert.equal(other.relationships[0].name,'Beta');
    assert.equal(other.people[0].relationship,null);
    const empty = await execute('list_crm',{},999);
    assert.equal(Object.values(empty).flat().length,0);
    await client.query('ROLLBACK');
  } catch(e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
module.exports = {verifyChatCrm};
