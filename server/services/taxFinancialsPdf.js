'use strict';

/**
 * Generate a tax financials PDF for a company:
 * - Title page (company name, tax year, date generated)
 * - P&L (cash basis, full year)
 * - Balance Sheet (as of Dec 31)
 * - Trial Balance (as of Dec 31)
 */

const { qbFetch } = require('./quickbooks');
const { generatePDF } = require('./pdf');
const { downloadFile } = require('./s3');
const { pool } = require('../db');

function fmt(val) {
  const n = parseFloat(val);
  if (isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? `(${abs})` : abs;
}

function renderQBTable(reportData, title) {
  if (!reportData || !reportData.Rows) return `<p class="no-data">No data available</p>`;

  const rows = reportData.Rows.Row || [];

  function renderRow(row, depth = 0) {
    if (!row) return '';
    const pad = depth * 16;

    // Section header
    if (row.type === 'Section' || row.Header || row.Summary) {
      let html = '';
      if (row.Header && row.Header.ColData) {
        const label = row.Header.ColData[0]?.value || '';
        if (label) html += `<tr class="section-header"><td style="padding-left:${pad}px">${label}</td><td></td></tr>`;
      }
      if (row.Rows && row.Rows.Row) {
        const children = Array.isArray(row.Rows.Row) ? row.Rows.Row : [row.Rows.Row];
        children.forEach(r => { html += renderRow(r, depth + 1); });
      }
      if (row.Summary && row.Summary.ColData) {
        const label = row.Summary.ColData[0]?.value || '';
        const amount = row.Summary.ColData[row.Summary.ColData.length - 1]?.value || '';
        if (label) html += `<tr class="section-total"><td style="padding-left:${pad}px"><strong>${label}</strong></td><td class="amount"><strong>${fmt(amount)}</strong></td></tr>`;
      }
      return html;
    }

    // Data row
    if (row.ColData) {
      const label = row.ColData[0]?.value || '';
      const amount = row.ColData[row.ColData.length - 1]?.value || '';
      if (!label) return '';
      return `<tr class="data-row"><td style="padding-left:${pad}px">${label}</td><td class="amount">${fmt(amount)}</td></tr>`;
    }

    return '';
  }

  const rowsArr = Array.isArray(rows) ? rows : [rows];
  return `
    <table class="financial-table">
      <thead><tr><th>${title}</th><th class="amount">Amount</th></tr></thead>
      <tbody>${rowsArr.map(r => renderRow(r)).join('')}</tbody>
    </table>`;
}

// Lighten a hex color by mixing with white — used for dark backgrounds
function lightenColor(hex, amount = 0.45) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);
  const lr = Math.round(r + (255 - r) * amount);
  const lg = Math.round(g + (255 - g) * amount);
  const lb = Math.round(b + (255 - b) * amount);
  return `#${lr.toString(16).padStart(2,'0')}${lg.toString(16).padStart(2,'0')}${lb.toString(16).padStart(2,'0')}`;
}

// Determine if a hex color is "dark" (luminance < 0.35)
function isDark(hex) {
  const c = hex.replace('#', '');
  const r = parseInt(c.substring(0, 2), 16) / 255;
  const g = parseInt(c.substring(2, 4), 16) / 255;
  const b = parseInt(c.substring(4, 6), 16) / 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum < 0.35;
}

