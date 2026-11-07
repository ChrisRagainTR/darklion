'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const view = fs.readFileSync(path.join(__dirname, '../../server/views/crm-company.ejs'), 'utf8');
const source = view.slice(view.indexOf('  let bk_cpSelection ='), view.indexOf('  function bk_initUncategorized()'));
function ui(fetcher, savedProvider = 'qbo') {
  const savedProviders = [];
  const elements = new Map();
  const listeners = {};
  const document = { hidden: false, getElementById(id) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', style: {}, getClientRects: () => [1] });
    return elements.get(id);
  }, querySelector: () => null, addEventListener: (name, fn) => { listeners[name] = fn; } };
  const context = vm.createContext({ document, window: { addEventListener() {} }, setInterval() {},
    console, Date, companyId: 12, bk_cpInitialized: true, bookkeepingRealm: 'qbo-a',
    companyData: { bookkeeping_provider: savedProvider, ledgerhq_connected: true, ledgerhq_link: { provider_company_id: 'lhq-a', provider_company_name: 'Company A' } },
    esc: value => String(value || ''), toast() {}, bk_parseScanData: pkg => pkg.report_data,
    bk_formatCurrency: value => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    bk_qboConnectCardHtml: reconnect => reconnect ? 'Reconnect QuickBooks' : 'Connect QuickBooks',
    apiFetch: async (url, options) => {
      if (url.endsWith('/bookkeeping-source')) {
        const provider = JSON.parse(options.body).provider;
        savedProviders.push(provider);
        return response({provider});
      }
      return fetcher(url, options);
    } });
  const currencyStart = view.indexOf('  function bk_formatCurrency(');
  vm.runInContext(view.slice(currencyStart, view.indexOf('  // =====', currencyStart)), context);
  vm.runInContext(source, context);
  vm.runInContext("bk_restoreClosePackageProvider()", context);
  vm.runInContext("bk_cpSelection = {startDate:'2025-01-01',endDate:'2025-12-31',period:'2025',label:'2025'}", context);
  return { context, savedProviders, run: code => vm.runInContext(code, context), results: document.getElementById('bk-cp-results'), document };
}
const pkg = name => ({ status: 'draft', report_data: { provider: 'ledgerhq', ledgerHqCompanyName: name, generatedAt: new Date().toISOString(), pnl: { Header: { ReportBasis: 'cash' }, Rows: { Row: [] } } } });
const response = data => ({ ok: true, json: async () => data });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('renderer displays comma-formatted amounts and negatives accurately; LedgerHQ never opens QBO drilldowns', () => {
  const u = ui();
  u.run("bk_cpProvider = 'ledgerhq'");
  const html = u.run("bk_renderDataRow([{value:'Medical'}, {value:'128,347.46'}, {value:'(1,234.56)'}], 0, false, 3, [])");
  assert.match(html, /\$128,347\.46/);
  assert.match(html, /\(\$1,234\.56\)/);
  assert.doesNotMatch(html, /bk_openDrilldown/);
});
test('selecting LedgerHQ clears QBO figures and fetches live reports instead of saved packages', async () => {
  const pending = deferred(), requests = [];
  const u = ui(async (url, options) => { requests.push({ url, options }); return pending.promise; });
  u.run('bk_ledgerHqCompaniesLoaded = true');
  u.results.innerHTML = 'Old QBO report';
  await u.run("bk_setClosePackageProvider('ledgerhq')");
  assert.doesNotMatch(u.results.innerHTML, /Old QBO/);
  assert.equal(requests[0].options.method, 'POST');
  assert.match(requests[0].url, /ledgerhq\/close-package$/);
  pending.resolve(response(pkg('Company A')));
  await new Promise(setImmediate);
  assert.match(u.results.innerHTML, /Company A/);
  assert.match(u.results.innerHTML, /cash basis/);
});
test('late QBO response cannot replace selected LedgerHQ report', async () => {
  const qbo = deferred();
  const u = ui(async url => url.includes('ledgerhq') ? response(pkg('Company A')) : qbo.promise);
  u.run('bk_ledgerHqCompaniesLoaded = true');
  const old = u.run('bk_loadLatestClosePackage()');
  await u.run("bk_setClosePackageProvider('ledgerhq')");
  await new Promise(setImmediate);
  qbo.resolve(response([pkg('Wrong QBO Company')]));
  await old;
  assert.match(u.results.innerHTML, /Company A/);
  assert.doesNotMatch(u.results.innerHTML, /Wrong QBO/);
});
test('latest period response wins and refresh failure does not leave stale figures', async () => {
  const first = deferred(); let calls = 0;
  const u = ui(async () => ++calls === 1 ? first.promise : response(pkg('Latest period')));
  u.run("bk_cpProvider = 'ledgerhq'");
  const old = u.run('bk_generateClosePackage()');
  await u.run('bk_generateClosePackage()');
  first.resolve(response(pkg('Old period'))); await old;
  assert.match(u.results.innerHTML, /Latest period/);
  u.context.apiFetch = async () => { throw Error('LedgerHQ unavailable'); };
  await u.run('bk_generateClosePackage()');
  assert.match(u.results.innerHTML, /Reports could not be refreshed/);
  assert.doesNotMatch(u.results.innerHTML, /Latest period/);
  assert.equal(u.run('bk_lastClosePackageData'), null);
});
test('visible LedgerHQ reports refresh after five minutes; hidden or in-flight reports do not', async () => {
  let calls = 0;
  const u = ui(async url => { calls++; return response(url.endsWith('/companies') ? { companies: [] } : pkg('Fresh')); });
  u.run("bk_cpProvider = 'ledgerhq'; bk_cpLastAttempt = Date.now() - 300001");
  u.document.hidden = true; u.run('bk_refreshVisibleLedgerHq()'); assert.equal(calls, 0);
  u.document.hidden = false; u.run('bk_cpPending = true; bk_refreshVisibleLedgerHq()'); assert.equal(calls, 0);
  u.run('bk_cpPending = false; bk_refreshVisibleLedgerHq()');
  await new Promise(setImmediate);
  assert.equal(calls, 2);
  assert.match(u.results.innerHTML, /Fresh/);
  u.run('bk_refreshVisibleLedgerHq()'); assert.equal(calls, 2);
});

