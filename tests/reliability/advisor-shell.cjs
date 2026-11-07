// Renders real advisor pages with the shared shell, using sample API data, to check layout and runtime errors.
// Usage: node tests/reliability/advisor-shell.cjs [screenshotDir]
const { chromium } = require('playwright');
const express = require('express');
const path = require('path');
const assert = require('assert/strict');
const { assembleToday } = require('../../server/services/advisorToday');

const shotDir = process.argv[2] || null;
const root = path.join(__dirname, '../..');
const now = Date.now(), day = 86400000;
const s = (o = {}) => ({ person_id: 1, signer_role: 'taxpayer', first_name: 'Jordan', last_name: 'Ellis', spouse_name: 'Taylor Ellis', ...o });
const today = assembleToday({ taxYear: '2025', now, deliveries: [
  { id: 1, tax_year: '2025', status: 'signed', signers: [s({ signed_at: new Date(now - day) }), s({ signer_role: 'spouse', signed_at: new Date(now - day) })] },
  { id: 2, tax_year: '2025', status: 'signed', company_id: 9, company_name: 'Ellis Design Studio LLC', signers: [s({ signed_at: new Date(now - 2 * day) })] },
  { id: 3, tax_year: '2025', status: 'needs_changes', needs_changes_note: 'Home office is 240 sq ft, not 200', signers: [s({ person_id: 3, first_name: 'Maria', last_name: 'Ortiz', spouse_name: '', needs_changes_at: new Date(now - day) })] },
  { id: 4, tax_year: '2025', status: 'sent', sent_at: new Date(now - 6 * day), signers: [s({ person_id: 4, first_name: 'Kevin', last_name: 'Holt', spouse_name: '' })] },
  { id: 5, tax_year: '2025', status: 'sent', sent_at: new Date(now - 2 * day), last_reminded_at: new Date(now - 3600000), signers: [s({ person_id: 5, first_name: 'Ben', last_name: 'Shah', spouse_name: 'Priya Shah' }), s({ person_id: 5, signer_role: 'spouse', first_name: 'Ben', last_name: 'Shah', spouse_name: 'Priya Shah' })] },
  { id: 6, tax_year: '2025', status: 'signed', filed_at: new Date(now - 2 * day), signers: [s({ person_id: 6, first_name: 'Ana', last_name: 'Lopez', spouse_name: '', signed_at: new Date(now - 5 * day) })] },
  { id: 7, tax_year: '2025', status: 'signed', filed_at: new Date(now - 9 * day), accepted_at: new Date(now - 3 * day), signers: [s({ person_id: 7 })] },
], organizers: [
  ...Array.from({ length: 38 }, (_, i) => ({ id: i + 1, person_id: 100 + i, tax_year: '2025', status: i === 0 ? 'reopened' : 'in_progress', first_name: i === 0 ? 'Lopez' : 'P', last_name: i === 0 ? 'Family' : String(i), updated_at: new Date(now - 21 * day) })),
  ...Array.from({ length: 22 }, (_, i) => ({ id: 200 + i, person_id: 300 + i, tax_year: '2025', status: 'submitted', first_name: 'S', last_name: String(i) })),
] });
const threads = [
  { id: 11, first_name: 'Maria', last_name: 'Ortiz', unread_count: 1, last_body: 'Here are the updated square feet for the office.', last_message_at_sub: new Date(now - 3600000).toISOString() },
  { id: 12, first_name: 'Kevin', last_name: 'Holt', unread_count: 2, last_body: "I'll take a look this evening.", last_message_at_sub: new Date(now - day).toISOString() },
  { id: 13, first_name: 'Read', last_name: 'Thread', unread_count: 0, last_body: 'old' },
];
const work = { items: [
  { kind: 'pipeline_job', title: 'Review Ellis Design Studio return', entity: { name: 'Ellis Design Studio LLC' }, dueDate: '2026-09-28', link: '/crm/company/9' },
  { kind: 'task', title: 'Follow up with Ben & Priya', entity: { name: 'Ben Shah' }, dueDate: null, link: '/messages?thread=14' },
], counts: { total: 2, overdue: 0 } };

