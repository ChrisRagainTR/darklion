// tests/e2e/agent-revenue-forecast-contract.spec.js
// Source and pure-calculation contracts for the Agent Work revenue forecast.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { buildMonthlyTotals } = require('../../server/services/revenueForecast');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test.describe('Agent revenue forecast contract', () => {
  test('agent route is read-only, capability-gated, and uses the shared forecast service', () => {
    const route = readRepoFile('server/routes/agent-work.js');

    expect(route).toContain('revenue_read: true');
    expect(route).toContain("router.get('/revenue-forecast', requireCapability('revenue_read')");
    expect(route).toContain('buildRevenueForecast({');
    expect(route).toContain("await audit(req, 'revenue_forecast_read'");
  });

  test('configured auth paths expose revenue_read explicitly', () => {
    const db = readRepoFile('server/db.js');
    const firms = readRepoFile('server/routes/firms.js');
    const connections = readRepoFile('server/routes/agent-connections.js');

    expect(db).toContain('"revenue_read":true');
    expect(firms).toContain('revenue_read: true');
    expect(connections).toContain('revenue_read: input?.revenue_read !== false');
  });

  test('monthly totals preserve collected, past-due, upcoming, and projected amounts', () => {
    const emptyMonths = () => Array.from({ length: 12 }, () => ({ status: 'none', amount: 0 }));
    const first = emptyMonths();
    const second = emptyMonths();
    first[0] = { status: 'paid', amount: 100 };
    first[1] = { status: 'upcoming', amount: 120 };
    second[0] = { status: 'past_due', amount: 50 };
    second[1] = { status: 'upcoming', amount: 80 };

    const totals = buildMonthlyTotals([{ months: first }, { months: second }], 2027);

    expect(totals).toHaveLength(12);
    expect(totals[0]).toEqual({
      month: '2027-01',
      collected: 100,
      past_due: 50,
      upcoming: 0,
      projected: 150,
    });
    expect(totals[1]).toEqual({
      month: '2027-02',
      collected: 0,
      past_due: 0,
      upcoming: 200,
      projected: 200,
    });
  });

  test('API docs and schema expose the endpoint and revenue capability', () => {
    const markdown = readRepoFile('docs/api-docs.md');
    const html = readRepoFile('server/views/api-docs.ejs');
    const openapi = readRepoFile('docs/openapi.json');

    for (const source of [markdown, html, openapi]) {
      expect(source).toContain('/api/agent-work/revenue-forecast');
      expect(source).toContain('revenue_read');
      expect(source).toContain('monthly_totals');
    }
    expect(openapi).toContain('"RevenueForecastResponse"');
  });
});
