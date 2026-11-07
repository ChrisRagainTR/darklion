'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function compact(source) {
  return source.replace(/\s+/g, ' ');
}

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  expect(start, `missing start marker ${startNeedle}`).toBeGreaterThan(-1);
  const end = endNeedle ? source.indexOf(endNeedle, start + startNeedle.length) : source.length;
  expect(end, `missing end marker ${endNeedle}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

test.describe('Team archive regression', () => {
  test('archived firm users are excluded from the active Team list', () => {
    const firmsRoute = readRepoFile('server/routes/firms.js');
    const listTeam = compact(between(firmsRoute, "router.get('/team'", "// --- GET /firms/team/:userId/invite-link ---"));
    const archiveTeamMember = compact(between(firmsRoute, "router.delete('/team/:userId'", "// --- POST /firms/team/:userId/set-password ---"));

    expect(listTeam).toContain('FROM firm_users WHERE firm_id = $1 AND archived_at IS NULL');
    expect(listTeam).not.toContain('ORDER BY archived_at NULLS FIRST');
    expect(archiveTeamMember).toContain('UPDATE firm_users SET archived_at = NOW()');
  });
});