test('changing company mapping clears old report immediately and loads the saved company', async () => {
  const save = deferred();
  const u = ui(async (url, options) => options?.method === 'PUT' ? save.promise : response(pkg('Company B')));
  u.run("bk_cpProvider = 'ledgerhq'");
  const select = u.document.getElementById('bk-ledgerhq-company-select');
  Object.assign(select, { value: 'lhq-b', selectedIndex: 0, options: [{ dataset: { name: 'Company B' } }] });
  u.results.innerHTML = 'Company A old figures';
  const saving = u.run('bk_saveLedgerHqMapping()');
  assert.equal(u.results.innerHTML, '');
  assert.equal(select.disabled, true);
  save.resolve(response({ ok: true })); await saving;
  await new Promise(setImmediate);
  assert.equal(select.disabled, false);
  assert.equal(u.context.companyData.ledgerhq_link.provider_company_id, 'lhq-b');
  assert.match(u.results.innerHTML, /Company B/);
});

test('monthly figures fit their cells at phone, tablet and desktop widths with a sticky account column', async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const u = ui();
    u.context.layoutReport = { Header: { ReportName: 'Profit and Loss' },
      Columns: { Column: [{ ColTitle: 'Account' }, ...Array.from({length:12},(_,i)=>({ColTitle:`Month ${i+1}`})), { ColTitle:'Total' }] },
      Rows: { Row: [{ type:'Data', ColData: [{ value:'Long account name '.repeat(8) }, ...Array.from({length:13},()=>({value:'-1234567890.12'}))] }] } };
    const html = u.run('bk_renderQBReport(layoutReport)');
    const css = view.match(/<style>([\s\S]*?)<\/style>/)[1];
    const page = await browser.newPage();
    for (const width of [390,768,1440]) {
      await page.setViewportSize({width,height:900});
      await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;--card:#171a22;--border:#333;--muted:#aaa;--gold:#c9a84c}${css}</style>${html}`);
      const before = await page.evaluate(() => {
        const wrap=document.querySelector('.financial-report-scroll');
        return { viewport:innerWidth, pageWidth:document.documentElement.scrollWidth, scrollable:wrap.scrollWidth>wrap.clientWidth, totalWidth:wrap.scrollWidth,
          fits:[...document.querySelectorAll('tbody td.amount')].every(cell=>{
            const range=document.createRange();range.selectNodeContents(cell);
            const text=range.getBoundingClientRect(), box=cell.getBoundingClientRect(),css=getComputedStyle(cell);
            return text.left>=box.left+parseFloat(css.paddingLeft)-1 && text.right<=box.right-parseFloat(css.paddingRight)+1;
          }) };
      });
      assert.equal(before.fits,true,`figures fit at ${width}px`);
      assert.equal(before.scrollable,true);
      assert.ok(before.totalWidth < 3500, `numeric widths exclude formatting markup at ${width}px`);
      assert.ok(before.pageWidth<=before.viewport,`overflow remains inside report at ${width}px`);
      await page.locator('.financial-report-scroll').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
      const sticky=await page.evaluate(()=>Math.abs(document.querySelector('tbody td').getBoundingClientRect().left-document.querySelector('.financial-report-scroll').getBoundingClientRect().left)<3);
      assert.equal(sticky,true,`account names stay visible at ${width}px`);
    }
  } finally { await browser.close(); }
});

test('LedgerHQ is the default, and saved source choices survive restoring company data', async () => {
  const u = ui(async()=>response([]), null);
  assert.equal(u.run('bk_cpProvider'),'ledgerhq');
  await u.run("bk_setClosePackageProvider('qbo')");
  assert.equal(u.context.companyData.bookkeeping_provider,'qbo');
  u.run("bk_cpProvider='ledgerhq'; bk_restoreClosePackageProvider()");
  assert.equal(u.run('bk_cpProvider'),'qbo');
  u.context.bk_cpInitialized=false;
  await u.run("bk_setClosePackageProvider('ledgerhq')");
  u.run("bk_cpProvider='qbo'; bk_restoreClosePackageProvider()");
  assert.equal(u.run('bk_cpProvider'),'ledgerhq');
  assert.deepEqual(u.savedProviders,['qbo','ledgerhq']);
});
test('disconnected preferred source does not silently fall back; save failures preserve the prior selection', async () => {
  const u = ui(async()=>response([]), null);
  u.context.companyData.ledgerhq_connected=false;
  await u.run('bk_loadLatestClosePackage()');
  assert.equal(u.run('bk_cpProvider'),'ledgerhq');
  assert.match(u.results.innerHTML,/Connect LedgerHQ in Settings/);
  u.context.apiFetch=async()=>({ok:false,json:async()=>({error:'Could not save'})});
  await u.run("bk_setClosePackageProvider('qbo')");
  assert.equal(u.run('bk_cpProvider'),'ledgerhq');
  assert.equal(u.context.companyData.bookkeeping_provider,null);
});
