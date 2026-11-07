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

test.describe('Archived staff auth regression', () => {
  test('archived staff cannot log in, reset password, accept invites, or keep using old JWTs', () => {
    const firmsRoute = compact(readRepoFile('server/routes/firms.js'));
    const requireFirm = compact(readRepoFile('server/middleware/requireFirm.js'));
    const login = between(firmsRoute, "router.post('/login'", "// --- POST /firms/forgot-password ---");
    const forgot = between(firmsRoute, "router.post('/forgot-password'", "// --- POST /firms/reset-password/:token ---");
    const reset = between(firmsRoute, "router.post('/reset-password/:token'", "// --- GET /firms/me ---");
    const inviteLookup = between(firmsRoute, "router.get('/invite-lookup/:token'", "// --- POST /invite/:token/accept");
    const inviteAccept = between(firmsRoute, "router.post('/invite-lookup/:token/accept'", "// --- POST /firms/team/:userId/avatar ---");

    expect(compact(login)).toContain('WHERE fu.email = $1 AND fu.archived_at IS NULL');
    expect(compact(forgot)).toContain('AND fu.archived_at IS NULL AND fu.accepted_at IS NOT NULL');
    expect(compact(reset)).toContain('WHERE fu.invite_token = $1 AND fu.archived_at IS NULL AND fu.accepted_at IS NOT NULL');
    expect(compact(inviteLookup)).toContain('WHERE fu.invite_token = $1 AND fu.archived_at IS NULL');
    expect(compact(inviteAccept)).toContain('WHERE fu.invite_token = $1 AND fu.archived_at IS NULL');

    expect(requireFirm).toContain('async function requireFirm');
    expect(requireFirm).toContain('AND accepted_at IS NOT NULL AND archived_at IS NULL');
    expect(requireFirm).toContain("Staff account is inactive");
  });

  test('staff pickers and scoped API-token assignments exclude archived staff', () => {
    const firmsRoute = compact(readRepoFile('server/routes/firms.js'));
    const requireToken = compact(readRepoFile('server/middleware/requireToken.js'));
    const index = compact(readRepoFile('server/index.js'));
    const summariesRoute = compact(readRepoFile('server/routes/summaries.js'));
    const emmaChatRoute = compact(readRepoFile('server/routes/emma-chat.js'));
    const setPassword = between(firmsRoute, "router.post('/team/:userId/set-password'", "// --- PUT /firms/team/:userId/role ---");
    const apiTokenCreate = between(firmsRoute, "router.post('/api-tokens'", "// PATCH /firms/api-tokens/:id");
    const apiTokenPatch = between(firmsRoute, "router.patch('/api-tokens/:id'", "// DELETE /firms/api-tokens/:id");
    const staffList = between(firmsRoute, "router.get('/staff'", "// ── GET /firms/branding");

    expect(compact(setPassword)).toContain('SELECT id, email FROM firm_users WHERE id=$1 AND firm_id=$2 AND archived_at IS NULL');
    expect(compact(setPassword)).not.toContain('archived_at=NULL');
    expect(compact(apiTokenCreate)).toContain('accepted_at IS NOT NULL AND archived_at IS NULL');
    expect(compact(apiTokenPatch)).toContain('accepted_at IS NOT NULL AND archived_at IS NULL');
    expect(compact(staffList)).toContain('WHERE firm_id = $1 AND accepted_at IS NOT NULL AND archived_at IS NULL');
    expect(requireToken).toContain('fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL');
    expect(requireToken).toContain('API token staff scope is inactive');
    expect(index).toContain('WHERE firm_id = $1 AND accepted_at IS NOT NULL AND archived_at IS NULL ORDER BY name ASC');
    expect(summariesRoute).toContain('accepted_at IS NOT NULL AND archived_at IS NULL');
    expect(emmaChatRoute.match(/accepted_at IS NOT NULL AND archived_at IS NULL/g) || []).toHaveLength(3);
  });
});
