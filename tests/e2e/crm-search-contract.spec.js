'use strict';

const { test, expect } = require('@playwright/test');
const { boundedLimit, likePattern, searchFirmCrm } = require('../../server/services/crmSearch');

test.describe('firm CRM search contract', () => {
  test('escapes wildcard input and bounds result limits', () => {
    expect(likePattern('Smith_100%')).toBe('%Smith\\_100\\%%');
    expect(boundedLimit(10)).toBe(10);
    expect(boundedLimit(100)).toBe(25);
    expect(boundedLimit('bad')).toBe(5);
  });

  test('searches relationships, linked people, and companies within one firm', async () => {
    const calls = [];
    const rows = [
      [{ id: 1, name: 'Smith Household', type: 'relationship' }],
      [{ id: 2, name: 'Smith LLC', type: 'company' }],
      [{ id: 3, name: 'Alex Smith', type: 'person' }],
    ];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: rows[calls.length - 1] };
    } };

    const result = await searchFirmCrm({ firmId: 77, query: 'Smith_%', limit: 99, db });

    expect(result).toEqual({ relationships: rows[0], companies: rows[1], people: rows[2] });
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.params).toEqual([77, '%Smith\\_\\%%', 25]);
    expect(calls[0].sql).toContain('EXISTS');
    expect(calls[0].sql).toContain('FROM people p');
    expect(calls[0].sql).toContain('FROM companies c');
    expect(calls[1].sql).toContain('c.firm_id = $1');
    expect(calls[2].sql).toContain('p.firm_id = $1');
  });
});
