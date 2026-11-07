// tests/e2e/agent-connections-contract.spec.js
// Lightweight source-level contract checks for staff-owned agent connections.
// Avoids mutating live connections or callback data in dev/prod-like databases.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Staff-owned agent connection contracts', () => {
  test('management routes require a staff JWT and reject API-token-only auth', () => {
    const source = readRepoFile('server/routes/agent-connections.js');

    expect(source).toContain('function requireStaffJwt(req, res, next)');
    expect(source).toContain('req.firm?.isApiToken');
    expect(source).toContain('Agent connections require staff user authentication, not API-token-only auth');
    expect(source).toContain("router.get('/mine'");
    expect(source).toContain("router.post('/mine'");
    expect(source).toContain("router.patch('/mine/status'");
  });

  test('callback contract uses per-connection token before storing inbox drafts', () => {
    const source = readRepoFile('server/routes/agent-callbacks.js');
    const tokenReadIndex = source.indexOf("req.headers['x-darklion-agent-token']");
    const lookupIndex = source.indexOf('WHERE callback_token_hash = $1');
    const connectedGuardIndex = source.indexOf("connection.status !== 'connected'");
    const threadScopeIndex = source.indexOf('WHERE id = $1 AND firm_id = $2 AND staff_user_id = $3');
    const storeIndex = source.indexOf('storeMessageDraft({');

    expect(tokenReadIndex).toBeGreaterThan(-1);
    expect(lookupIndex).toBeGreaterThan(tokenReadIndex);
    expect(connectedGuardIndex).toBeGreaterThan(lookupIndex);
    expect(threadScopeIndex).toBeGreaterThan(connectedGuardIndex);
    expect(storeIndex).toBeGreaterThan(threadScopeIndex);
    expect(source).toContain("router.post('/inbox-draft'");
    expect(source).toContain('res.status(201).json({ ok: true, draft_id: draft.id })');
  });

  test('public callback mount remains before requireFirm-protected agent connection routes', () => {
    const source = readRepoFile('server/index.js');
    const requireTokenIndex = source.indexOf("app.use('/api', requireToken)");
    const callbackMountIndex = source.indexOf("app.use('/api/agent-callbacks', apiLimiter, agentCallbacksRouter)");
    const requireFirmApiIndex = source.indexOf("app.use('/api', requireFirm, apiLimiter, apiRouter)");
    const connectionsMountIndex = source.indexOf("app.use('/api/agent-connections', requireFirm, apiLimiter, agentConnectionsRouter)");

    expect(requireTokenIndex).toBeGreaterThan(-1);
    expect(callbackMountIndex).toBeGreaterThan(requireTokenIndex);
    expect(requireFirmApiIndex).toBeGreaterThan(callbackMountIndex);
    expect(connectionsMountIndex).toBeGreaterThan(requireFirmApiIndex);
  });

  test('API docs include agent connection management and callback endpoints', () => {
    const source = readRepoFile('server/views/api-docs.ejs');

    expect(source).toContain('Staff-Owned Agent Connections');
    expect(source).toContain('/api/agent-connections/mine');
    expect(source).toContain('/api/agent-connections/mine/status');
    expect(source).toContain('/api/agent-callbacks/inbox-draft');
    expect(source).toContain('X-DarkLion-Agent-Token');
    expect(source).toContain('/api/agent-connections/drafts/:threadId');
  });
});
