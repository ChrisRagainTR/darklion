'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Portal invite login preservation', () => {
  test('shared invite service leaves established portal credentials active', () => {
    const source = readRepoFile('server/services/portalAccess.js');
    const functionStart = source.indexOf('async function sendPortalInviteForPerson');
    const functionEnd = source.indexOf('\nfunction normalizeEmail', functionStart);
    const inviteFunction = source.slice(functionStart, functionEnd);
    const activeGuard = inviteFunction.indexOf('if (enabled && hasPassword)');
    const disablingUpdate = inviteFunction.indexOf('portal_enabled = false');

    expect(activeGuard).toBeGreaterThan(-1);
    expect(disablingUpdate).toBeGreaterThan(activeGuard);
    expect(inviteFunction.slice(activeGuard, disablingUpdate)).toContain("status: 'active'");
  });

  test('Emma uses the guarded shared invite service', () => {
    const source = readRepoFile('server/routes/emma-chat.js');
    const caseStart = source.indexOf("case 'send_portal_invite'");
    const caseEnd = source.indexOf("case 'create_tax_delivery'", caseStart);
    const inviteCase = source.slice(caseStart, caseEnd);

    expect(inviteCase).toContain('sendPortalInviteForPerson({');
    expect(inviteCase).not.toContain('portal_enabled = false');
  });
});