(async () => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(root, 'server/views'));
  const pages = { today: ['Today', 'today'], dashboard: ['Firm overview', 'dashboard'], crm: ['CRM', 'relationships'], messages: ['Inbox', 'messages'], 'my-work': ['My Work', 'my-work'], 'tax-season': ['Tax Season', 'tax-season'], pipelines: ['Pipelines', 'pipelines'], settings: ['Settings', 'settings'] };
  for (const [view, [title, nav]] of Object.entries(pages)) app.get('/' + view, (req, res) => res.render(view, { title, activeNav: nav }));
  app.get('/crm/person/:id', (req, res) => res.render('crm-person', { title: 'Person', activeNav: 'people' }));
  app.use(express.static(path.join(root, 'public'), { index: false }));
  const server = app.listen(0); const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const errors = {};
  const posts = [];
  const token = 'x.' + Buffer.from(JSON.stringify({ name: 'Alex Owner', firmName: 'Smith & Co. CPAs', userId: 20, firmId: 1 })).toString('base64') + '.y';

  async function visit(url, file) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1024 } });
    errors[file] = [];
    page.on('pageerror', e => errors[file].push(e.message));
    await page.route('**/*', route => {
      const u = new URL(route.request().url());
      if (u.hostname !== '127.0.0.1') {
        if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(u.hostname)) return route.continue();
        if (u.pathname.includes('pusher')) return route.fulfill({ contentType: 'application/javascript', body: 'window.Pusher=class{constructor(){this.connection={bind(){},state:"connected"}}subscribe(){return{bind(){},unbind(){}}}unsubscribe(){}bind(){}};' });
        return route.fulfill({ body: '' });
      }
      const p = u.pathname;
      const json = b => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
      if (route.request().method() === 'POST' && p.startsWith('/api/tax-deliveries/')) { posts.push(p + ' ' + route.request().postData()); return json({ ok: true, emailed: 1 }); }
      if (p === '/api/today') return json(today);
      if (p === '/api/messages') return json(threads);
      if (p === '/api/my-work') return json(work);
      if (p.endsWith('/unread-count')) return json({ count: 3, unread: 3 });
      if (p === '/api/my-work/count') return json({ total: 2, overdue: 0 });
      if (p.startsWith('/api/') || p.startsWith('/firms/')) return json(p.includes('/people/') ? { id: 1, first_name: 'Jordan', last_name: 'Ellis' } : []);
      return route.continue();
    });
    await page.addInitScript(t => localStorage.setItem('dl_token', t), token);
    await page.goto(base + url);
    await page.waitForTimeout(1200);
    await page.evaluate(() => document.fonts.ready);
    if (shotDir) await page.screenshot({ path: path.join(shotDir, file + '.png') });
    return page;
  }

  // Today: counts, groups, actions
  let page = await visit('/today', 'advisor-today');
  const t = await page.locator('.main').innerText();
  assert.match(t, /Good (morning|afternoon|evening), Chris/);
  assert.match(t, /2 returns are ready to e-file and 1 client asked for changes/);
  assert.match(t, /Ready to e-file/); assert.match(t, /Jordan & Taylor Ellis/); assert.match(t, /Ellis Design Studio LLC/);
  assert.match(t, /Waiting on Kevin to sign/); assert.match(t, /Asked for more documents/); assert.match(t, /Reminded/);
  assert.match(t, /Maria Ortiz/); assert.match(t, /Here are the updated square feet/); assert.doesNotMatch(t, /Read Thread/);
  assert.equal(await page.locator('.nav-item.active').innerText(), 'Today');
  await page.click('button[data-act="filed"]');
  await page.click('#td-g-waiting button[data-act="remind"]');
  await page.waitForTimeout(400);
  assert.ok(posts.some(x => x.includes('/efile') && x.includes('"filed"')) && posts.some(x => x.includes('/remind')));
  await page.close();

  // Existing pages still render inside the new shell
  for (const [url, file] of [['/crm', 'advisor-crm'], ['/crm/person/1', 'advisor-person'], ['/messages', 'advisor-messages'], ['/my-work', 'advisor-mywork'], ['/dashboard', 'advisor-dashboard'], ['/tax-season', 'advisor-taxseason'], ['/pipelines', 'advisor-pipelines'], ['/settings', 'advisor-settings']]) {
    page = await visit(url, file);
    assert.ok(await page.locator('#sidebar-el .nav-item').count() >= 14, url + ' has the sidebar');
    const overflow = await page.evaluate(() => document.querySelector('.main') && document.querySelector('.main').scrollWidth > document.querySelector('.main').clientWidth + 2);
    assert.equal(overflow, false, url + ' does not scroll sideways');
    await page.close();
  }
  await browser.close(); server.close();
  const withErrors = Object.entries(errors).filter(([, e]) => e.length);
  withErrors.forEach(([f, e]) => console.log('page errors on', f + ':', e.slice(0, 3).join(' | ')));
  assert.deepEqual(errors['advisor-today'], []);
  console.log('PASS advisor shell: Today renders counts, work lists, and actions; 8 existing pages render in the new shell');
})().catch(e => { console.error(e); process.exit(1); });
