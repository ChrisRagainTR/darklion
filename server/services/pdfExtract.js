'use strict';
const pdfParse = require('pdf-parse');

// Strategy: extract the first 20 pages (core 1040 + schedules) PLUS the last 8 pages
// (comparison table + estimated payment vouchers are always near the end).
// This skips the middle worksheet pages (depreciation detail, AMT worksheets, etc.)
// that Claude doesn't need and only add noise.
const CORE_PAGES = 20;     // first N pages — main form + key schedules
const TAIL_PAGES = 8;      // last N pages — comparison + estimated payments
const MAX_CHARS = 80000;   // ~20k tokens — fast for Haiku

async function renderPageWithLayout(pageData, number) {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let lastY;
  let text = '';
  const items = [];

  for (const item of textContent.items || []) {
    const itemText = String(item.str || '');
    const x = Number(item.transform?.[4]);
    const y = Number(item.transform?.[5]);
    if (lastY === y || lastY === undefined) text += itemText;
    else text += `\n${itemText}`;
    lastY = y;
    if (itemText.trim() && Number.isFinite(x) && Number.isFinite(y)) {
      items.push({ x, y, text: itemText.trim() });
    }
  }

  const view = Array.isArray(pageData.view) ? pageData.view : [0, 0, 612, 792];
  return {
    text,
    page: {
      number,
      width: Math.abs(Number(view[2]) - Number(view[0])) || 612,
      height: Math.abs(Number(view[3]) - Number(view[1])) || 792,
      items,
    },
  };
}

async function extractPdfData(buffer) {
  const pages = [];
  let pageNumber = 0;
  const coreData = await pdfParse(buffer, {
    max: CORE_PAGES,
    pagerender: async pageData => {
      pageNumber += 1;
      const rendered = await renderPageWithLayout(pageData, pageNumber);
      pages.push(rendered.page);
      return rendered.text;
    },
  });
  const totalPages = coreData.numpages || 0;
  let text = coreData.text || '';

  // Extract tail pages (last 8) if the return is long enough.
  if (totalPages > CORE_PAGES + 2) {
    const tailStart = Math.max(totalPages - TAIL_PAGES + 1, CORE_PAGES + 1);
    // pdf-parse doesn't support page ranges natively, so we extract full and slice.
    // Only do this if the total is manageable.
    if (totalPages <= 60) {
      try {
        const fullData = await pdfParse(buffer);
        const fullText = fullData.text || '';
        const tailStartChar = Math.floor((fullText.length / totalPages) * (tailStart - 1));
        const tailText = fullText.substring(tailStartChar);
        text += '\n\n--- TAIL PAGES (comparison, estimated payments) ---\n\n' + tailText;
      } catch (e) { /* use core only */ }
    }
  }

  const trimmed = text.length > MAX_CHARS
    ? text.substring(0, MAX_CHARS) + '\n\n[TEXT TRUNCATED]'
    : text;

  return { text: trimmed, pages, numpages: totalPages };
}

async function extractPdfText(buffer) {
  const data = await extractPdfData(buffer);
  return data.text;
}

module.exports = { extractPdfText, extractPdfData, renderPageWithLayout };
