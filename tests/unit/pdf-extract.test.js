'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPageWithLayout } = require('../../server/services/pdfExtract');

test('page renderer preserves text and positional items', async () => {
  const result = await renderPageWithLayout({
    view: [0, 0, 612, 792],
    getTextContent: async () => ({
      items: [
        { str: '24', transform: [1, 0, 0, 1, 96, 535.5] },
        { str: 'Total tax', transform: [1, 0, 0, 1, 120, 535.5] },
        { str: '66,693', transform: [1, 0, 0, 1, 547, 535] },
      ],
    }),
  }, 2);

  assert.equal(result.text, '24Total tax\n66,693');
  assert.deepEqual(result.page, {
    number: 2,
    width: 612,
    height: 792,
    items: [
      { x: 96, y: 535.5, text: '24' },
      { x: 120, y: 535.5, text: 'Total tax' },
      { x: 547, y: 535, text: '66,693' },
    ],
  });
});
