// Local browser walk-through of every client tax state in the web portal, using sample data only.
// Usage: node tests/reliability/portal-states.cjs [screenshotDir]
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { assembleStatus, shapeDelivery } = require('../../server/services/clientTaxStatus');

const shotDir = process.argv[2] || null;
const TODAY = '2026-09-25';
const PERSON = 1;
const report = {
  client: { names: 'Jordan & Taylor Ellis', filing_status: 'Married filing jointly' },
  total_income: 262410, adjusted_gross_income: 248610, taxable_income: 208410, total_tax: 38215, tax_before_credits: 40215, credits: 2000,
  total_payments: 41697, refund_or_owed_amount: 3482, is_refund: true, effective_rate: 15.4, marginal_bracket: 24,
  income_sources: [{ source: 'Wages', amount: 168000 }, { source: 'Business income (Schedule C)', amount: 86410 }, { source: 'Dividends', amount: 8000 }],
  deductions: [{ name: 'Standard deduction', amount: 29200 }, { name: 'SEP-IRA contribution', amount: 14000 }],
  prior_year_comparison: { prior_tax_year: '2024', current_tax_year: '2025', items: [], highlights: [
    { title: 'Business income up $18,400', direction: 'increase' },
    { title: 'New SEP-IRA contribution of $14,000', direction: 'new' },
    { title: 'Home office deduction of $4,850', direction: 'new' },
  ] },
  estimated_payments_required: true,
  federal_estimated_payments: [{ quarter: '4th', due_date: 'January 15, 2027', amount: '$2,900' }],
  state_estimated_payments: [{ state: 'Georgia', quarter: '4th', due_date: 'January 15, 2027', amount: '$600' }],
};
const baseDelivery = {
  id: 7, firm_id: 1, company_id: null, company_name: null, tax_year: '2025', title: '2025 Tax Return', status: 'sent',
  intro_note: 'Jordan and Taylor, your 2025 return is ready. You are getting a federal refund this year, mostly thanks to the home office and retirement contributions we discussed.\n\nTake a look and let me know if you have questions.',
  tax_summary: { federal_amount: '3482', state_amount: '618', due_date: 'October 15, 2026' }, tax_report_data: report,
  review_doc_id: 91, signature_doc_id: 92, signed_doc_id: null, created_at: '2026-09-25T13:12:00Z', updated_at: '2026-09-25T13:12:00Z',
};
const t = s => new Date(s);
function signersFor(state) {
  const jordan = { delivery_id: 7, id: 1, person_id: PERSON, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', spouse_name: 'Taylor Ellis' };
  const taylor = { ...jordan, id: 2, signer_role: 'spouse' };
  if (state === 'sign') jordan.approved_at = t('2026-09-25T15:00:00Z');
  if (state === 'signed_waiting') Object.assign(jordan, { approved_at: t('2026-09-25T15:00:00Z'), signed_at: t('2026-09-25T15:05:00Z') });
  if (state === 'changes') Object.assign(jordan, { needs_changes_at: t('2026-09-26T20:18:00Z'), needs_changes_note: 'The home office should be 240 square feet, not 200. We also paid $1,100 to the daycare in December that I forgot to include.' });
  if (['signed', 'filed', 'accepted'].includes(state)) {
    for (const s of [jordan, taylor]) Object.assign(s, { approved_at: t('2026-09-25T15:00:00Z'), signed_at: t('2026-09-26T16:00:00Z') });
  }
  return [jordan, taylor];
}
const organizers = {
  ready: { id: 3, taxYear: '2025', status: 'pending', submittedAt: null, reopenNote: '', progress: { total: 14, resolved: 0 }, requestedItems: [] },
  progress: { id: 3, taxYear: '2025', status: 'in_progress', submittedAt: null, reopenNote: '', progress: { total: 14, resolved: 9 }, requestedItems: [] },
  reopened: { id: 3, taxYear: '2025', status: 'reopened', submittedAt: '2026-03-09T15:00:00Z', reopenNote: 'Thanks for submitting your organizer. Two items came up while preparing your return: Fidelity issued a corrected 1099, and we need your Q4 estimated payment confirmation.', progress: { total: 16, resolved: 14 }, requestedItems: [{ id: 1, name: 'Corrected 1099 — Fidelity Brokerage' }, { id: 2, name: 'Q4 2025 estimated payment confirmation' }] },
  submitted: { id: 3, taxYear: '2025', status: 'submitted', submittedAt: '2026-03-09T15:00:00Z', reopenNote: '', progress: { total: 14, resolved: 14 }, requestedItems: [] },
};
function scenario(name) {
  let rows = [], signers = [], organizer = null;
  const pastRow = { ...baseDelivery, id: 5, tax_year: '2024', status: 'signed', filed_at: '2025-04-11T15:00:00Z', accepted_at: '2025-04-12T15:00:00Z', signed_doc_id: 55, tax_report_data: null };
  const pastSigners = [{ delivery_id: 5, id: 9, person_id: PERSON, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', signed_at: t('2025-04-10T15:00:00Z') }];
  const withReturn = (state, extra = {}) => {
    const status = { review: 'sent', sign: 'sent', signed_waiting: 'sent', changes: 'needs_changes', signed: 'signed', filed: 'signed', accepted: 'signed' }[state];
    rows = [{ ...baseDelivery, status, needs_changes_note: state === 'changes' ? signersFor('changes')[0].needs_changes_note : '', filed_at: ['filed', 'accepted'].includes(state) ? '2026-10-02T15:00:00Z' : null, accepted_at: state === 'accepted' ? '2026-10-03T15:00:00Z' : null, signed_doc_id: ['signed', 'filed', 'accepted'].includes(state) ? 93 : null, ...extra }, pastRow];
    signers = [...signersFor(state), ...pastSigners];
    organizer = organizers.submitted;
  };
  switch (name) {
    case 'idle': rows = [pastRow]; signers = pastSigners; break;
    case 'organizer-ready': organizer = organizers.ready; rows = [pastRow]; signers = pastSigners; break;
    case 'organizer-progress': organizer = organizers.progress; rows = [pastRow]; signers = pastSigners; break;
    case 'more-documents': organizer = organizers.reopened; rows = [pastRow]; signers = pastSigners; break;
    case 'preparing': organizer = organizers.submitted; rows = [pastRow]; signers = pastSigners; break;
    case 'filed-legacy': withReturn('filed', { filed_date_known: false }); break;
    case 'business': withReturn('review'); rows.push({ ...baseDelivery, id: 8, company_id: 4, company_name: 'Ellis Design Studio LLC', status: 'signed', filed_at: '2026-09-12T15:00:00Z', accepted_at: '2026-09-14T15:00:00Z', tax_summary: {}, tax_report_data: null }); signers.push({ delivery_id: 8, id: 12, person_id: PERSON, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', signed_at: t('2026-09-10T15:00:00Z') }); break;
    default: withReturn(name);
  }
  const deliveries = rows.map(row => ({ row, view: shapeDelivery(row, signers, { personId: PERSON, signerRole: 'taxpayer' }) }));
  const status = assembleStatus({ person: { first_name: 'Jordan' }, taxYear: '2025', companies: [{ id: 4, company_name: 'Ellis Design Studio LLC' }], deliveries, organizer, today: TODAY });
  return { status, rows, signers };
}
function packetFor(sc, id) {
  const row = sc.rows.find(r => r.id === id);
  const signers = sc.signers.filter(s => s.delivery_id === id);
  const me = signers.find(s => s.person_id === PERSON && s.signer_role === 'taxpayer');
  const pdf = '/fixture-return.pdf';
  return {
    delivery: { id: row.id, companyId: row.company_id, companyName: row.company_name, taxYear: row.tax_year, title: row.title, introNote: row.intro_note, taxSummary: row.tax_summary, taxReportData: row.tax_report_data, status: row.status, needsChangesNote: row.needs_changes_note || '', filedAt: row.filed_at || null, acceptedAt: row.accepted_at || null, signedDocId: row.signed_doc_id, preparer: { name: 'Dana Whitfield', credentials: 'EA', avatarUrl: null }, createdAt: row.created_at, updatedAt: row.updated_at },
    currentSigner: me ? { id: me.id, personId: PERSON, signerRole: 'taxpayer', approvedAt: me.approved_at || null, signedAt: me.signed_at || null, needsChangesAt: me.needs_changes_at || null, needsChangesNote: me.needs_changes_note || '' } : null,
    signers: signers.map(s => ({ id: s.id, signerRole: s.signer_role, name: s.signer_role === 'spouse' ? s.spouse_name : s.first_name + ' ' + s.last_name, approvedAt: s.approved_at || null, signedAt: s.signed_at || null })),
    allowedActions: { canApprove: me && !me.approved_at, canRequestChanges: me && !me.needs_changes_at, canSign: me && me.approved_at && !me.signed_at },
    documents: { review: { name: '2025 Form 1040 — Review copy.pdf', signedUrl: pdf }, signature: { name: 'Form 8879 — IRS e-file signature authorization.pdf', signedUrl: pdf } },
    actionEndpoints: { approve: '/portal/tax-deliveries/' + id + '/approve', requestChanges: '/portal/tax-deliveries/' + id + '/needs-changes', sign: '/portal/tax-deliveries/' + id + '/sign' },
  };
}

module.exports = { scenario, packetFor };
if (require.main === module) (async () => {
  const pub = path.join(__dirname, '../../public');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/fixture-return.pdf') { res.setHeader('Content-Type', 'text/html'); return res.end('<body style="margin:0;font:14px Georgia;background:#fff;color:#222;padding:40px"><h2>Form 1040 — U.S. Individual Income Tax Return 2025</h2><p>Sample review copy (local test fixture).</p></body>'); }
    const file = path.join(pub, url.pathname === '/' ? 'portal.html' : decodeURIComponent(url.pathname));
    try { res.end(fs.readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
  }).listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const posted = [];

  async function open(name, { width = 1440, height = 1024 } = {}) {
    let sc = scenario(name);
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', e => errors.push(name + ': ' + e.message));
    await page.route('**/*', async route => {
      const u = new URL(route.request().url());
      const p = u.pathname;
      if (u.hostname !== '127.0.0.1') {
        if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(u.hostname)) return route.continue();
        if (p.includes('pusher')) return route.fulfill({ contentType: 'application/javascript', body: 'window.Pusher=class{subscribe(){return{bind(){}}}};' });
        return route.fulfill({ body: '' });
      }
      if (!(p.startsWith('/portal/') || p.startsWith('/portal-auth/'))) return route.continue();
      const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      const method = route.request().method();
      if (method === 'POST') {
        posted.push(name + ' ' + p + ' ' + (route.request().postData() || ''));
        const next = p.endsWith('/approve') ? 'sign' : p.endsWith('/sign') ? 'signed_waiting' : p.endsWith('/needs-changes') ? 'changes' : null;
        if (next) sc = scenario(next);
        return json({ ok: true });
      }
      if (p === '/portal/me') return json({ id: PERSON, firstName: 'Jordan', lastName: 'Ellis', email: 'jordan@example.invalid', filingStatus: 'MFJ', activeTaxYear: '2025', organizerVisible: true });
      if (p === '/portal/companies') return json([{ id: 4, company_name: 'Ellis Design Studio LLC' }]);
      if (p === '/portal/documents') return json([
        { id: 91, owner_type: 'person', owner_id: 1, display_name: '2025 Tax Return — Review copy.pdf', folder_section: 'firm_uploaded', folder_category: 'tax', year: '2025', delivered_at: '2026-09-25T13:12:00Z', viewed_at: '2026-09-25T14:00:00Z', mime_type: 'application/pdf', size_bytes: 4200000 },
        { id: 92, owner_type: 'person', owner_id: 1, display_name: 'Form 8879 — E-file authorization.pdf', folder_section: 'firm_uploaded', folder_category: 'tax', year: '2025', delivered_at: '2026-09-25T13:12:00Z', viewed_at: null, mime_type: 'application/pdf', size_bytes: 180000 },
        { id: 93, owner_type: 'person', owner_id: 1, display_name: 'W-2 Delta Air Lines.pdf', folder_section: 'client_uploaded', folder_category: 'tax', year: '2025', created_at: '2026-02-12T15:00:00Z', mime_type: 'application/pdf', size_bytes: 420000 },
        { id: 94, owner_type: 'person', owner_id: 1, display_name: 'Engagement letter 2025.pdf', folder_section: 'firm_uploaded', folder_category: 'engagement_letter', year: '2025', delivered_at: '2026-01-05T15:00:00Z', viewed_at: '2026-01-06T15:00:00Z', mime_type: 'application/pdf' },
        { id: 55, owner_type: 'person', owner_id: 1, display_name: '2024 Tax Return — Signed copy.pdf', folder_section: 'firm_uploaded', folder_category: 'tax', year: '2024', delivered_at: '2025-04-10T15:00:00Z', viewed_at: '2025-04-11T15:00:00Z', mime_type: 'application/pdf' },
        { id: 56, owner_type: 'person', owner_id: 1, display_name: '2023 Brokerage 1099 never opened.pdf', folder_section: 'firm_uploaded', folder_category: 'tax', year: '2023', delivered_at: '2024-03-01T15:00:00Z', viewed_at: null, mime_type: 'application/pdf' },
        { id: 71, owner_type: 'company', owner_id: 4, display_name: 'Chase Business Checking — August 2026.pdf', folder_section: 'client_uploaded', folder_category: 'bookkeeping', folder_subcategory: 'Chase Checking 4410', year: '2026', created_at: '2026-09-03T15:00:00Z', mime_type: 'application/pdf' },
        { id: 72, owner_type: 'company', owner_id: 4, display_name: '2025 Form 1120-S — Signed.pdf', folder_section: 'firm_uploaded', folder_category: 'tax', year: '2025', delivered_at: '2026-09-12T15:00:00Z', viewed_at: null, mime_type: 'application/pdf' },
      ]);
      if (p === '/portal/document-folders') return json([]);
      if (p === '/portal/messages') return json([{ id: 21, name: 'Dana Whitfield', credentials: 'EA', unreadCount: name === 'review' ? 1 : 0, lastPreview: 'Your return is ready. A few notes on the refund.' }, { id: 20, name: 'Alex Owner', credentials: 'CPA, CFP', unreadCount: 0 }]);
      if (p === '/portal/firm-team') return json([{ id: 20, name: 'Alex Owner', credentials: 'CPA, CFP', role: 'owner', avatar_url: null }, { id: 21, name: 'Dana Whitfield', credentials: 'EA', role: 'staff', avatar_url: null }]);
      if (p === '/portal/tax-status') return json(sc.status);
      const packet = p.match(/^\/portal\/mobile\/tax-deliveries\/(\d+)$/);
      if (packet) return json(packetFor(sc, Number(packet[1])));
      if (p.startsWith('/portal/companies/') && p.endsWith('/statements')) return json({ total_pending: 0 });
      if (/^\/portal\/documents\/\d+\/download$/.test(p)) return json({ url: '/fixture-return.pdf' });
      if (p === '/portal/investments') return json({ enabled: false });
      if (p === '/portal-auth/firm-info') return json({ firmName: 'Smith & Co. CPAs' });
      return json([]);
    });
    await page.addInitScript(() => localStorage.setItem('portalToken', 'test.' + btoa(JSON.stringify({ firmId: 1, personId: 1, name: 'Jordan Ellis' })) + '.test'));
    await page.goto(base);
    await page.waitForFunction(() => !document.body.classList.contains('portal-auth-pending'));
    await page.waitForFunction(() => window.PortalTax && window.PortalTax._state().status);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(250);
    return page;
  }
  const shot = async (page, file) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, file + '.png') }); };
  const text = page => page.locator('main').innerText();

  // Home in each season state
  const homes = {
    idle: /all caught up/, 'organizer-ready': /Complete your 2025 tax organizer/, 'organizer-progress': /9 of 14 items done/,
    'more-documents': /asked for more documents/, preparing: /Return in preparation/, review: /Review and sign your 2025 tax return/,
    signed_waiting: /waiting on Taylor/, changes: /Your change request/, filed: /e-filed on Oct 2, 2026/, accepted: /accepted\. You're all set/,
    'filed-legacy': /Your 2025 return was filed\./,
  };
  for (const [name, expected] of Object.entries(homes)) {
    const page = await open(name);
    assert.match(await text(page), expected, name);
    await shot(page, 'web-home-' + name);
    await page.close();
  }

  // Taxes page with personal and business returns
  let page = await open('business');
  // Home document links open the file in a new tab (the tab is opened during the click, so Safari allows it).
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#homeSections .list-button')]);
  await popup.waitForURL(/fixture-return\.pdf/);
  await popup.close();
  await page.click('.tab-btn[data-tab="taxes"]');
  const taxes = await text(page);
  assert.match(taxes, /Ellis Design Studio LLC — business return/);
  assert.match(taxes, /Accepted Sep 14, 2026/);
  assert.match(taxes, /Estimated payment reminders/);
  await shot(page, 'web-taxes-business');
  await page.close();

  page = await open('organizer-progress');
  await page.click('.tab-btn[data-tab="taxes"]');
  await shot(page, 'web-taxes-organizer');
  await page.close();

  // Full review → approve → sign walk-through, with the approve button gated on the checkbox
  page = await open('review');
  await page.click('.row-emph .btn');
  await page.waitForSelector('.figures');
  assert.match(await text(page), /Federal refund/);
  await shot(page, 'web-flow-summary');
  await page.click('text=Continue to review');
  await page.waitForSelector('.viewer-frame');
  assert.equal(await page.locator('#approveBtn').isDisabled(), true);
  await shot(page, 'web-flow-review');
  await page.check('#reviewedCheck');
  await page.click('#approveBtn');
  await page.waitForSelector('#sigCanvas');
  assert.equal(await page.locator('#signBtn').isDisabled(), true);
  const box = await page.locator('#sigCanvas').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 110); await page.mouse.down();
  for (let i = 0; i < 24; i++) await page.mouse.move(box.x + 60 + i * 18, box.y + 110 - Math.sin(i / 2) * 30);
  await page.mouse.up();
  await page.check('.check input');
  await shot(page, 'web-flow-sign');
  await page.click('#signBtn');
  await page.waitForSelector('.done-head');
  assert.match(await text(page), /Taylor Ellis still needs to sign/);
  await shot(page, 'web-flow-done');
  await page.close();
  assert.ok(posted.some(x => x.includes('/approve')) && posted.some(x => x.includes('/sign') && x.includes('"signature_type":"drawn"')));
  const signBody = posted.find(x => x.includes('/sign ') && x.includes('drawn'));
  assert.ok(signBody.length < 90000, 'drawn signature must stay under the 100 KB request limit: ' + signBody.length);

  // Change request path
  page = await open('review');
  await page.click('.row-emph .btn');
  await page.click('text=Continue to review');
  await page.click('text=Something needs to change');
  await page.fill('#changeNote', 'Home office should be 240 square feet.');
  await page.click('text=Send to your team');
  await page.waitForSelector('#tab-taxes h2:has-text("We\'re updating your return")');
  await shot(page, 'web-flow-changes');
  await page.close();

  // Narrow desktop: side column drops under the main column
  page = await open('review', { width: 1024, height: 900 });
  await shot(page, 'web-home-review-1024');
  // Existing sections keep working inside the new shell.
  await page.click('.tab-btn[data-tab="documents"]');
  await page.waitForTimeout(200);
  await shot(page, 'web-documents');
  // Stacked sections with year accordions; the year bar jumps both sections to one year.
  let docsText = await page.locator('#docsContainer').innerText();
  assert.match(docsText, /1 new from your team/, 'only files from the last 30 days count as new');
  assert.match(docsText, /Delivered by your team/); assert.match(docsText, /Uploaded by you/); assert.match(docsText, /Engagement letters/);
  assert.doesNotMatch(docsText, /Chase Business Checking/, 'business files stay in the business tab');
  assert.ok(await page.locator('#docsContainer-team .year-folder.open').count() >= 1, 'most recent year starts open');
  // Side by side, with year folders linked across the two columns.
  await page.setViewportSize({ width: 1440, height: 1024 });
  await shot(page, 'web-documents-side-by-side');
  const cols = await page.evaluate(() => [...document.querySelectorAll('.docs-columns > .docs-section')].map(e => Math.round(e.getBoundingClientRect().top)));
  assert.equal(cols.length, 2); assert.equal(cols[0], cols[1], 'team and client columns sit side by side');
  const mine2025 = () => page.locator('#docsContainer-mine .year-folder:has(> .year-header:has-text("2025"))').evaluate(e => e.classList.contains('open'));
  assert.equal(await mine2025(), true);
  await page.click('#docsContainer-team .year-header:has-text("2025")');
  assert.equal(await mine2025(), false, 'closing 2025 on one side closes it on the other');
  await page.click('#docsContainer-team .year-header:has-text("2025")');
  assert.equal(await page.locator('#docsContainer-team .year-folder:has(> .year-header:has-text("2024"))').evaluate(e => e.classList.contains('open')), false);
  await page.click('#docsContainer-team .year-header:has-text("2024")');
  assert.ok(await page.locator('#docsContainer-team .year-folder:has(> .year-header:has-text("2024"))').evaluate(e => e.classList.contains('open')));
  await page.click('.year-bar button:has-text("2025")');
  docsText = await page.locator('#docsContainer').innerText();
  assert.match(docsText, /Form 8879/); assert.match(docsText, /W-2 Delta/); assert.doesNotMatch(docsText, /2024 Tax Return/);
  await shot(page, 'web-documents-2025');
  await page.click('.year-bar button:has-text("All years")');
  await page.fill('#docsContainer-q', '8879');
  docsText = await page.locator('#docsContainer').innerText();
  assert.match(docsText, /Form 8879/); assert.doesNotMatch(docsText, /W-2 Delta/);
  await page.fill('#docsContainer-q', '');
  const docsWidth = await page.evaluate(() => document.getElementById('docsContainer').scrollWidth <= document.getElementById('docsContainer').clientWidth + 1);
  assert.ok(docsWidth, 'documents never overflow sideways');
  await page.click('.tab-btn[data-tab="messages"]');
  await page.waitForSelector('#chatContacts');
  await page.waitForTimeout(300);
  await shot(page, 'web-messages');
  await page.click('#company-tabs .tab-btn');
  await page.waitForTimeout(300);
  await shot(page, 'web-business');
  await page.close();

  // Old links to the retired tabs land on Taxes.
  page = await open('organizer-progress');
  await page.goto(base + '?tab=organizers');
  await page.waitForFunction(() => document.querySelector('.tab-btn[data-tab="taxes"]').classList.contains('active'));
  await page.close();

  assert.deepEqual(errors, []);
  console.log('PASS web portal states: 10 Home states, Taxes, review → approve → sign, change request; no runtime errors');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
