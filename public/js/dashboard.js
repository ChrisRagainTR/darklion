// Chart.js loader — resolves when Chart.js CDN is ready
window._chartJsReady = new Promise((resolve) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js';
  s.onload = resolve;
  s.onerror = resolve; // fail gracefully — charts will show empty state
  document.head.appendChild(s);
});

// ===== AUTH GUARD =====
    const dlToken = (window.DLAuth ? window.DLAuth.token() : localStorage.getItem('dl_token'));
    if (!dlToken) { window.location.replace('/login'); }

    // API fetch with JWT
    async function apiFetch(url, opts = {}) {
      const token = (window.DLAuth ? window.DLAuth.token() : localStorage.getItem('dl_token'));
      const isFormData = opts.body instanceof FormData;
      const res = await fetch(url, {
        ...opts,
        headers: {
          ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { 'Authorization': 'Bearer ' + token } : {}),
          ...(opts.headers || {}),
        },
      });
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        if (data.expired) {
          localStorage.removeItem('dl_token');
          localStorage.removeItem('dl_firm');
          window.location.replace('/login?expired=1');
        }
        throw new Error(data.error || 'Unauthorized');
      }
      return res;
    }

    let currentRealm = null;
    let companies = [];
    let switchController = null;

    function qs(sel) { return document.querySelector(sel); }

    function updateClientTrigger() { /* no-op — header search is now unified, not company-specific */ }
    function updateHeaderClient(c) { /* no-op */ }
    function selectClientFromHeader(realmId) { selectCompany(realmId); }

    // ===== INIT =====
    function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }


    async function init() {
      loadDashboardIntel(); // non-blocking — runs in background
      const mrrBtn = document.getElementById('ds-mrr-refresh');
      if (mrrBtn) mrrBtn.addEventListener('click', refreshMrrNow);
      loadBookkeeperCard(); // non-blocking
      initEmma(); // start Emma chat

      try {
        const res = await apiFetch('/api/companies');
        companies = await res.json();
      } catch(e) { companies = []; }

      // #empty-state was removed in dashboard refactor (5e3bda6); guard against null.
      var emptyEl = qs('#empty-state');
      var dashEl = qs('#dashboard');
      if (companies.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        if (dashEl) dashEl.style.display = 'none';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';
      if (dashEl) dashEl.style.display = '';

      currentRealm = companies[0].realm_id;
      updateClientTrigger();

      // Show refresh btn on client summary (safely)
      const refreshBtn = qs('#btn-cs-refresh');
      if (refreshBtn) refreshBtn.style.display = '';

      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && currentRealm) {
          try {
            const updated = await (await apiFetch('/api/companies')).json();
            if (Array.isArray(updated)) {
              companies = updated;
              updateClientTrigger();
              const activeSection = document.querySelector('.section-page.active');
            }
          } catch(e) {}
        }
      });
    }

    let cpSelection = { type: 'month', startDate: null, endDate: null, label: '', period: '' };
    let varSelectedMonth = null;

    function lastDay(year, month) {
      const d = new Date(year, month, 0);
      return year+'-'+String(month).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    }

    function showPeriodTab(tab, el) {
      document.querySelectorAll('.period-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.period-panel').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      qs('#pp-'+tab).classList.add('active');
    }

    function clearPeriodBtns() {
      document.querySelectorAll('.month-btn,.quarter-btn,.year-btn').forEach(b => b.classList.remove('selected'));
    }

    function selectMonth(btn, period, skipGenerate) {
      clearPeriodBtns(); btn.classList.add('selected');
      const [y,m] = period.split('-').map(Number);
      const d = new Date(y, m-1, 1);
      cpSelection = { type:'month', startDate:y+'-'+String(m).padStart(2,'0')+'-01', endDate:lastDay(y,m), label:d.toLocaleString('default',{month:'long',year:'numeric'}), period };
      qs('#cp-selected-label').textContent = cpSelection.label;
      if (!skipGenerate) generateClosePackage();
    }

    function selectQuarter(btn, q, year, sd, ed) {
      clearPeriodBtns(); btn.classList.add('selected');
      cpSelection = { type:'quarter', startDate:sd, endDate:ed, label:'Q'+q+' '+year, period:year+'-Q'+q };
      qs('#cp-selected-label').textContent = cpSelection.label;
      generateClosePackage();
    }

    function selectYear(btn, year) {
      clearPeriodBtns(); btn.classList.add('selected');
      const now = new Date();
      const isCurrentYear = year === now.getFullYear();
      cpSelection = { type:'annual', startDate:year+'-01-01', endDate:isCurrentYear?lastDay(now.getFullYear(),now.getMonth()+1):year+'-12-31', label:isCurrentYear?year+' YTD':String(year), period:String(year) };
      qs('#cp-selected-label').textContent = cpSelection.label;
      generateClosePackage();
    }

    function applyCustomRange() {
      clearPeriodBtns();
      const from = qs('#cp-date-from').value; const to = qs('#cp-date-to').value;
      if (!from || !to) { toast('Select both dates'); return; }
      if (from > to) { toast('Start date must be before end date'); return; }
      cpSelection = { type:'custom', startDate:from, endDate:to, label:from+' to '+to, period:'custom' };
      qs('#cp-selected-label').textContent = cpSelection.label;
      generateClosePackage();
    }

    // ===== SECTION NAVIGATION =====
    function showSection(name, el) {
      const sec = qs('#sec-'+name);
      if (!sec) return;
      document.querySelectorAll('.section-page').forEach(p => p.classList.remove('active'));

      sec.classList.add('active');
      if (el) el.classList.add('active');
      if (name === 'variance') loadLatestVariance();
      if (name === 'liability') loadLatestLiability();
      if (name === 'client-summary') {
        if (currentRealm) loadClientSummary();
        else showClientSummaryNoClient();
      }
      if (name === 'team') loadTeam();
      if (name === 'statements') {
        loadStatementsView();
      }
      if (name === 'statements-calendar') {
        initCalendarView();
      }
    }

    function showClientSummaryNoClient() {
      qs('#cs-no-client').style.display = '';
      qs('#cs-content').style.display = 'none';
    }

    // ===== CLIENT SUMMARY =====
    async function loadClientSummary() {
      if (!currentRealm) { showClientSummaryNoClient(); return; }
      const company = companies.find(c => c.realm_id === currentRealm);
      qs('#cs-subtitle').textContent = company?.company_name || currentRealm;
      qs('#cs-no-client').style.display = 'none';
      qs('#cs-content').style.display = '';
      qs('#btn-cs-refresh').style.display = '';

      // Show skeletons
      qs('#cs-alerts').innerHTML = '<div class="skeleton sk-block" style="height:50px;"></div>';
      qs('#cs-activity').innerHTML = '<div class="skeleton sk-line w90"></div><div class="skeleton sk-line w70"></div><div class="skeleton sk-line w80"></div>';
      ['qs-uncat','qs-liab','qs-close'].forEach(id => {
        const el = qs('#'+id);
        el.className = 'qs-value skeleton';
        el.style.cssText = 'height:28px;width:60px;border-radius:4px;';
        el.textContent = '';
      });
      qs('#cs-connections').innerHTML = '<div class="skeleton sk-block" style="height:60px;"></div>';
      qs('#cs-mini-pnl').style.display = 'none';

      // Load everything in parallel
      const [scans, pkgs] = await Promise.all([
        apiFetch('/api/companies/'+currentRealm+'/scans').then(r => r.json()).catch(() => []),
        apiFetch('/api/companies/'+currentRealm+'/close-packages').then(r => r.json()).catch(() => []),
      ]);

      const getLatestOfType = (type) => Array.isArray(scans) ? scans.find(s => s.scan_type === type) : null;
      const uncatScan = getLatestOfType('uncategorized');
      const liabScan = getLatestOfType('liability');
      const varianceScan = getLatestOfType('variance');

      const uncatData = parseScanData(uncatScan);
      const liabData = parseScanData(liabScan);
      const varData = parseScanData(varianceScan);
      const latestPkg = Array.isArray(pkgs) && pkgs.length > 0 ? pkgs[0] : null;

      // ---- ALERTS ----
      const alerts = [];

      // QBO connection
      if (company && company.token_status === 'disconnected') {
        alerts.push({ level: 'red', icon: '🔴', title: 'QBO Connection Expired', detail: 'QuickBooks token expired — reconnect required.', action: { label: 'Reconnect', fn: 'connectNewCompany()' } });
      }

      // Uncategorized
      if (uncatData?.summary?.flaggedCount > 0) {
        const amt = '$' + Number(uncatData.summary.totalFlaggedAmount || 0).toLocaleString();
        alerts.push({ level: 'red', icon: '🔴', title: `${uncatData.summary.flaggedCount} Uncategorized Account${uncatData.summary.flaggedCount > 1 ? 's' : ''}`, detail: `Transactions totaling ${amt} need categorization.`, action: { label: 'View', fn: "showSection('uncategorized',qs('[data-section=uncategorized]'))" } });
      }

      // Variance flags
      if (varData?.summary?.flaggedCount > 0) {
        alerts.push({ level: 'orange', icon: '🟠', title: `P&L Variance: ${varData.summary.flaggedCount} Account${varData.summary.flaggedCount > 1 ? 's' : ''} Flagged`, detail: `Unusual variance detected in ${varData.period || 'recent period'}.`, action: { label: 'View', fn: "showSection('variance',qs('[data-section=variance]'))" } });
      }

      // Liability issues
      if (liabData?.flagged?.length > 0) {
        for (const f of liabData.flagged.slice(0, 3)) {
          const firstIssue = f.issues?.[0];
          alerts.push({ level: 'orange', icon: '🟠', title: `Liability Issue: ${f.name}`, detail: firstIssue?.message || 'Review required', action: { label: 'View', fn: "showSection('liability',qs('[data-section=liability]'))" } });
        }
        if (liabData.flagged.length > 3) {
          alerts.push({ level: 'orange', icon: '🟠', title: `+${liabData.flagged.length - 3} more liability issues`, detail: 'Click to view full liability health report.', action: { label: 'View All', fn: "showSection('liability',qs('[data-section=liability]'))" } });
        }
      }

      // Render alerts
      if (alerts.length === 0) {
        qs('#cs-alerts').innerHTML = `<div class="alert-card alert-green"><span class="alert-icon">✅</span><div class="alert-content"><div class="alert-title">All Clear</div><div class="alert-detail">No issues found for this client.</div></div></div>`;
      } else {
        qs('#cs-alerts').innerHTML = alerts.map(a => `
          <div class="alert-card alert-${a.level}">
            <span class="alert-icon">${a.icon}</span>
            <div class="alert-content">
              <div class="alert-title">${esc(a.title)}</div>
              ${a.detail ? `<div class="alert-detail">${esc(a.detail)}</div>` : ''}
            </div>
            ${a.action ? `<div class="alert-action"><button onclick="${a.action.fn}">${esc(a.action.label)}</button></div>` : ''}
          </div>
        `).join('');
      }

      // ---- HEALTH SCORE ----
      let score = 100;
      const reasons = [];
      if (uncatData?.summary?.flaggedCount > 0) {
        const pts = Math.min(25, uncatData.summary.flaggedCount * 5);
        score -= pts; reasons.push(`-${pts}pts: uncategorized transactions`);
      }
      if (!latestPkg) {
        score -= 25; reasons.push('-25pts: no close package generated');
      }
      if (varData?.summary?.flaggedCount > 0) {
        const pts = Math.min(25, varData.summary.flaggedCount * 5);
        score -= pts; reasons.push(`-${pts}pts: variance flags`);
      }
      if (liabData?.flagged?.length > 0) {
        const pts = Math.min(25, liabData.flagged.length * 5);
        score -= pts; reasons.push(`-${pts}pts: liability issues`);
      }
      score = Math.max(0, score);

      const circumference = 2 * Math.PI * 36;
      const fillEl = qs('#gauge-fill');
      const offset = circumference * (1 - score / 100);
      fillEl.style.strokeDasharray = circumference;
      fillEl.style.strokeDashoffset = offset;

      let gaugeColor, gaugeStatus;
      if (score >= 80) { gaugeColor = 'var(--green)'; gaugeStatus = 'Healthy'; }
      else if (score >= 50) { gaugeColor = 'var(--orange)'; gaugeStatus = 'Needs Attention'; }
      else { gaugeColor = 'var(--red)'; gaugeStatus = 'Action Required'; }
      fillEl.style.stroke = gaugeColor;
      qs('#gauge-num').textContent = score;
      qs('#gauge-num').style.color = gaugeColor;
      qs('#gauge-status').textContent = gaugeStatus;
      qs('#gauge-desc').textContent = reasons.length > 0 ? reasons.slice(0, 3).join(' · ') : 'All checks passing.';

      // ---- ACTIVITY FEED ----
      const activities = [];
      if (Array.isArray(scans)) {
        const typeEmoji = { uncategorized: '🔍', liability: '🏦', variance: '📊' };
        for (const s of scans.slice(0, 5)) {
          activities.push({
            icon: typeEmoji[s.scan_type] || '📋',
            text: `${s.scan_type.charAt(0).toUpperCase()+s.scan_type.slice(1)} scan — ${s.flag_count || 0} flag${s.flag_count !== 1 ? 's' : ''}`,
            time: s.scanned_at ? timeAgo(s.scanned_at) : '--',
          });
        }
      }
      if (latestPkg) activities.unshift({ icon: '📦', text: `Close package: ${latestPkg.period}`, time: latestPkg.generated_at ? timeAgo(latestPkg.generated_at) : '--' });

      if (activities.length === 0) {
        qs('#cs-activity').innerHTML = '<div style="color:var(--muted);font-size:0.8rem;padding:0.5rem 0;">No recent activity. Run scans to get started.</div>';
      } else {
        qs('#cs-activity').innerHTML = activities.slice(0, 6).map(a =>
          `<div class="activity-item"><span class="activity-icon">${a.icon}</span><span class="activity-text">${esc(a.text)}</span><span class="activity-time">${esc(a.time)}</span></div>`
        ).join('');
      }

      // ---- QUICK STATS ----
      setQS('qs-uncat', uncatData?.summary?.flaggedCount ?? '--', uncatData?.summary?.flaggedCount > 0 ? 'red' : 'green', 'accounts');
      setQS('qs-liab', liabData?.summary?.flaggedCount ?? '--', liabData?.summary?.flaggedCount > 0 ? 'orange' : 'green', 'issues');
      setQS('qs-close', latestPkg ? latestPkg.period : 'None', latestPkg ? 'text' : 'muted', '');
      // ---- CONNECTIONS ----
      const qboConnected = company?.token_status !== 'disconnected';
      qs('#cs-connections').innerHTML = `
        <div class="conn-card" style="margin-bottom:0.6rem;">
          <span class="conn-icon">${qboConnected ? '🟢' : '🔴'}</span>
          <div class="conn-info">
            <div class="conn-name">QuickBooks Online</div>
            <div class="conn-status">${qboConnected ? 'Connected' : 'Disconnected — reconnect required'}</div>
          </div>
          ${!qboConnected ? `<div class="conn-action"><button class="btn btn-gold btn-sm" onclick="connectNewCompany()">Reconnect</button></div>` : ''}
        </div>
      `;

      // ---- MINI P&L ----
      if (latestPkg) {
        const rd = typeof latestPkg.report_data === 'string' ? JSON.parse(latestPkg.report_data) : latestPkg.report_data;
        if (rd?.pnl?.Rows?.Row) {
          const pnlData = parsePnlForMini(rd.pnl.Rows.Row);
          if (pnlData.revenue !== null || pnlData.expenses !== null || pnlData.net !== null) {
            qs('#cs-mini-pnl').style.display = '';
            qs('#cs-pnl-rows').innerHTML = `
              <div class="mini-pnl-row"><span class="pnl-label">Revenue</span><span style="color:var(--green);">${fmtCur(pnlData.revenue || 0)}</span></div>
              <div class="mini-pnl-row"><span class="pnl-label">Expenses</span><span style="color:var(--orange);">${fmtCur(pnlData.expenses || 0)}</span></div>
              <div class="mini-pnl-row"><span class="pnl-label">Net Income</span><span style="color:${(pnlData.net || 0) >= 0 ? 'var(--green)' : 'var(--red)'};">${fmtCur(pnlData.net || 0)}</span></div>
            `;
          }
        }
      }
    }

    function parseScanData(scan) {
      if (!scan || !scan.result_data) return null;
      try { return typeof scan.result_data === 'string' ? JSON.parse(scan.result_data) : scan.result_data; }
      catch(e) { return null; }
    }

    function setQS(id, value, color, sub) {
      const el = qs('#' + id);
      el.className = 'qs-value' + (color === 'green' ? ' green' : color === 'red' ? ' red' : color === 'orange' ? ' orange' : color === 'gold' ? ' gold' : '');
      el.style.cssText = '';
      el.textContent = value;
      const subEl = el.nextElementSibling;
      if (subEl && subEl.classList.contains('qs-sub')) subEl.textContent = sub;
    }

    function parsePnlForMini(rows) {
      const result = { revenue: null, expenses: null, net: null };
      if (!rows) return result;
      for (const row of rows) {
        const label = (row.Header?.ColData?.[0]?.value || row.Summary?.ColData?.[0]?.value || '').toLowerCase();
        const val = parseFloat(row.Summary?.ColData?.[1]?.value || '0');
        if (label.includes('income') || label.includes('revenue')) result.revenue = val;
        if (label.includes('expense')) result.expenses = val;
        if (label.includes('net')) result.net = val;
      }
      return result;
    }

    // ===== OVERVIEW =====
    async function loadOverviewScans() {
      const connected = companies.filter(c => c.token_status !== 'disconnected').length;
      const disconnected = companies.filter(c => c.token_status === 'disconnected').length;
      qs('#ov-companies').textContent = companies.length;
      qs('#ov-companies').style.color = disconnected > 0 ? 'var(--orange)' : 'var(--green)';
      qs('#ov-companies-sub').textContent = connected + ' connected' + (disconnected > 0 ? ', ' + disconnected + ' disconnected' : '');

      try {
        const scans = await (await apiFetch('/api/companies/'+currentRealm+'/scans')).json();
        if (!Array.isArray(scans) || scans.length === 0) {
          qs('#overview-scans').innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:1.5rem;">No scans yet.</td></tr>';
          return;
        }
        const typeLabels = { uncategorized:'Uncategorized', variance:'P&L Variance', liability:'Liability' };
        qs('#overview-scans').innerHTML = scans.map(s => {
          const d = s.scanned_at ? new Date(s.scanned_at).toLocaleString() : '--';
          return '<tr><td>'+(typeLabels[s.scan_type]||s.scan_type)+'</td><td>'+(s.flag_count||0)+' flags</td><td style="color:var(--muted);font-size:0.82rem;">'+d+'</td><td>'+(s.flag_count>0?'<span class="badge badge-flag">Needs Review</span>':'<span class="badge badge-ok">OK</span>')+'</td></tr>';
        }).join('');

        for (const s of scans) {
          const data = parseScanData(s);
          if (s.scan_type === 'uncategorized' && data?.summary) {
            qs('#ov-uncat').textContent = data.summary.flaggedCount + ' flagged';
            qs('#ov-uncat').style.color = data.summary.flaggedCount > 0 ? 'var(--red)' : 'var(--green)';
            qs('#ov-uncat-sub').textContent = '$'+Number(data.summary.totalFlaggedAmount||0).toLocaleString()+' total';
          }
        }
      } catch(e) { /* ignore */ }

      try {
        const pkgs = await (await apiFetch('/api/companies/'+currentRealm+'/close-packages')).json();
        if (Array.isArray(pkgs) && pkgs.length > 0) {
          qs('#ov-pkg').textContent = pkgs.length + ' generated';
          qs('#ov-pkg').style.color = 'var(--green)';
          qs('#ov-pkg-sub').textContent = 'Latest: ' + pkgs[0].period;
        }
      } catch(e) { /* ignore */ }
    }

    // ===== UNCATEGORIZED =====
    async function runUncategorizedScan() {
      const btn = qs('#btn-uncat-scan'); btn.disabled=true; btn.textContent='Scanning…';
      try {
        const data = await (await apiFetch('/api/companies/'+currentRealm+'/scan/uncategorized',{method:'POST'})).json();
        if (data.error) throw new Error(data.error);
        const s = data.summary;
        qs('#uncat-stats').style.display='';
        qs('#uncat-flagged').textContent = s.flaggedCount;
        qs('#uncat-checked').textContent = s.checkedCount;
        qs('#uncat-total').textContent = '$'+Number(s.totalFlaggedAmount).toLocaleString();
        qs('#uncat-last-scan').textContent = 'Last scanned: ' + new Date().toLocaleString();
        let html = '';
        if (data.flagged.length > 0) {
          html += '<h3 style="font-size:0.88rem;margin:1rem 0 0.5rem;color:var(--red);">Flagged Accounts</h3><div class="table-wrap"><table><thead><tr><th>Account</th><th>Balance</th><th>Transactions</th></tr></thead><tbody>';
          for (const f of data.flagged) {
            html += '<tr><td style="font-weight:600;">'+esc(f.name)+'</td><td style="color:var(--orange);">$'+Number(f.balance).toLocaleString()+'</td><td>'+f.transactionCount+'</td></tr>';
            if (f.transactions?.length > 0) {
              for (const t of f.transactions) {
                html += '<tr><td style="padding-left:2rem;color:var(--muted);font-size:0.8rem;">'+t.date+'</td><td style="font-size:0.8rem;">$'+Number(t.amount).toFixed(2)+'</td><td style="color:var(--muted);font-size:0.8rem;">'+esc(t.vendor)+' — '+esc(t.description)+'</td></tr>';
              }
            }
          }
          html += '</tbody></table></div>';
        }
        html += '<h3 style="font-size:0.88rem;margin:1.5rem 0 0.5rem;">All Checked Accounts</h3><div class="table-wrap"><table><thead><tr><th>Account</th><th>Balance</th><th>Status</th></tr></thead><tbody>';
        for (const c of data.checked) {
          html += '<tr><td>'+esc(c.name)+'</td><td>$'+Number(c.balance).toLocaleString()+'</td><td>'+(c.balance===0?'<span class="badge badge-ok">OK</span>':'<span class="badge badge-flag">Flagged</span>')+'</td></tr>';
        }
        html += '</tbody></table></div>';
        qs('#uncat-results').innerHTML = html;
        toast('Scan complete: '+s.flaggedCount+' flagged');
        loadOverviewScans();
      } catch(e) { toast('Scan failed: '+e.message); }
      btn.disabled=false; btn.textContent='Run Scan';
    }

    // ===== CLOSE PACKAGE =====
    async function generateClosePackage() {
      if (!cpSelection.startDate) { toast('Select a period first'); return; }
      qs('#cp-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">Generating close package for '+esc(cpSelection.label)+'…</div>';
      try {
        const body = { startDate:cpSelection.startDate, endDate:cpSelection.endDate, period:cpSelection.period, label:cpSelection.label };
        const data = await (await apiFetch('/api/companies/'+currentRealm+'/close-package',{method:'POST',body:JSON.stringify(body)})).json();
        if (data.error) throw new Error(data.error);
        const rd = parseScanData(data) || data.report_data;
        const rdObj = typeof rd === 'string' ? JSON.parse(rd) : rd;
        qs('#cp-results').innerHTML = '<h3 style="font-size:0.92rem;margin-bottom:1rem;">'+esc(cpSelection.label)+'</h3>' + renderClosePackageBody(rdObj, data);
        toast('Close package generated for '+cpSelection.label);
      } catch(e) {
        toast('Generation failed: '+e.message);
        qs('#cp-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red);">Failed: '+esc(e.message)+'</div>';
      }
    }

    // ===== VARIANCE =====
    async function runVarianceScan() {
      const selectedBtn = document.querySelector('#var-month-btns .selected');
      const year = selectedBtn ? parseInt(selectedBtn.dataset.year) : (varSelectedMonth?.year || new Date().getFullYear());
      const month = selectedBtn ? parseInt(selectedBtn.dataset.month) : (varSelectedMonth?.month || new Date().getMonth() + 1);
      const thresholdPct = parseInt(qs('#var-threshold-pct').value) || 15;
      const thresholdAmt = parseInt(qs('#var-threshold-amt').value) || 500;

      qs('#var-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">Running variance analysis…</div>';
      try {
        const data = await (await apiFetch('/api/companies/'+currentRealm+'/scan/variance', {method:'POST',body:JSON.stringify({year,month,thresholdPct,thresholdAmt})})).json();
        if (data.error) throw new Error(data.error);
        renderVarianceResults(data);
        toast('Variance analysis complete — '+data.summary.flaggedCount+' flagged');
      } catch(e) {
        toast('Variance analysis failed: '+e.message);
        qs('#var-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red);">Failed: '+esc(e.message)+'</div>';
      }
    }

    function renderVarianceResults(data, threshPct, threshAmt) {
      qs('#var-stats').style.display='';
      qs('#var-total').textContent = data.summary.totalAccounts;
      qs('#var-flagged').textContent = data.summary.flaggedCount;
      const pct = threshPct || data.thresholdPct || 15;
      const amt = threshAmt || data.thresholdAmt || 500;
      qs('#var-threshold').textContent = pct+'%';
      if (qs('#var-threshold-sub')) qs('#var-threshold-sub').textContent = 'and >$'+amt.toLocaleString();
      qs('#var-last-scan').textContent = 'Comparing '+data.period+' vs '+data.priorPeriod+' (MoM) and '+data.yoyPeriod+' (YoY)';
      const v = data.variances || [];
      if (v.length === 0) { qs('#var-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">No P&L data found.</div>'; return; }
      let html = '<div class="table-wrap"><table><thead><tr><th>Account</th><th class="amount">Current</th><th class="amount">Prior Mo</th><th class="amount">MoM $</th><th class="amount">MoM %</th><th class="amount">Prior Yr</th><th class="amount">YoY $</th><th class="amount">YoY %</th></tr></thead><tbody>';
      for (const r of v) {
        const isTotal = r.account.startsWith('TOTAL:');
        const rowCls = isTotal ? ' class="report-row-total"' : (r.flagged ? ' style="background:rgba(245,101,101,0.06);"' : '');
        const name = isTotal ? '<strong>'+esc(r.account)+'</strong>' : esc(r.account);
        // Color logic: for income accounts, more = green; for expense accounts, less = green
        // isIncome=true → positive diff is good (green), negative is bad (red)
        // isIncome=false → negative diff is good (green), positive is bad (red)
        // isIncome=null (totals) → use sign as-is
        function varColor(diff, isIncome, flagged) {
          if (!flagged) return '';
          if (isIncome === true) return diff > 0 ? 'color:var(--green);font-weight:700;' : 'color:var(--red);font-weight:700;';
          if (isIncome === false) return diff < 0 ? 'color:var(--green);font-weight:700;' : 'color:var(--red);font-weight:700;';
          return diff > 0 ? 'color:var(--red);font-weight:700;' : 'color:var(--green);font-weight:700;';
        }
        const momColor = varColor(r.momDiff, r.isIncome, r.momFlagged);
        const yoyColor = varColor(r.yoyDiff, r.isIncome, r.yoyFlagged);
        html += '<tr'+rowCls+'><td>'+name+'</td><td class="amount">'+fmtCur(r.current)+'</td><td class="amount">'+fmtCur(r.priorMonth)+'</td><td class="amount" style="'+momColor+'">'+fmtCurSigned(r.momDiff)+'</td><td class="amount" style="'+momColor+'">'+(r.momPct>0?'+':'')+r.momPct+'%</td><td class="amount">'+fmtCur(r.priorYearMonth)+'</td><td class="amount" style="'+yoyColor+'">'+fmtCurSigned(r.yoyDiff)+'</td><td class="amount" style="'+yoyColor+'">'+(r.yoyPct>0?'+':'')+r.yoyPct+'%</td></tr>';
      }
      html += '</tbody></table></div>';
      qs('#var-results').innerHTML = html;
    }

    function fmtCur(n) { return '$'+Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0}); }
    function fmtCurSigned(n) { return (n>=0?'+':'-')+'$'+Math.abs(n).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:0}); }

    async function loadLatestVariance() {
      if (!currentRealm) return;
      try {
        const resp = await apiFetch('/api/companies/'+currentRealm+'/scans?type=variance');
        if (!resp.ok) return;
        const scan = await resp.json();
        if (!scan?.result_data) return;
        const data = parseScanData(scan);
        if (data) renderVarianceResults(data);
      } catch(e) {}
    }

    // ===== LIABILITY =====
    async function runLiabilityScan() {
      qs('#liab-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">Scanning liability accounts…</div>';
      try {
        const data = await (await apiFetch('/api/companies/'+currentRealm+'/scan/liability', {method:'POST',body:'{}'})).json();
        if (data.error) throw new Error(data.error);
        renderLiabilityResults(data);
        toast('Liability check complete — '+data.summary.flaggedCount+' issues found');
      } catch(e) {
        toast('Liability check failed: '+e.message);
        qs('#liab-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red);">Failed: '+esc(e.message)+'</div>';
      }
    }

    function renderLiabilityResults(data) {
      if (data.error) {
        qs('#liab-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red);">'+esc(data.error)+'</div>';
        return;
      }
      if (data.message) {
        qs('#liab-results').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">'+esc(data.message)+'</div>';
        return;
      }
      qs('#liab-stats').style.display='';
      qs('#liab-total').textContent = data.summary.totalAccounts;
      qs('#liab-flagged').textContent = data.summary.flaggedCount;
      qs('#liab-balance').textContent = '$'+Math.abs(data.summary.totalLiabilityBalance).toLocaleString();
      let html = '';
      if (data.flagged?.length > 0) {
        html += '<h3 style="font-size:0.88rem;margin:0 0 0.5rem;color:var(--red);">Issues Found</h3>';
        html += '<div class="table-wrap" style="margin-bottom:1.5rem;"><table><thead><tr><th>Account</th><th>Type</th><th>Subtype</th><th class="amount">Balance</th><th>Issues</th></tr></thead><tbody>';
        for (const a of data.flagged) {
          const issueHtml = a.issues.map(i => '<span class="badge '+(i.severity==='warning'?'badge-flag':'badge-pending')+'">'+esc(i.message)+'</span>').join(' ');
          html += '<tr style="background:rgba(245,101,101,0.06);"><td style="font-weight:600;">'+esc(a.name)+'</td><td style="color:var(--muted);font-size:0.78rem;">'+esc(a.accountType)+'</td><td style="color:var(--muted);font-size:0.78rem;">'+esc(a.subType||'')+'</td><td class="amount" style="color:var(--orange);font-weight:600;">$'+Number(a.balance).toLocaleString()+'</td><td>'+issueHtml+'</td></tr>';
        }
        html += '</tbody></table></div>';
      }
      if (data.checked?.length > 0) {
        html += '<h3 style="font-size:0.88rem;margin:0 0 0.5rem;">All Liability Accounts</h3>';
        html += '<div class="table-wrap"><table><thead><tr><th>Account</th><th>Type</th><th>Subtype</th><th class="amount">Balance</th><th>Status</th></tr></thead><tbody>';
        for (const a of data.checked) {
          const ok = a.issues.filter(i => i.severity !== 'info').length === 0;
          html += '<tr><td>'+esc(a.name)+'</td><td style="color:var(--muted);font-size:0.78rem;">'+esc(a.accountType)+'</td><td style="color:var(--muted);font-size:0.78rem;">'+esc(a.subType||'')+'</td><td class="amount">$'+Number(a.balance).toLocaleString()+'</td><td>'+(ok?'<span class="badge badge-ok">OK</span>':'<span class="badge badge-flag">'+a.issues.filter(i=>i.severity!=='info').length+' issue(s)</span>')+'</td></tr>';
        }
        html += '</tbody></table></div>';
      }
      qs('#liab-results').innerHTML = html || '<div style="text-align:center;padding:2rem;color:var(--muted);">No liability accounts found.</div>';
    }

    async function loadLatestLiability() {
      if (!currentRealm) return;
      try {
        const resp = await apiFetch('/api/companies/'+currentRealm+'/scans?type=liability');
        if (!resp.ok) return;
        const scan = await resp.json();
        if (!scan?.result_data) return;
        const data = parseScanData(scan);
        if (data) renderLiabilityResults(data);
      } catch(e) {}
    }

    // ===== CLOSE PACKAGE RENDER =====
    function renderClosePackageBody(rd, pkg) {
      if (!rd) return '<div style="color:var(--muted);padding:1rem;">No report data available.</div>';
      let html = '';
      if (rd.pnl) html += '<div class="report-section"><h3>Profit & Loss</h3>'+renderQBReport(rd.pnl)+'</div>';
      if (rd.balanceSheet) html += '<div class="report-section"><h3>Balance Sheet</h3>'+renderQBReport(rd.balanceSheet)+'</div>';
      if (rd.trialBalance) html += '<div class="report-section"><h3>Trial Balance</h3>'+renderQBReport(rd.trialBalance)+'</div>';
      if (!rd.pnl && !rd.balanceSheet && !rd.trialBalance) html += '<div style="color:var(--muted);padding:1rem;text-align:center;">No report data available.</div>';
      html += '<div style="margin-top:0.75rem;text-align:right;"><span class="badge badge-pending" style="font-size:0.75rem;padding:0.2rem 0.6rem;">'+esc(pkg.status||'draft')+'</span></div>';
      return html;
    }

    // ===== QBO REPORT RENDERER — fixed column alignment =====
    function renderQBReport(report) {
      if (!report?.Rows?.Row) {
        return '<div style="text-align:center;padding:1.5rem;color:var(--muted);">No report data available.</div>';
      }

      const columns = report.Columns?.Column || [];
      const colCount = Math.max(columns.length, 2);
      const dataCols = colCount - 1;

      // Extract per-column date ranges — first try QBO metadata, then parse column title
      const MONTH_MAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
      function parseTitleDate(title) {
        if (!title) return { start: '', end: '' };
        // Try "MMM YYYY" format (e.g. "JAN 2025")
        const m = title.trim().match(/^([A-Za-z]{3})\s+(\d{4})$/);
        if (m) {
          const mo = MONTH_MAP[m[1].toLowerCase()];
          const yr = parseInt(m[2]);
          if (mo && yr) {
            const start = yr + '-' + String(mo).padStart(2,'0') + '-01';
            const lastD = new Date(yr, mo, 0).getDate();
            const end = yr + '-' + String(mo).padStart(2,'0') + '-' + String(lastD).padStart(2,'0');
            return { start, end };
          }
        }
        // Try "YYYY" annual format
        const yr = title.trim().match(/^(\d{4})$/);
        if (yr) return { start: yr[1]+'-01-01', end: yr[1]+'-12-31' };
        return { start: '', end: '' };
      }
      const colDates = columns.map(col => {
        const meta = col.MetaData || [];
        const start = meta.find(m => m.Name === 'StartDate')?.Value || '';
        const end   = meta.find(m => m.Name === 'EndDate')?.Value   || '';
        if (start && end) return { start, end };
        // Fall back to parsing the column title
        return parseTitleDate(col.ColTitle || '');
      });

      // Name col: 60% for 2 cols, 40% for 3-4, 30% for 5-8, 25% for 9+
      const firstColPct = dataCols <= 1 ? 60 : dataCols <= 3 ? 40 : dataCols <= 7 ? 30 : 25;
      const restPct = (100 - firstColPct) / dataCols;

      let html = '<div class="table-wrap"><table style="table-layout:fixed;width:100%;">';

      html += '<colgroup>';
      html += `<col style="width:${firstColPct}%">`;
      for (let i = 0; i < dataCols; i++) {
        html += `<col style="width:${restPct.toFixed(2)}%">`;
      }
      html += '</colgroup>';

      // Header row — always include blank first col if QBO leaves it blank
      html += '<thead><tr>';
      for (let i = 0; i < colCount; i++) {
        const title = columns[i]?.ColTitle || '';
        html += i === 0
          ? `<th>${esc(title)}</th>`
          : `<th class="amount">${esc(title)}</th>`;
      }
      html += '</tr></thead>';

      html += '<tbody>';
      html += renderReportRows(report.Rows.Row, 0, colCount, colDates);
      html += '</tbody></table></div>';
      return html;
    }

    function renderReportRows(rows, depth, colCount, colDates) {
      let html = '';
      for (const row of rows) {
        if (row.type === 'Section' || row.group) {
          if (row.Header?.ColData) {
            const name = row.Header.ColData[0]?.value || '';
            const pad = (depth * 1.2) + 1;
            html += `<tr class="report-row-header"><td style="padding-left:${pad}rem;">${esc(name)}</td>`;
            for (let i = 1; i < colCount; i++) html += '<td class="amount"></td>';
            html += '</tr>';
          }
          if (row.Rows?.Row) html += renderReportRows(row.Rows.Row, depth + 1, colCount, colDates);
          if (row.Summary?.ColData) html += renderDataRow(row.Summary.ColData, depth, true, colCount, colDates);
        } else if (row.ColData) {
          html += renderDataRow(row.ColData, depth, false, colCount, colDates);
        }
      }
      return html;
    }

    function renderDataRow(colData, depth, isTotal, colCount, colDates) {
      const cls = isTotal ? ' class="report-row-total"' : '';
      let html = `<tr${cls}>`;
      for (let i = 0; i < colCount; i++) {
        const val = colData[i]?.value ?? '';
        if (i === 0) {
          const pad = (depth * 1.2) + 1;
          html += `<td style="padding-left:${pad}rem;${isTotal ? 'font-weight:700;' : ''}">${esc(val)}</td>`;
        } else {
          const num = parseFloat(val);
          const display = isNaN(num) ? esc(val) : formatCurrency(num);
          // Use per-column dates from QBO metadata; fall back to cpSelection for single-period reports
          const colDate = colDates?.[i] || {};
          const sDate = colDate.start || cpSelection?.startDate || '';
          const eDate = colDate.end   || cpSelection?.endDate   || '';
          const accountName = colData[0]?.value || '';
          const drillable = !isNaN(num) && num !== 0 && sDate && eDate && !isTotal ? ' drillable' : '';
          const drillAttr = drillable
            ? ` data-account="${esc(accountName)}" data-start="${esc(sDate)}" data-end="${esc(eDate)}" onclick="openDrilldown('${esc(accountName)}','${esc(sDate)}','${esc(eDate)}','${display.replace(/['"<>]/g,'')}')"` : '';
          html += `<td class="amount${drillable}"${drillAttr} style="${isTotal ? 'font-weight:700;' : ''}">${display}</td>`;
        }
      }
      html += '</tr>';
      return html;
    }

    function formatCurrency(n) {
      if (n === 0) return '$0.00';
      const abs = Math.abs(n);
      const formatted = '$' + abs.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
      return n < 0 ? `<span style="color:var(--red);">(${formatted})</span>` : formatted;
    }

    // ===== COMPANY MANAGEMENT =====
    function showSectionLoading() {
      const activeSection = document.querySelector('.section-page.active');
      if (activeSection && !['sec-overview','sec-companies','sec-team'].includes(activeSection.id)) {
        // Show a subtle loading indicator in the active section
        const existing = activeSection.querySelector('.section-switch-loading');
        if (!existing) {
          const div = document.createElement('div');
          div.className = 'section-switch-loading';
          div.style.cssText = 'position:absolute;top:70px;left:0;right:0;text-align:center;padding:0.5rem;color:var(--muted);font-size:0.78rem;pointer-events:none;';
          div.textContent = 'Switching client…';
          activeSection.style.position = 'relative';
          activeSection.appendChild(div);
          setTimeout(() => div.remove(), 3000);
        }
      }
    }

    async function reloadCurrentSection(signal) {
      const activeSection = document.querySelector('.section-page.active');
      if (!activeSection) return;
      const secName = activeSection.id.replace('sec-', '');
      try {
        if (secName === 'variance') await runVarianceScan(); // force fresh from QBO
        else if (secName === 'liability') await loadLatestLiability();
        else if (secName === 'client-summary') await loadClientSummary();
        else if (secName === 'statements') await loadStatementsView();
      } catch (e) {
        if (e.name !== 'AbortError') console.error('Section reload error:', e);
      }
    }

    async function selectCompany(realmId) {
      if (switchController) switchController.abort();
      switchController = new AbortController();

      currentRealm = realmId;
      // Update header immediately
      updateHeaderClient(companies.find(c => c.realm_id === realmId) || null);
      updateClientTrigger();
      showSectionLoading();
      await reloadCurrentSection(switchController.signal);
      toast('Switched to ' + (companies.find(c=>c.realm_id===realmId)?.company_name || realmId));
    }

    async function connectNewCompany() {
      try {
        const cfg = await (await fetch('/api/config')).json();
        sessionStorage.setItem('connect_from', 'dashboard');
        // The server issues a signed, short-lived state tied to this firm.
        const stateRes = await apiFetch('/auth/qbo-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        const { state } = await stateRes.json();
        if (!stateRes.ok || !state) throw new Error('could not start the connection');
        const redirectUri = encodeURIComponent(cfg.qb_redirect_uri);
        window.location.href = 'https://appcenter.intuit.com/connect/oauth2?client_id=' + cfg.qb_client_id + '&response_type=code&scope=com.intuit.quickbooks.accounting&redirect_uri=' + redirectUri + '&state=' + encodeURIComponent(state);
      } catch(e) { toast('Failed to start connection: ' + e.message); }
    }

    async function disconnectCompany(realmId, name) {
      if (!confirm('Disconnect "' + (name || realmId) + '"? This will remove all stored data for this company.')) return;
      try {
        const res = await apiFetch('/api/companies/' + realmId, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to disconnect');
        toast('Disconnected ' + (name || realmId));
        companies = companies.filter(c => c.realm_id !== realmId);
        if (currentRealm === realmId) currentRealm = companies.length > 0 ? companies[0].realm_id : null;
        updateClientTrigger();
        if (companies.length === 0) {
          qs('#empty-state').style.display = '';
          qs('#dashboard').style.display = 'none';
        }
      } catch(e) { toast('Disconnect failed: ' + e.message); }
    }

    function timeAgo(dateStr) {
      const diff = Date.now() - new Date(dateStr).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hrs = Math.floor(mins / 60);
      if (hrs < 24) return hrs + 'h ago';
      const days = Math.floor(hrs / 24);
      if (days < 30) return days + 'd ago';
      return Math.floor(days / 30) + 'mo ago';
    }

    // ===== TEAM SECTION =====
    let teamData = [];
    let firmCompanies = [];

    async function loadTeam() {
      qs('#team-loading').style.display = '';
      qs('#team-content').style.display = 'none';
      try {
        const [teamRes, companiesRes] = await Promise.all([
          apiFetch('/firms/team'),
          apiFetch('/api/companies'),
        ]);
        teamData = await teamRes.json();
        firmCompanies = await companiesRes.json();
        renderTeam();
        qs('#team-loading').style.display = 'none';
        qs('#team-content').style.display = '';
        // Lazy-load signed avatar URLs for members with avatars
        loadTeamAvatars();
      } catch (e) {
        qs('#team-loading').textContent = 'Failed to load team: ' + e.message;
      }
    }

    function renderTeam() {
      const tbody = qs('#team-tbody');
      if (!teamData.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:2rem;color:var(--muted);">No team members yet.</td></tr>';
        return;
      }

      // Derive current user identity from server data (not JWT — avoids stale-token bugs)
      let currentUserId = null, currentRole = 'admin';
      try {
        const token = (window.DLAuth ? window.DLAuth.token() : localStorage.getItem('dl_token'));
        if (token) {
          const p = JSON.parse(atob(token.split('.')[1]));
          currentUserId = p.userId;
        }
      } catch(e) {}
      // Find self in team data to get real role from DB
      const selfEntry = teamData.find(u => u.id === currentUserId);
      if (selfEntry) currentRole = selfEntry.role || 'admin';

      const isOwner = currentRole === 'owner';

      tbody.innerHTML = teamData.map(u => {
        const statusHtml = u.pending
          ? '<span class="team-status-pending">Pending</span>'
          : (u.accepted_at ? '<span class="team-status-active">Active</span>' : '<span class="team-status-pending">Inactive</span>');

        const lastLogin = u.last_login_at ? timeAgo(u.last_login_at) : 'Never';

        const companiesDisplay = u.allowed_realm_ids.length === 0
          ? '<span style="color:var(--muted);font-size:0.75rem;">All</span>'
          : u.allowed_realm_ids.length + ' assigned';

        const isSelf = u.id === currentUserId;

        const roleCell = isOwner && !isSelf
          ? `<select style="background:var(--charcoal);border:1px solid var(--border);color:var(--text);padding:0.2rem 0.4rem;border-radius:4px;font-size:0.78rem;cursor:pointer;"
               onchange="changeUserRole(${u.id}, this.value)">
               <option value="admin"${u.role==='admin'?' selected':''}>Admin</option>
               <option value="owner"${u.role==='owner'?' selected':''}>Owner</option>
             </select>`
          : `<span class="badge badge-ok" style="font-size:0.72rem;">${u.role}</span>`;

        const actions = !isSelf
          ? `<div style="display:flex;gap:0.35rem;align-items:center;flex-wrap:wrap;">
               ${isOwner ? `<button class="btn btn-outline btn-sm" onclick="editTeamMember(${u.id},'${esc(u.name||'')}','${esc(u.email)}')" style="font-size:0.72rem;">Edit</button>` : ''}
               <button class="btn btn-outline btn-sm" onclick="toggleCompanyAccess(${u.id})" style="font-size:0.72rem;">Companies</button>
               ${isOwner ? `<button style="background:transparent;border:1px solid var(--red);color:var(--red);padding:0.2rem 0.5rem;border-radius:4px;font-size:0.68rem;cursor:pointer;font-weight:600;" onclick="removeTeamMember(${u.id}, '${esc(u.email)}')">Remove</button>` : ''}
             </div>`
          : '<span style="color:var(--muted);font-size:0.72rem;">You</span>';

        const initials = (u.name || u.email || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        const avatarHtml = u.avatar_url
          ? `<img id="avatar-img-${u.id}" data-user-id="${u.id}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;vertical-align:middle;display:none;" alt="${esc(initials)}">`
            + `<div id="avatar-init-${u.id}" style="width:36px;height:36px;border-radius:50%;background:#ffffff;color:#1a1a2e;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:0.78rem;flex-shrink:0;">${initials}</div>`
          : `<div style="width:36px;height:36px;border-radius:50%;background:#ffffff;color:#1a1a2e;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:0.78rem;flex-shrink:0;">${initials}</div>`;
        const uploadBtn = `<label style="cursor:pointer;font-size:0.72rem;color:var(--gold);white-space:nowrap;"><input type="file" accept="image/*" style="display:none;" onchange="uploadAvatar(${u.id}, this)"> 📷 Photo</label>`;

        const credInput = `<input type="text" value="${esc(u.credentials||'')}" placeholder="e.g. CPA/PFS" 
          style="background:transparent;border:none;border-bottom:1px dashed var(--border);color:var(--muted);font-size:0.68rem;width:80px;outline:none;margin-top:0.2rem;"
          onblur="saveCredentials(${u.id}, this.value)" onkeydown="if(event.key==='Enter')this.blur()">`;

        return `<tr id="team-row-${u.id}">
          <td style="font-weight:600;"><div style="display:flex;align-items:center;gap:0.6rem;">${avatarHtml}<div><div>${esc(u.name || '—')}</div>${credInput}</div></div></td>
          <td style="color:var(--muted);">${esc(u.email)}</td>
          <td style="text-align:center;">${roleCell}</td>
          <td style="text-align:center;">${companiesDisplay}</td>
          <td style="text-align:center;">${statusHtml}</td>
          <td style="color:var(--muted);font-size:0.78rem;">${lastLogin}</td>
          <td><div style="display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;">${actions}${uploadBtn}</div></td>
        </tr>
        <tr id="team-access-${u.id}" style="display:none;">
          <td colspan="7">${renderCompanyAccessRow(u)}</td>
        </tr>`;
      }).join('');
    }

    function renderCompanyAccessRow(u) {
      const allChecked = u.allowed_realm_ids.length === 0;
      let html = '<div class="company-access-row">';
      html += '<strong style="font-size:0.78rem;display:block;margin-bottom:0.5rem;">Company Access for ' + esc(u.name || u.email) + '</strong>';
      html += `<label><input type="checkbox" id="acc-all-${u.id}" ${allChecked ? 'checked' : ''} onchange="toggleAllCompanies(${u.id}, this.checked)"> All companies (unrestricted)</label>`;
      html += '<div style="margin-top:0.5rem;padding-left:1.5rem;" id="acc-list-${u.id}" ' + (allChecked ? 'style="display:none;"' : '') + '>';
      for (const c of firmCompanies) {
        const isAllowed = u.allowed_realm_ids.includes(c.realm_id);
        html += `<label><input type="checkbox" class="acc-realm-${u.id}" value="${c.realm_id}" ${isAllowed ? 'checked' : ''}> ${esc(c.company_name || c.realm_id)}</label>`;
      }
      html += '</div>';
      html += `<button class="btn btn-gold btn-sm" style="margin-top:0.75rem;" onclick="saveCompanyAccess(${u.id})">Save Access</button>`;
      html += '</div>';
      return html;
    }

    async function loadTeamAvatars() {
      const membersWithAvatars = teamData.filter(u => u.avatar_url);
      await Promise.all(membersWithAvatars.map(async u => {
        try {
          const res = await apiFetch(`/firms/team/${u.id}/avatar`);
          if (!res.ok) return;
          const { url } = await res.json();
          if (!url) return;
          const img = qs(`#avatar-img-${u.id}`);
          const initDiv = qs(`#avatar-init-${u.id}`);
          if (img) { img.src = url; img.style.display = ''; }
          if (initDiv) initDiv.style.display = 'none';
        } catch(e) { /* non-fatal */ }
      }));
    }

    function toggleCompanyAccess(userId) {
      const row = qs('#team-access-' + userId);
      if (row) row.style.display = row.style.display === 'none' ? '' : 'none';
    }

    function toggleAllCompanies(userId, allChecked) {
      const list = qs('#acc-list-' + userId);
      if (list) list.style.display = allChecked ? 'none' : '';
    }

    async function saveCompanyAccess(userId) {
      const allCheckbox = qs('#acc-all-' + userId);
      const allChecked = allCheckbox?.checked;
      let realmIds = [];
      if (!allChecked) {
        document.querySelectorAll('.acc-realm-' + userId + ':checked').forEach(cb => realmIds.push(cb.value));
      }
      try {
        const res = await apiFetch('/firms/team/' + userId + '/companies', {
          method: 'PUT',
          body: JSON.stringify({ realmIds }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        toast('Company access saved');
        await loadTeam();
      } catch (e) {
        toast('Failed to save: ' + e.message);
      }
    }

    async function changeUserRole(userId, role) {
      try {
        const res = await apiFetch('/firms/team/' + userId + '/role', {
          method: 'PUT',
          body: JSON.stringify({ role }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        toast('Role updated');
      } catch (e) {
        toast('Failed to update role: ' + e.message);
      }
    }

    function editTeamMember(userId, currentName, currentEmail) {
      const newName = prompt('Name:', currentName);
      if (newName === null) return; // cancelled
      const newEmail = prompt('Email:', currentEmail);
      if (newEmail === null) return;
      if (!newEmail.includes('@')) { toast('Invalid email'); return; }

      apiFetch('/firms/team/' + userId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), email: newEmail.trim().toLowerCase() })
      }).then(r => r.json()).then(data => {
        if (data.error) { toast('Error: ' + data.error); return; }
        toast('Team member updated');
        loadTeam();
      }).catch(e => toast('Failed: ' + e.message));
    }

    async function removeTeamMember(userId, email) {
      if (!confirm('Remove ' + email + ' from your team?')) return;
      try {
        const res = await apiFetch('/firms/team/' + userId, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
        toast('Team member removed');
        await loadTeam();
      } catch (e) {
        toast('Failed to remove: ' + e.message);
      }
    }

    async function saveCredentials(userId, value) {
      try {
        await apiFetch(`/firms/team/${userId}/credentials`, {
          method: 'PUT',
          body: JSON.stringify({ credentials: value.trim() })
        });
      } catch(e) { /* silent */ }
    }

    async function uploadAvatar(userId, input) {
      const file = input.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('avatar', file);
      try {
        const res = await apiFetch(`/firms/team/${userId}/avatar`, { method: 'POST', body: fd });
        const data = await res.json();
        if (res.ok) { toast('Avatar updated'); loadTeam(); }
        else toast('Upload failed: ' + (data.error || 'Unknown error'), 'error');
      } catch(e) { toast('Upload failed: ' + e.message, 'error'); }
    }

    // Invite modal
    function openInviteModal() {
      qs('#invite-email').value = '';
      qs('#invite-name').value = '';
      qs('#invite-role').value = 'admin';
      qs('#invite-result').style.display = 'none';
      qs('#btn-send-invite').disabled = false;
      qs('#btn-send-invite').textContent = 'Send Invite';
      qs('#invite-modal').classList.add('open');
    }
    function closeInviteModal() { qs('#invite-modal').classList.remove('open'); }

    async function sendInvite() {
      const email = qs('#invite-email').value.trim();
      const name = qs('#invite-name').value.trim();
      const role = qs('#invite-role').value;
      if (!email) { toast('Email is required'); return; }

      const btn = qs('#btn-send-invite');
      btn.disabled = true;
      btn.textContent = 'Sending…';

      try {
        const res = await apiFetch('/firms/invite', {
          method: 'POST',
          body: JSON.stringify({ email, name, role }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        const fullUrl = window.location.origin + data.inviteUrl;
        qs('#invite-result').style.display = '';
        qs('#invite-result').innerHTML = `
          <div style="font-size:0.82rem;color:var(--muted);margin-bottom:0.5rem;">Invite link (share with ${esc(email)}):</div>
          <div class="invite-link-box">
            <span class="il-url">${esc(fullUrl)}</span>
            <button class="invite-link-copy" onclick="copyToClipboard('${fullUrl}',this)">Copy</button>
          </div>
        `;
        btn.textContent = 'Send Another';
        btn.disabled = false;
        await loadTeam();
      } catch (e) {
        toast('Failed to send invite: ' + e.message);
        btn.disabled = false;
        btn.textContent = 'Send Invite';
      }
    }

    function copyToClipboard(text, btn) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
      }).catch(() => toast('Copy failed'));
    }

    // ===== TRANSACTION DRILL-DOWN =====
    let cachedAccounts = null; // { realmId, accounts }
    let ddCurrentAccount = null;
    let ddStartDate = null;
    let ddEndDate = null;
    let ddTransactions = [];

    function openDrilldown(account, startDate, endDate, amount) {
      ddCurrentAccount = account;
      ddStartDate = startDate;
      ddEndDate = endDate;
      qs('#dd-account-name').textContent = account + (amount ? ' — ' + amount : '');
      qs('#dd-period').textContent = startDate + ' to ' + endDate;
      qs('#drilldown-body').innerHTML = '<div class="drilldown-loading">Loading transactions…</div>';
      qs('#drilldown-overlay').classList.add('open');
      qs('#drilldown-panel').classList.add('open');
      loadDrilldownTransactions();
    }

    function closeDrilldown() {
      qs('#drilldown-overlay').classList.remove('open');
      qs('#drilldown-panel').classList.remove('open');
    }

    async function loadDrilldownTransactions() {
      try {
        const params = new URLSearchParams({ account: ddCurrentAccount, startDate: ddStartDate, endDate: ddEndDate });
        const res = await apiFetch('/api/companies/' + currentRealm + '/transactions/drilldown?' + params);
        ddTransactions = await res.json();
        if (ddTransactions.error) throw new Error(ddTransactions.error);
        renderDrilldownTable();
      } catch (e) {
        qs('#drilldown-body').innerHTML = '<div class="drilldown-loading" style="color:var(--red);">Failed to load: ' + esc(e.message) + '</div>';
      }
    }

    function renderDrilldownTable() {
      if (!ddTransactions.length) {
        qs('#drilldown-body').innerHTML = '<div class="drilldown-loading">No transactions found for this account and period.</div>';
        return;
      }
      let html = '<table class="drilldown-table">';
      html += '<thead><tr><th>Date</th><th>Type</th><th>Name</th><th>Memo</th><th class="dd-amount">Amount</th><th></th></tr></thead><tbody>';
      ddTransactions.forEach((t, i) => {
        const rawAmt = t.amount == null ? 0 : Number(t.amount);
        const amt = rawAmt >= 0 ? '$' + rawAmt.toLocaleString(undefined, {minimumFractionDigits:2}) : '<span style="color:var(--red);">($' + Math.abs(rawAmt).toLocaleString(undefined, {minimumFractionDigits:2}) + ')</span>';
        html += `<tr id="ddr-${i}">
          <td style="white-space:nowrap;">${esc(t.date)}</td>
          <td style="color:var(--muted);">${esc(t.type)}</td>
          <td>${esc(t.name)}</td>
          <td style="color:var(--muted);font-size:0.75rem;">${esc(t.memo)}</td>
          <td class="dd-amount">${amt}</td>
          <td><button class="btn-recode" onclick="showRecodeForm(${i})">Recode</button></td>
        </tr>
        <tr id="ddr-recode-${i}" class="recode-row" style="display:none;">
          <td colspan="6"><div id="recode-form-${i}"></div></td>
        </tr>`;
      });
      html += '</tbody></table>';
      qs('#drilldown-body').innerHTML = html;
    }

    async function getAccountsForRecode() {
      if (cachedAccounts && cachedAccounts.realmId === currentRealm) return cachedAccounts.accounts;
      try {
        const res = await apiFetch('/api/companies/' + currentRealm + '/accounts');
        const accounts = await res.json();
        cachedAccounts = { realmId: currentRealm, accounts };
        return accounts;
      } catch (e) {
        return [];
      }
    }

    async function showRecodeForm(idx) {
      // Hide any other open recode forms
      document.querySelectorAll('[id^="ddr-recode-"]').forEach(r => r.style.display = 'none');
      const recodeRow = qs('#ddr-recode-' + idx);
      recodeRow.style.display = '';

      const formEl = qs('#recode-form-' + idx);
      formEl.innerHTML = '<div style="color:var(--muted);font-size:0.78rem;padding:0.5rem;">Loading accounts…</div>';

      const accounts = await getAccountsForRecode();
      if (!accounts.length) {
        formEl.innerHTML = '<div style="color:var(--red);font-size:0.78rem;padding:0.5rem;">Failed to load accounts</div>';
        return;
      }

      // Group accounts by type
      const byType = {};
      for (const a of accounts) {
        if (!a.active) continue;
        if (!byType[a.type]) byType[a.type] = [];
        byType[a.type].push(a);
      }

      let opts = '';
      for (const [type, accs] of Object.entries(byType)) {
        opts += `<optgroup label="${esc(type)}">`;
        for (const a of accs) {
          const selected = a.fullName === ddCurrentAccount || a.name === ddCurrentAccount ? ' selected' : '';
          opts += `<option value="${esc(a.fullName)}"${selected}>${esc(a.fullName)}</option>`;
        }
        opts += '</optgroup>';
      }

      formEl.innerHTML = `
        <div style="padding:0.5rem 0;">
          <div style="font-size:0.75rem;color:var(--muted);margin-bottom:0.35rem;">Recode to:</div>
          <select class="recode-select" id="recode-select-${idx}">${opts}</select>
          <div class="recode-actions">
            <button class="btn-recode-save" onclick="saveRecode(${idx})">Save</button>
            <button class="btn-recode-cancel" onclick="cancelRecode(${idx})">Cancel</button>
          </div>
        </div>
      `;
    }

    function cancelRecode(idx) {
      qs('#ddr-recode-' + idx).style.display = 'none';
    }

    async function saveRecode(idx) {
      const t = ddTransactions[idx];
      const newAccount = qs('#recode-select-' + idx)?.value;
      if (!newAccount) return;

      const btn = qs('#ddr-recode-' + idx).querySelector('.btn-recode-save');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

      try {
        console.log('[recode] sending:', { txnId: t.txnId, txnType: t.type, newAccount });
        const res = await apiFetch('/api/companies/' + currentRealm + '/transactions/recode', {
          method: 'POST',
          body: JSON.stringify({ txnId: t.txnId, txnType: t.type, newAccount }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || JSON.stringify(data));

        // Update the row visually — remove from list since it moved accounts
        ddTransactions.splice(idx, 1);
        const recodeRow = qs('#ddr-recode-' + idx);
        const origRow = qs('#ddr-' + idx);
        if (recodeRow) recodeRow.remove();
        if (origRow) origRow.remove();

        toast('✅ Recoded to ' + newAccount.split(':').pop() + ' — P&L refreshing in background…');

        // Refresh the report in background without closing drawer
        setTimeout(() => reloadCurrentSection(), 800);
      } catch (e) {
        toast('Recode failed: ' + e.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
      }
    }

    // ===== HELPERS =====
    function esc(s) { const d=document.createElement('div'); d.textContent=s||''; return d.innerHTML; }
    function toast(msg) { const el=qs('#toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3000); }

    function logout() {
      fetch('/api/account-security/sessions/current/revoke', { method: 'POST', keepalive: true, headers: { 'Authorization': 'Bearer ' + localStorage.getItem('dl_token') } }).catch(() => {});
      localStorage.removeItem('dl_token');
      localStorage.removeItem('dl_firm');
      window.location.replace('/login');
    }

    // ===== STATEMENTS =====
    // current month helper (YYYY-MM)
    // ===== STATEMENTS (per-client) =====

    function stmtCurrentMonth() {
      const d = new Date();
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    }

    const METHOD_LABELS = {
      qbo_pull: 'QBO Pull', portal: 'Portal Download', manual: 'Manual Download',
      email: 'Email', client_upload: 'Client Upload',
      qbo: 'QBO Pull', client: 'Client Upload' // legacy compat
    };

    // ===== STATEMENTS PAGE (account setup + health overview) =====

    async function loadStatementsView() {
      if (!currentRealm) {
        qs('#stmt-table-wrap').innerHTML = '<div style="text-align:center;padding:3rem;color:var(--muted);">Select a client to view statements.</div>';
        qs('#stmt-page-title').textContent = 'Statements';
        qs('#stmt-subtitle').textContent = '';
        qs('#stmt-summary').style.display = 'none';
        return;
      }

      const month = stmtCurrentMonth();
      const company = companies.find(c => c.realm_id === currentRealm);
      qs('#stmt-page-title').textContent = 'Statements — ' + (company?.company_name || currentRealm);

      const wrapEl = qs('#stmt-table-wrap');
      wrapEl.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">Loading…</div>';
      qs('#stmt-summary').style.display = 'none';

      try {
        const res = await apiFetch('/api/companies/' + currentRealm + '/statements/accounts?month=' + encodeURIComponent(month));
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        const accounts = data.accounts || [];

        // Auto-save new QBO accounts that haven't been saved yet
        const newAccounts = accounts.filter(a => a._new && !a.id);
        for (const a of newAccounts) {
          try {
            const saveRes = await apiFetch('/api/companies/' + currentRealm + '/statements', {
              method: 'POST',
              body: JSON.stringify({
                account_name: a.account_name, institution: '', access_method: 'qbo_pull',
                statement_day: 1, qb_account_id: a.qb_account_id || ''
              })
            });
            if (saveRes.ok) {
              const saved = await saveRes.json();
              a.id = saved.id;
              a._new = false;
            }
          } catch(e) { /* skip */ }
        }

        // Compute overall currency subtitle
        const savedAccounts = accounts.filter(a => a.id);
        const behind = savedAccounts.filter(a => (a.months_behind || 0) > 0);
        if (savedAccounts.length > 0) {
          if (behind.length === 0) {
            qs('#stmt-subtitle').innerHTML = 'All current <span style="color:var(--green)">✅</span>';
          } else {
            qs('#stmt-subtitle').innerHTML = `<span style="color:var(--red)">${behind.length} account${behind.length > 1 ? 's' : ''} behind 🔴</span>`;
          }
        } else {
          qs('#stmt-subtitle').textContent = '';
        }

        if (accounts.length > 0) {
          qs('#stmt-summary').style.display = '';
          qs('#stmt-stats-grid').innerHTML = `
            <div class="stat-card"><div class="stat-label">Total Accounts</div><div class="stat-value">${accounts.length}</div></div>
            <div class="stat-card"><div class="stat-label">Current</div><div class="stat-value green">${savedAccounts.length - behind.length}</div></div>
            <div class="stat-card"><div class="stat-label">Behind</div><div class="stat-value ${behind.length > 0 ? 'orange' : 'green'}">${behind.length}</div></div>
          `;
        }

        wrapEl.innerHTML = renderStmtTable(accounts, currentRealm, month);

      } catch(e) {
        wrapEl.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red);">Failed: ' + esc(e.message) + '</div>';
      }
    }

    function renderStmtTable(accounts, realmId, month) {
      if (!accounts.length) {
        return '<div style="text-align:center;padding:2rem;color:var(--muted);">No accounts found. Add one manually or wait for QBO accounts to appear.</div>';
      }

      let html = `<div class="table-wrap"><table class="stmt-table">
        <thead><tr>
          <th>Account</th>
          <th>Type</th>
          <th>Method</th>
          <th>Statement Day</th>
          <th>Status</th>
          <th>Actions</th>
        </tr></thead><tbody>`;

      for (const a of accounts) {
        const typeLabel = [a.accountType, a.accountSubType].filter(Boolean).join(' / ') || (a._manual ? 'Manual' : '—');
        const monthsBehind = a.months_behind || 0;

        let statusCell;
        if (!a.id) {
          statusCell = `<span style="color:var(--muted);font-size:0.75rem;">Not saved</span>`;
        } else if (!a.last_retrieved_month) {
          statusCell = `<span style="color:var(--muted);font-size:0.75rem;">No history</span>`;
        } else if (monthsBehind === 0) {
          statusCell = `<span style="color:var(--green);font-size:0.8rem;">✅ Current</span>`;
        } else if (monthsBehind === 1) {
          statusCell = `<span style="color:var(--orange);font-size:0.8rem;">🟠 1 month behind</span>`;
        } else {
          statusCell = `<span style="color:var(--red);font-size:0.8rem;">🔴 ${monthsBehind} months behind</span>`;
        }

        let markCurrentBtn = '';
        if (a.id && monthsBehind > 0) {
          const label = monthsBehind >= 3 ? `Clear ${monthsBehind}-Month Backlog` : 'Mark Current';
          markCurrentBtn = `<button class="btn btn-gold btn-sm" onclick="markStmtCurrent('${realmId}',${a.id},this)">${label}</button>`;
        }

        const methodSel = Object.entries(METHOD_LABELS).filter(([k]) => !['qbo','client'].includes(k)).map(([k,v]) =>
          `<option value="${k}"${(a.access_method||'qbo_pull')===k?' selected':''}>${v}</option>`
        ).join('');

        html += `<tr id="stmtrow-${a.id || 'new'}">
          <td style="font-weight:500;">${esc(a.account_name)}</td>
          <td style="font-size:0.78rem;color:var(--muted);">${esc(typeLabel)}</td>
          <td>
            ${a.id ? `<select class="stmt-select" onchange="updateStmtMethod('${realmId}',${a.id},this)">${methodSel}</select>` : `<span style="color:var(--muted);font-size:0.78rem;">${esc(METHOD_LABELS[a.access_method] || a.access_method || '—')}</span>`}
          </td>
          <td>
            ${a.id ? `<input class="stmt-input stmt-day-input" type="number" min="1" max="31" value="${a.statement_day || 1}" style="width:60px;" onblur="updateStmtDay('${realmId}',${a.id},this)">` : `<span style="color:var(--muted);">${a.statement_day || 1}</span>`}
          </td>
          <td>${statusCell}</td>
          <td style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;">
            ${markCurrentBtn}
            ${a._manual && a.id ? `<button class="btn-icon" onclick="deleteStmtAccount('${realmId}',${a.id})" title="Delete">🗑</button>` : ''}
          </td>
        </tr>`;
      }

      html += `</tbody></table></div>`;
      return html;
    }

    async function updateStmtMethod(realmId, id, selectEl) {
      try {
        const res = await apiFetch('/api/companies/' + realmId + '/statements/' + id, {
          method: 'PUT', body: JSON.stringify({ access_method: selectEl.value })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch(e) {
        toast('Save failed: ' + e.message);
      }
    }

    async function updateStmtDay(realmId, id, inputEl) {
      const day = parseInt(inputEl.value) || 1;
      inputEl.value = Math.max(1, Math.min(31, day));
      try {
        const res = await apiFetch('/api/companies/' + realmId + '/statements/' + id, {
          method: 'PUT', body: JSON.stringify({ statement_day: parseInt(inputEl.value) })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch(e) {
        toast('Save failed: ' + e.message);
      }
    }

    async function markStmtCurrent(realmId, id, btn) {
      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = '…';
      try {
        const res = await apiFetch('/api/companies/' + realmId + '/statements/' + id + '/mark-current', { method: 'PUT', body: '{}' });
        if (!res.ok) throw new Error((await res.json()).error);
        toast('Account marked current — backlog cleared');
        await loadStatementsView();
      } catch(e) {
        btn.disabled = false;
        btn.textContent = origText;
        toast('Failed: ' + e.message);
      }
    }

    async function deleteStmtAccount(realmId, id) {
      if (!confirm('Delete this statement account?')) return;
      try {
        const res = await apiFetch('/api/companies/' + realmId + '/statements/' + id, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
        toast('Account deleted');
        await loadStatementsView();
      } catch(e) {
        toast('Delete failed: ' + e.message);
      }
    }

    function showStmtAddForm() {
      qs('#stmt-add-form').style.display = '';
      qs('#stmt-new-name')?.focus();
    }

    function hideStmtAddForm() {
      qs('#stmt-add-form').style.display = 'none';
      if (qs('#stmt-new-name')) qs('#stmt-new-name').value = '';
      if (qs('#stmt-new-inst')) qs('#stmt-new-inst').value = '';
      if (qs('#stmt-new-day')) qs('#stmt-new-day').value = '1';
    }

    async function saveNewStmtAccount() {
      if (!currentRealm) { toast('Select a client first'); return; }
      const name = qs('#stmt-new-name')?.value.trim();
      if (!name) { toast('Account name is required'); return; }
      const institution = qs('#stmt-new-inst')?.value.trim() || '';
      const method = qs('#stmt-new-method')?.value || 'portal';
      const day = parseInt(qs('#stmt-new-day')?.value || 1);

      try {
        const res = await apiFetch('/api/companies/' + currentRealm + '/statements', {
          method: 'POST',
          body: JSON.stringify({ account_name: name, institution, access_method: method, statement_day: day })
        });
        if (!res.ok) throw new Error((await res.json()).error);
        toast('Account added');
        hideStmtAddForm();
        await loadStatementsView();
      } catch(e) {
        toast('Add failed: ' + e.message);
      }
    }

    // ===== STATEMENTS CALENDAR — heatmap + day drawer =====

    let calCurrentMonth = stmtCurrentMonth();
    let calDaysData = {}; // day -> {day, total, retrieved, pending, items[]}

    function initCalendarView() {
      if (!calCurrentMonth) calCurrentMonth = stmtCurrentMonth();
      qs('#cal-month-display').textContent = calMonthLabel(calCurrentMonth);
      loadCalendarView();
    }

    function calMonthLabel(ym) {
      const [y, m] = ym.split('-');
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      return (months[parseInt(m)-1] || m) + ' ' + y;
    }

    function calChangeMonth(delta) {
      const [y, m] = calCurrentMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + delta, 1);
      calCurrentMonth = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
      qs('#cal-month-display').textContent = calMonthLabel(calCurrentMonth);
      closeDayDrawer();
      loadCalendarView();
    }

    async function loadCalendarView() {
      const month = calCurrentMonth || stmtCurrentMonth();
      const bodyEl = qs('#stmt-calendar-body');
      const statsEl = qs('#cal-stats');
      bodyEl.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--muted);">Loading calendar…</div>';
      statsEl.style.display = 'none';

      try {
        const res = await apiFetch('/api/statements/calendar?month=' + encodeURIComponent(month));
        const data = await res.json();
        if (data.error) throw new Error(data.error);

        const days = data.days || [];
        calDaysData = {};
        let total = 0, retrieved = 0;
        for (const d of days) {
          calDaysData[d.day] = d;
          total += d.total;
          retrieved += d.retrieved;
        }
        const pending = total - retrieved;
        const pct = total > 0 ? Math.round(retrieved / total * 100) : 0;

        if (total > 0) {
          statsEl.style.display = '';
          qs('#cal-stats-grid').innerHTML = `
            <div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value">${total}</div></div>
            <div class="stat-card"><div class="stat-label">Retrieved</div><div class="stat-value green">${retrieved}</div></div>
            <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value orange">${pending}</div></div>
            <div class="stat-card"><div class="stat-label">Complete</div><div class="stat-value">${pct}%</div></div>
          `;
          qs('#cal-pct-label').textContent = `${retrieved} of ${total} retrieved (${pct}%)`;
          qs('#cal-progress-fill').style.width = pct + '%';
        }

        // Build compact heatmap — 1 through 31
        let html = '<div class="cal-heatmap">';
        for (let day = 1; day <= 31; day++) {
          const d = calDaysData[day];
          if (!d) {
            // quiet day
            html += `<div class="cal-hm-day"><div class="cal-hm-num" style="color:rgba(143,163,184,0.3);">${day}</div></div>`;
          } else {
            // determine color class
            let colorClass = 'all-pending';
            if (d.pending === 0) colorClass = 'all-retrieved';
            else if (d.retrieved > 0) colorClass = 'mixed';

            const pendBadge = d.pending > 0 ? `<span class="cal-hm-badge">🟠 ${d.pending}</span>` : '';
            const retBadge = d.retrieved > 0 ? `<span class="cal-hm-badge">✅ ${d.retrieved}</span>` : '';

            html += `<div class="cal-hm-day has-items ${colorClass}" onclick="openDayDrawer(${day})" title="Day ${day}: ${d.total} statements">
              <div class="cal-hm-num">${day}</div>
              <div class="cal-hm-badges">${pendBadge}${retBadge}</div>
            </div>`;
          }
        }
        html += '</div>';

        bodyEl.innerHTML = html;
      } catch(e) {
        bodyEl.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--red);">Failed: ' + esc(e.message) + '</div>';
      }
    }

    // ===== DAY DRAWER =====

    function openDayDrawer(day) {
      const d = calDaysData[day];
      if (!d) return;

      const monthLabel = calMonthLabel(calCurrentMonth);
      qs('#day-drawer-title').textContent = `Day ${day} — ${monthLabel}`;
      updateDrawerProgress(d);
      renderDrawerItems(d);

      qs('#day-drawer-overlay').classList.add('open');
      qs('#day-drawer').classList.add('open');
    }

    function closeDayDrawer() {
      qs('#day-drawer-overlay').classList.remove('open');
      qs('#day-drawer').classList.remove('open');
    }

    function updateDrawerProgress(d) {
      const pct = d.total > 0 ? Math.round(d.retrieved / d.total * 100) : 0;
      qs('#day-drawer-prog-label').textContent = `${d.retrieved} of ${d.total} retrieved`;
      qs('#day-drawer-prog-fill').style.width = pct + '%';
    }

    function renderDrawerItems(d) {
      if (!d || !d.items || d.items.length === 0) {
        qs('#day-drawer-body').innerHTML = '<div style="padding:2rem;text-align:center;color:var(--muted);">No statements for this day.</div>';
        return;
      }

      // Sort: pending first, retrieved at bottom
      const sorted = [...d.items].sort((a, b) => {
        if (a.isRetrieved === b.isRetrieved) return 0;
        return a.isRetrieved ? 1 : -1;
      });

      let html = '';
      for (const item of sorted) {
        const methodLabel = METHOD_LABELS[item.method] || item.method || '—';
        const retrievedDate = item.retrievedAt ? new Date(item.retrievedAt).toLocaleDateString() : '';

        html += `<div class="day-drawer-row${item.isRetrieved ? ' retrieved' : ''}" id="ddr-${item.id}">
          <div class="dd-row-info">
            <div class="dd-row-company">${esc(item.companyName || item.realmId)}</div>
            <div class="dd-row-account">${esc(item.accountName)}</div>
          </div>
          <span class="dd-row-method">${esc(methodLabel)}</span>
          <div class="dd-row-action">
            ${item.isRetrieved
              ? `<span class="dd-retrieved-date">✅ ${retrievedDate}</span>`
              : `<button class="btn-dd-retrieve" onclick="drawerMarkRetrieved('${item.realmId}',${item.id},${d.day})">✓</button>`
            }
          </div>
        </div>`;
      }
      qs('#day-drawer-body').innerHTML = html;
    }

    async function drawerMarkRetrieved(realmId, id, day) {
      const btn = qs(`#ddr-${id} .btn-dd-retrieve`);
      if (btn) { btn.disabled = true; btn.textContent = '…'; }

      try {
        const res = await apiFetch('/api/companies/' + realmId + '/statements/' + id + '/retrieve', { method: 'POST', body: '{}' });
        if (!res.ok) throw new Error((await res.json()).error);

        // Update the in-memory item
        const d = calDaysData[day];
        if (d) {
          const item = d.items.find(i => i.id === id);
          if (item) {
            item.isRetrieved = true;
            item.retrievedAt = new Date().toISOString();
            d.retrieved++;
            d.pending--;
          }
          // Refresh drawer UI
          updateDrawerProgress(d);
          renderDrawerItems(d);
          // Refresh the heatmap box
          refreshHeatmapBox(day, d);
        }

        toast('Marked as retrieved');
      } catch(e) {
        if (btn) { btn.disabled = false; btn.textContent = '✓'; }
        toast('Failed: ' + e.message);
      }
    }

    function refreshHeatmapBox(day, d) {
      // Update the stats bar
      let total = 0, retrieved = 0;
      for (const dd of Object.values(calDaysData)) { total += dd.total; retrieved += dd.retrieved; }
      const pct = total > 0 ? Math.round(retrieved / total * 100) : 0;
      const pending = total - retrieved;
      qs('#cal-stats-grid').innerHTML = `
        <div class="stat-card"><div class="stat-label">This Month</div><div class="stat-value">${total}</div></div>
        <div class="stat-card"><div class="stat-label">Retrieved</div><div class="stat-value green">${retrieved}</div></div>
        <div class="stat-card"><div class="stat-label">Pending</div><div class="stat-value orange">${pending}</div></div>
        <div class="stat-card"><div class="stat-label">Complete</div><div class="stat-value">${pct}%</div></div>
      `;
      qs('#cal-pct-label').textContent = `${retrieved} of ${total} retrieved (${pct}%)`;
      qs('#cal-progress-fill').style.width = pct + '%';

      // Re-render just this day box
      const boxes = document.querySelectorAll('.cal-hm-day');
      for (const box of boxes) {
        // find by onclick attribute
        if (box.getAttribute('onclick') === `openDayDrawer(${day})`) {
          let colorClass = 'all-pending';
          if (d.pending === 0) colorClass = 'all-retrieved';
          else if (d.retrieved > 0) colorClass = 'mixed';
          box.className = `cal-hm-day has-items ${colorClass}`;
          const pendBadge = d.pending > 0 ? `<span class="cal-hm-badge">🟠 ${d.pending}</span>` : '';
          const retBadge = d.retrieved > 0 ? `<span class="cal-hm-badge">✅ ${d.retrieved}</span>` : '';
          box.innerHTML = `<div class="cal-hm-num">${day}</div><div class="cal-hm-badges">${pendBadge}${retBadge}</div>`;
          break;
        }
      }
    }

    // Handle ?section= BEFORE init so calendar/team shows even without companies
