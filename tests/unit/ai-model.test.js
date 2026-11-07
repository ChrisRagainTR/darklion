'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');

test('legacy AI features are pinned to Haiku 4.5, regardless of legacy draft overrides', () => {
  const actual = execFileSync(process.execPath, ['-e',
    "process.stdout.write(require('./server/services/aiModel').AI_MODEL)"], {
    cwd: root, env: { ...process.env, EMMA_DRAFT_MODEL: 'claude-sonnet-4-6' }, encoding: 'utf8',
  });
  assert.equal(actual, 'claude-haiku-4-5-20251001');
});

test('every Anthropic call site uses the shared model policy', () => {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (file.endsWith('.js')) files.push(file);
    }
  }
  walk(path.join(root, 'server'));
  let calls = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (file.endsWith('/aiModel.js')) continue;
    assert.doesNotMatch(source, /['"]claude-[^'"]+['"]/, file);
    if (!source.includes('@anthropic-ai/sdk')) continue;
    const sites = [...source.matchAll(/\.messages\.(?:create|stream)\(\{\s*model:\s*([^,\n]+)/g)];
    const allCalls = [...source.matchAll(/\.messages\.(?:create|stream)\(/g)];
    assert.equal(sites.length, allCalls.length, `uncovered AI call in ${file}`);
    assert.match(source, /const \{ AI_MODEL \} = require\(['"][^'"]*aiModel['"]\)/, file);
    for (const site of sites) assert.equal(site[1], 'AI_MODEL', file);
    calls += sites.length;
  }
  assert.equal(calls, 2, 'covers remaining bookkeeping and managed fallback; staff chat uses Luna');
});
