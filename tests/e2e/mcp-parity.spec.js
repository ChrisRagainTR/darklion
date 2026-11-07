const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { getToolAccessCatalog } = require('../../server/mcp/tools');

const ROOT = path.join(__dirname, '..', '..');

test.describe('DarkLion MCP API parity', () => {
  test('exposes the complete supported-business MVP tool surface', () => {
    const tools = getToolAccessCatalog().map(tool => tool.name);
    expect(tools).toHaveLength(62);
    expect(new Set(tools).size).toBe(62);
    for (const required of [
      'darklion_search_crm', 'darklion_list_relationships', 'darklion_list_people',
      'darklion_list_documents', 'darklion_list_pipeline_jobs', 'darklion_get_my_work',
      'darklion_list_conversation_summaries', 'darklion_send_client_message',
      'darklion_get_bookkeeping_overview', 'darklion_list_tax_deliveries',
      'darklion_list_tax_organizers', 'darklion_list_proposals',
      'darklion_get_billing_config', 'darklion_get_person_investments',
      'darklion_list_engagement_letters', 'darklion_search_transactions',
    ]) expect(tools).toContain(required);
  });

  test('OpenAPI retains stable core operation IDs and declares the complete MCP contract', () => {
    const openapi = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/openapi.json'), 'utf8'));
    const operations = Object.values(openapi.paths).flatMap(pathItem =>
      Object.values(pathItem).map(operation => operation.operationId)
    );
    expect(operations).toHaveLength(17);
    expect(new Set(operations).size).toBe(17);
    expect(openapi['x-darklion-mcp']).toMatchObject({
      endpoint: 'https://darklion.ai/mcp',
      tool_count: 62,
      oauth_scopes: ['darklion:read', 'darklion:write', 'darklion:communicate'],
      business_domain_catalog: 'docs/mcp-business-domain-catalog.json',
    });
    for (const operationId of [
      'getAgentWorkStatus', 'listAgentWorkCompanies', 'searchAgentWorkCrm', 'getAgentWorkActivityLog',
      'getAgentWorkRevenueForecast', 'searchAgentWorkTransactions',
      'backfillAgentWorkTransactions', 'getAgentWorkInboxSummary',
      'listAgentWorkInboxThreads', 'getAgentWorkInboxThread',
      'createAgentWorkInboxDraft', 'getAgentWorkTeamChatSummary',
      'listAgentWorkTeamConversations', 'getAgentWorkTeamConversationMessages',
      'replyToAgentWorkTeamConversation',
    ]) expect(operations).toContain(operationId);
  });

  test('delegates to every canonical Agent Work route without forwarding OAuth tokens', () => {
    const tools = fs.readFileSync(path.join(ROOT, 'server/mcp/tools.js'), 'utf8');
    const client = fs.readFileSync(path.join(ROOT, 'server/mcp/apiClient.js'), 'utf8');
    for (const route of [
      '/status', '/companies', '/crm/search', '/activity-log', '/revenue-forecast',
      '/transactions/search', '/transactions/backfill', '/inbox/summary', '/inbox/threads',
      '/team-chat/summary', '/team-chat/conversations',
    ]) expect(tools).toContain(route);
    expect(client).toContain("'X-DarkLion-Internal-MCP': '1'");
    expect(client).toContain("issuer: 'darklion-mcp'");
    expect(client).toContain("audience: 'darklion-agent-work'");
    expect(client).not.toContain('principal.token');
  });

  test('mounts OAuth discovery and the protected MCP endpoint in the application', () => {
    const source = fs.readFileSync(path.join(ROOT, 'server/index.js'), 'utf8');
    const domainMiddleware = fs.readFileSync(path.join(ROOT, 'server/middleware/domainFirm.js'), 'utf8');
    expect(source).toContain("require('./routes/mcp-oauth')");
    expect(source).toContain("app.use('/', mcpOAuthRoutes.router)");
    expect(source).toContain("app.use('/mcp', apiLimiter, createDarkLionMcpRouter())");
    expect(fs.existsSync(path.join(ROOT, 'server/mcp.js'))).toBe(false);
    expect(domainMiddleware).not.toContain('mcpRouter');
  });
});
