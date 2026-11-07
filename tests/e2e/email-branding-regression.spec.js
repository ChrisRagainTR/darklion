// tests/e2e/email-branding-regression.spec.js
// Regression coverage for firm-logo branding in transactional emails.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function findCallBlocks(source, functionName) {
  const blocks = [];
  let idx = 0;
  const needle = `${functionName}({`;
  while ((idx = source.indexOf(needle, idx)) !== -1) {
    const before = source.slice(Math.max(0, idx - 40), idx);
    if (before.includes(`async function ${functionName}`)) {
      idx += needle.length;
      continue;
    }
    const start = source.indexOf('{', idx);
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    blocks.push({ line: source.slice(0, idx).split('\n').length, block: source.slice(idx, end + 1) });
    idx = end + 1;
  }
  return blocks;
}

test.describe('Transactional email firm branding', () => {
  test('email service resolves settings logo through stable public firm-logo URL', () => {
    const source = readRepoFile('server/services/email.js');

    expect(source).toContain('async function getFirmLogoUrl(firmId)');
    expect(source).toContain('SELECT logo_url FROM firms WHERE id = $1');
    expect(source).toContain('/portal-auth/firm-logo/${firmId}');
    expect(source).toContain('const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null)');
    expect(source).toContain('<img src="${logoUrl}"');
  });

  test('all transactional email callers pass firmId so settings logo can render', () => {
    const files = [
      'server/services/portalAccess.js',
      'server/routes/messages.js',
      'server/routes/people.js',
      'server/routes/portal-auth.js',
      'server/routes/bulk-send.js',
      'server/routes/tax-delivery.js',
      'server/services/pipelineActions.js',
      'server/scheduler.js',
      'server/routes/bookkeeper.js',
      'server/routes/emma-chat.js',
    ];
    const emailFunctions = [
      'sendPortalInvite',
      'sendPortalNotification',
      'sendPasswordReset',
      'sendStatementReminder',
      'sendBookkeepingQuestionsNotification',
      'sendBookkeepingQuestionsReminder',
    ];

    const missing = [];
    for (const file of files) {
      const source = readRepoFile(file);
      for (const fn of emailFunctions) {
        for (const call of findCallBlocks(source, fn)) {
          if (!call.block.includes('firmId')) missing.push(`${file}:${call.line} ${fn}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