function buildHtml({ companyName, taxYear, entityType, generatedAt, pnl, bs, tb, logoDataUrl, firmDisplayName, primaryColor }) {
  const dateStr = new Date(generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = new Date(generatedAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const rawColor = (primaryColor || '#c9a84c').trim();
  // On the dark title page background, if the brand color is too dark, lighten it significantly
  const titleAccentColor = isDark(rawColor) ? lightenColor(rawColor, 0.55) : rawColor;
  // On white report pages, use the raw color (or slightly darkened if too light)
  const brandColor = rawColor;
  const firmName = String(firmDisplayName || 'Your firm').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 10pt; color: #1a1a2e; background: #fff; }

  /* Title page */
  .title-page {
    page-break-after: always;
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    min-height: 100vh; text-align: center; padding: 60px 40px;
    background: linear-gradient(135deg, #0f0f23 0%, #1a1a3e 100%);
    color: #fff;
    color: #fff;
  }
  .title-logo {
    font-size: 11pt; font-weight: 700; letter-spacing: 0.15em;
    text-transform: uppercase; color: ${titleAccentColor}; margin-bottom: 60px;
  }
  .title-logo span { color: rgba(255,255,255,0.5); }
  .title-logo img { max-height: 64px; max-width: 240px; object-fit: contain; }
  .title-company { font-size: 28pt; font-weight: 700; margin-bottom: 12px; line-height: 1.2; }
  .title-year { font-size: 18pt; color: ${titleAccentColor}; font-weight: 600; margin-bottom: 8px; }
  .title-subtitle { font-size: 11pt; color: rgba(255,255,255,0.6); margin-bottom: 60px; }
  .title-divider { width: 60px; height: 2px; background: ${titleAccentColor}; margin: 0 auto 60px; }
  .title-meta { font-size: 9pt; color: rgba(255,255,255,0.65); line-height: 1.8; }
  .title-meta strong { color: #ffffff; }

  /* Report sections */
  .report-section {
    padding: 40px 50px;
    page-break-inside: avoid;
  }
  .report-section + .report-section {
    page-break-before: always;
  }
  .report-title {
    font-size: 14pt; font-weight: 700; color: #1a1a3e;
    border-bottom: 2px solid ${brandColor};
    padding-bottom: 8px; margin-bottom: 6px;
  }
  .report-subtitle {
    font-size: 8.5pt; color: #666; margin-bottom: 24px;
  }

  /* Tables */
  .financial-table { width: 100%; border-collapse: collapse; }
  .financial-table thead tr { background: #1a1a3e; color: #fff; }
  .financial-table thead th { padding: 8px 12px; font-size: 9pt; text-align: left; font-weight: 600; }
  .financial-table thead th.amount { text-align: right; }
  .financial-table tbody tr { border-bottom: 1px solid #f0f0f0; }
  .financial-table tbody tr:last-child { border-bottom: none; }
  .section-header td { padding: 10px 12px 4px; font-size: 8pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #666; background: #f8f8f8; }
  .section-total td { padding: 6px 12px; background: #f0f0f0; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; }
  .data-row td { padding: 5px 12px; }
  .amount { text-align: right; font-variant-numeric: tabular-nums; }
  .no-data { color: #999; font-style: italic; padding: 20px 0; }

  /* Footer */
  @page { margin: 0.5in; }
</style>
</head>
<body>

<!-- TITLE PAGE -->
<div class="title-page">
  <div class="title-logo">
    ${logoDataUrl
      ? `<img src="${logoDataUrl}" alt="${firmName}">`
      : `<span style="color:${titleAccentColor};font-size:11pt;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;">${firmName}</span>`
    }
  </div>
  <div class="title-company">${companyName}</div>
  <div class="title-year">${taxYear} Tax Year</div>
  <div class="title-subtitle">Year-End Financial Statements &mdash; Cash Basis</div>
  <div class="title-divider"></div>
  <div class="title-meta">
    <strong>Entity Type:</strong> ${entityType || 'Not specified'}<br>
    <strong>Basis:</strong> Cash<br>
    <strong>Period:</strong> January 1, ${taxYear} &ndash; December 31, ${taxYear}<br>
    <strong>Prepared:</strong> ${dateStr} at ${timeStr}<br>
    <strong>Prepared by:</strong> ${firmName}
  </div>
</div>

<!-- P&L -->
<div class="report-section">
  ${logoDataUrl ? `<div style="text-align:right;margin-bottom:12px;"><img src="${logoDataUrl}" style="max-height:32px;max-width:140px;object-fit:contain;opacity:0.85;"></div>` : ''}
  <div class="report-title">Profit &amp; Loss</div>
  <div class="report-subtitle">For the year ended December 31, ${taxYear} &mdash; Cash Basis</div>
  ${renderQBTable(pnl, 'Account')}
</div>

<!-- BALANCE SHEET -->
<div class="report-section">
  ${logoDataUrl ? `<div style="text-align:right;margin-bottom:12px;"><img src="${logoDataUrl}" style="max-height:32px;max-width:140px;object-fit:contain;opacity:0.85;"></div>` : ''}
  <div class="report-title">Balance Sheet</div>
  <div class="report-subtitle">As of December 31, ${taxYear} &mdash; Cash Basis</div>
  ${renderQBTable(bs, 'Account')}
</div>

<!-- TRIAL BALANCE -->
<div class="report-section">
  ${logoDataUrl ? `<div style="text-align:right;margin-bottom:12px;"><img src="${logoDataUrl}" style="max-height:32px;max-width:140px;object-fit:contain;opacity:0.85;"></div>` : ''}
  <div class="report-title">Trial Balance</div>
  <div class="report-subtitle">As of December 31, ${taxYear} &mdash; Cash Basis</div>
  ${renderQBTable(tb, 'Account')}
</div>

</body>
</html>`;
}

async function generateTaxFinancialsPdf({ realmId, companyName, entityType, taxYear, firmId }) {
  const year = parseInt(taxYear) || new Date().getFullYear() - 1;
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const generatedAt = new Date().toISOString();

  // Fetch QBO reports + firm branding in parallel
  const [pnlRes, bsRes, tbRes, firmRes] = await Promise.allSettled([
    qbFetch(realmId, `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&accounting_method=Cash&summarize_column_by=Total&minorversion=75`),
    qbFetch(realmId, `/reports/BalanceSheet?start_date=${endDate}&end_date=${endDate}&accounting_method=Cash&minorversion=75`),
    qbFetch(realmId, `/reports/TrialBalance?start_date=${endDate}&end_date=${endDate}&accounting_method=Cash&minorversion=75`),
    firmId ? pool.query("SELECT COALESCE(NULLIF(display_name, ''), name) AS display_name, logo_url, primary_color FROM firms WHERE id = $1", [firmId]) : Promise.resolve(null),
  ]);

  const pnl = pnlRes.status === 'fulfilled' ? pnlRes.value : null;
  const bs  = bsRes.status  === 'fulfilled' ? bsRes.value  : null;
  const tb  = tbRes.status  === 'fulfilled' ? tbRes.value  : null;

  // Firm branding
  let logoDataUrl = null;
  let firmDisplayName = null;
  let primaryColor = null;

  if (firmRes.status === 'fulfilled' && firmRes.value?.rows?.[0]) {
    const firm = firmRes.value.rows[0];
    firmDisplayName = firm.display_name;
    primaryColor = firm.primary_color;

    if (firm.logo_url && !firm.logo_url.startsWith('http')) {
      // It's an S3 key — download and convert to base64 data URL
      try {
        const logoBuffer = await downloadFile({ key: firm.logo_url, bucket: process.env.AWS_S3_BUCKET });
        const ext = firm.logo_url.split('.').pop().toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'svg' ? 'image/svg+xml' : 'image/jpeg';
        logoDataUrl = `data:${mime};base64,${logoBuffer.toString('base64')}`;
      } catch (e) {
        console.warn('[taxFinancialsPdf] Could not load firm logo:', e.message);
      }
    } else if (firm.logo_url?.startsWith('http')) {
      // Already a URL — fetch it
      try {
        const resp = await fetch(firm.logo_url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const ct = resp.headers.get('content-type') || 'image/png';
        logoDataUrl = `data:${ct};base64,${buf.toString('base64')}`;
      } catch (e) {
        console.warn('[taxFinancialsPdf] Could not fetch firm logo URL:', e.message);
      }
    }
  }

  const html = buildHtml({ companyName, taxYear: year, entityType, generatedAt, pnl, bs, tb, logoDataUrl, firmDisplayName, primaryColor });
  const pdfBuffer = await generatePDF(html);

  return { pdfBuffer, generatedAt, year };
}

module.exports = { generateTaxFinancialsPdf };
