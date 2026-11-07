'use strict';

/**
 * Generate a PDF by navigating to a URL with Puppeteer.
 * Uses system Chromium on Railway (via PUPPETEER_EXECUTABLE_PATH env var),
 * falls back to Puppeteer's bundled Chromium locally.
 */
async function generatePDF(htmlContent, pageUrl) {
  const puppeteer = require('puppeteer');

  const launchOptions = {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
  };

  // Use system Chromium if specified (Railway Docker build)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const browser = await puppeteer.launch(launchOptions);

  const page = await browser.newPage();
  try {
    if (pageUrl) {
      await page.goto(pageUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      await page.waitForSelector('#loe-document', { timeout: 15000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    } else if (htmlContent) {
      // In-memory HTML has no navigation lifecycle to justify networkidle0,
      // which can hang on modern Chromium even after the document is ready.
      await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 1000));
    }

    const pdf = await page.pdf({
      format: 'Letter',
      margin: { top: '0.75in', bottom: '0.75in', left: '0.85in', right: '0.85in' },
      printBackground: true,
      displayHeaderFooter: false,
    });

    return pdf;
  } finally {
    await browser.close();
  }
}

module.exports = { generatePDF };
