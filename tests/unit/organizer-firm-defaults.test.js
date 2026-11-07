'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('organizers only mark payers the firm configured as firm-provided', () => {
  process.env.ORGANIZER_FIRM_PROVIDES_PAYERS = 'Example Custodian, Alpiinrok';
  delete require.cache[require.resolve('../../server/services/organizerParser')];
  const { flagFirmProvidedItems } = require('../../server/services/organizerParser');
  const items = [
    { section: '1099', payerName: 'Example Custodian' },
    { section: '1099', payerName: 'Alpiinrok' },
    { section: 'k1', payerName: 'Own Company LLC' },
  ];
  assert.deepEqual(flagFirmProvidedItems(items, ['Own Company LLC']).map(i=>i.sentinel_provides), [false,false,true]);
  assert.deepEqual(flagFirmProvidedItems(items, [], true).map(i=>i.sentinel_provides), [true,true,false]);
  delete process.env.ORGANIZER_FIRM_PROVIDES_PAYERS;
});
