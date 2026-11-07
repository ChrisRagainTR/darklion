// Dashboard overview intelligence, cards, and charts.
// Loaded after dashboard.js so it can use shared helpers like apiFetch(), esc(), and formatPersonDisplayName().
    function renderMrrStamp(ts) {
      const el = document.getElementById('ds-mrr-stamp');
      if (!el) return;
      if (!ts) { el.textContent = ''; return; }
      const ageHours = Math.floor((Date.now() - new Date(ts).getTime()) / 3600000);
      el.textContent = ageHours < 1 ? 'just now' : ageHours < 24 ? ageHours + 'h ago' : Math.floor(ageHours / 24) + 'd ago';
    }

    async function refreshMrrNow() {
      const btn = document.getElementById('ds-mrr-refresh');
      const stamp = document.getElementById('ds-mrr-stamp');
      if (btn) { btn.disabled = true; btn.textContent = '…'; }
      if (stamp) stamp.textContent = 'refreshing…';
      try {
        const r = await apiFetch('/api/dashboard/refresh-mrr', { method: 'POST' });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'refresh failed');
        const el = document.getElementById('ds-mrr');
        if (el) el.textContent = d.mrr > 0 ? '$' + Math.round(d.mrr).toLocaleString() + (d.past_due ? ' ⚠️' : '') : '—';
        if (stamp) stamp.textContent = 'just now';
      } catch(e) {
        if (stamp) stamp.textContent = 'refresh failed';
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '↻'; }
      }
    }

    async function loadDashboardIntel() {
      // Greeting + date
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';
      const greetEl = document.getElementById('dash-greeting');
      const dateEl = document.getElementById('dash-date');
      if (greetEl) greetEl.textContent = greeting;
      if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });

      const setStat = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
      const setBadge = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

      try {
        const res = await apiFetch('/api/dashboard/intel');
        if (!res.ok) throw new Error('failed');
        const d = await res.json();

        // Stats
        setStat('ds-relationships', d.counts?.relationships ?? '—');
        setStat('ds-companies', d.counts?.companies ?? '—');
        setStat('ds-open-msgs', d.counts?.open_messages ?? '—');
        setStat('ds-mrr', d.mrr > 0 ? '$' + Math.round(d.mrr).toLocaleString() + (d.mrr_past_due ? ' ⚠️' : '') : '—');
        renderMrrStamp(d.mrr_computed_at);
        setStat('ds-proposals', d.open_proposals?.length ?? '—');

        // Charts (wait for Chart.js CDN to finish loading before rendering)
        await window._chartJsReady;
        renderProposalChart(d.proposal_chart || []);
        renderClientMixChart(d.counts || {});

        // Intel cards
        renderUnsigned(d.unsigned_returns || []);
        renderStalled(d.stalled_messages || []);
        renderProposals(d.open_proposals || []);
        renderBirthdays(d.birthdays || []);
        renderPortalInactive(d.portal_inactive || []);
        renderNoPipeline(d.no_pipeline || []);

      } catch(e) {
        console.error('Dashboard intel error:', e);
        // Show error state on all intel cards so they don't stay stuck on "Loading…"
        ['list-unsigned','list-stalled','list-proposals','list-birthdays','list-portal','list-nopipeline'].forEach(id => {
          const el = document.getElementById(id);
          if (el && el.innerHTML.includes('Loading')) {
            el.innerHTML = '<div class="dash-intel-empty" style="color:var(--red)">Failed to load — refresh to retry</div>';
          }
        });
        ['ds-relationships','ds-companies','ds-open-msgs','ds-mrr','ds-proposals'].forEach(id => {
          const el = document.getElementById(id);
          if (el && el.textContent === '—') el.textContent = '?';
        });
      }
    }

    let _allUnsignedReturns = [];

    function unsignedNavUrl(r) {
      if (r.company_id) return '/crm/company/' + r.company_id;
      if (r.person_id) return '/crm/person/' + r.person_id;
      if (r.relationship_id) return '/crm/relationship/' + r.relationship_id;
      if (r.person_relationship_id) return '/crm/relationship/' + r.person_relationship_id;
      return null;
    }

    function buildUnsignedRow(r, showRelationship) {
      const name = r.company_name || r.person_name || 'Unknown';
      const url = unsignedNavUrl(r);
      const sub = esc(r.tax_year||'') + ' · ' + r.days_waiting + 'd waiting' + (showRelationship && r.relationship_name ? ' · ' + esc(r.relationship_name) : '');
      if (!url) return '<div class="dash-intel-row"><div><div class="dash-intel-name">' + esc(name) + '</div><div class="dash-intel-sub">' + sub + '</div></div><span class="dash-intel-tag" style="background:rgba(245,101,101,0.12);color:var(--red);">Unsigned</span></div>';
      return '<a href="' + url + '" class="dash-intel-row" style="text-decoration:none;" onclick="sessionStorage.setItem(\'openTab\',\'tax\')"><div><div class="dash-intel-name">' + esc(name) + '</div><div class="dash-intel-sub">' + sub + '</div></div><span class="dash-intel-tag" style="background:rgba(245,101,101,0.12);color:var(--red);">Unsigned</span></a>';
    }

    function renderUnsigned(items) {
      _allUnsignedReturns = items;
      setBadge('badge-unsigned', items.length);
      const el = document.getElementById('list-unsigned');
      if (!items.length) { el.innerHTML = '<div class="dash-intel-empty">✅ All returns signed</div>'; return; }
      let html = items.slice(0, 6).map(function(r) { return buildUnsignedRow(r, false); }).join('');
      html += '<div class="dash-intel-row" onclick="showAllUnsigned()" style="cursor:pointer;justify-content:center;border-bottom:none;">' +
        '<span style="font-size:0.78rem;color:var(--gold);font-weight:600;">' + (items.length > 6 ? 'Show all ' + items.length + ' unsigned returns →' : 'View all →') + '</span>' +
        '</div>';
      el.innerHTML = html;
    }

    function showAllUnsigned() {
      const modal = document.getElementById('unsigned-all-modal');
      if (!modal) return;
      const body = document.getElementById('unsigned-all-body');
      body.innerHTML = _allUnsignedReturns.map(function(r) { return buildUnsignedRow(r, true); }).join('');
      modal.classList.add('open');
    }

    function renderStalled(items) {
      setBadge('badge-stalled', items.length);
      const el = document.getElementById('list-stalled');
      if (!items.length) { el.innerHTML = '<div class="dash-intel-empty">✅ No stalled threads</div>'; return; }
      el.innerHTML = items.slice(0,5).map(t => {
        const name = formatPersonDisplayName({ first_name: t.first_name, last_name: t.last_name, spouse_name: t.spouse_name }) || 'Unknown';
        return `<div class="dash-intel-row" onclick="window.location='/messages'">
          <div><div class="dash-intel-name">${esc(name)}</div><div class="dash-intel-sub">${esc(t.subject||'(no subject)')} · ${t.days_since}d</div></div>
          <span class="dash-intel-tag" style="background:rgba(237,137,54,0.12);color:#ed8936;">${t.unread_count > 0 ? t.unread_count + ' unread' : 'No reply'}</span>
        </div>`;
      }).join('');
    }

    function renderProposals(items) {
      setBadge('badge-proposals', items.length);
      const el = document.getElementById('list-proposals');
      if (!items.length) { el.innerHTML = '<div class="dash-intel-empty">No open proposals</div>'; return; }
      el.innerHTML = items.slice(0,5).map(p => {
        const statusColor = p.status === 'viewed' ? 'rgba(74,144,217,0.12);color:#4a90d9' : 'rgba(201,168,76,0.12);color:var(--gold)';
        return `<div class="dash-intel-row" onclick="window.location='/proposals'">
          <div><div class="dash-intel-name">${esc(p.client_name)}</div><div class="dash-intel-sub">${p.days_old}d old · ${p.engagement_type === 'wealth' ? 'Wealth' : 'Tax'}</div></div>
          <span class="dash-intel-tag" style="background:${statusColor};">${p.status === 'viewed' ? 'Viewed' : 'Sent'}</span>
        </div>`;
      }).join('');
    }

    function renderBirthdays(items) {
      setBadge('badge-birthdays', items.length);
      const el = document.getElementById('list-birthdays');
      if (!items.length) { el.innerHTML = '<div class="dash-intel-empty">No birthdays this month</div>'; return; }
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const mon = months[new Date().getMonth()];
      el.innerHTML = items.slice(0,5).map(b => {
        const isToday = b.is_today;
        return `<div class="dash-intel-row" onclick="window.location='/crm/person/${b.id}'">
          <div><div class="dash-intel-name">${esc(formatPersonDisplayName(b))}</div><div class="dash-intel-sub">${esc(b.relationship_name||'')} · ${mon} ${b.birthday_day}</div></div>
          <span class="dash-intel-tag" style="background:${isToday?'rgba(62,207,142,0.15);color:var(--green)':'rgba(201,168,76,0.12);color:var(--gold)'};">${isToday ? '🎂 Today!' : mon + ' ' + b.birthday_day}</span>
        </div>`;
      }).join('');
    }

    function renderPortalInactive(items) {
      setBadge('badge-portal', items.length);
      const el = document.getElementById('list-portal');
      if (!items.length) { el.innerHTML = '<div class="dash-intel-empty">✅ All portals active</div>'; return; }
      el.innerHTML = items.slice(0,5).map(p => {
        const name = formatPersonDisplayName(p);
        const label = p.days_since_login ? p.days_since_login + 'd ago' : 'Never logged in';
        return `<div class="dash-intel-row" onclick="window.location='/crm/person/${p.id}'">
          <div><div class="dash-intel-name">${esc(name)}</div><div class="dash-intel-sub">${esc(p.relationship_name||'')}</div></div>
          <span class="dash-intel-tag" style="background:rgba(143,163,184,0.1);color:var(--muted);">${label}</span>
        </div>`;
      }).join('');
    }

    function renderNoPipeline(items) {
      setBadge('badge-nopipeline', items.length);
      const el = document.getElementById('list-nopipeline');
      if (!items.length) { el.innerHTML = '<div class="dash-intel-empty">✅ All new clients in pipeline</div>'; return; }
      el.innerHTML = items.slice(0,5).map(r => {
        return `<div class="dash-intel-row" onclick="window.location='/crm/relationship/${r.id}'">
          <div><div class="dash-intel-name">${esc(r.name)}</div><div class="dash-intel-sub">Added ${r.days_old}d ago · no pipeline</div></div>
          <a href="/pipelines" onclick="event.stopPropagation()" class="dash-intel-tag" style="background:rgba(201,168,76,0.12);color:var(--gold);text-decoration:none;">+ Add</a>
        </div>`;
      }).join('');
    }

    async function loadBookkeeperCard() {
      try {
        const r = await apiFetch('/api/bookkeeper/overview');
        const data = await r.json();
        setBadge('badge-bookkeeper', data.pendingCount || 0);
        const el = document.getElementById('list-bookkeeper');
        if (!el) return;
        if (!data.pendingCount) {
          const lastRun = data.recentRuns?.[0];
          const runInfo = lastRun ? `Last run: ${new Date(lastRun.started_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})} — ${lastRun.txns_auto_coded||0} auto-coded` : 'No runs yet';
          el.innerHTML = `<div class="dash-intel-empty">✅ All caught up. ${esc(runInfo)}</div>`;
        } else {
          el.innerHTML = `<div class="dash-intel-row" onclick="window.location='/bookkeeper'" style="cursor:pointer;">
            <div><div class="dash-intel-name">${data.pendingCount} transaction${data.pendingCount!==1?'s':''} need review</div>
            <div class="dash-intel-sub">Across ${data.pendingCompanies} company${data.pendingCompanies!==1?'ies':'y'} · ${data.totalMappings} mapping rules</div></div>
            <span class="dash-intel-tag" style="background:rgba(237,137,54,0.12);color:var(--orange);">Review</span>
          </div>`;
        }
      } catch(e) {
        const el = document.getElementById('list-bookkeeper');
        if (el) el.innerHTML = '<div class="dash-intel-empty">Bookkeeper not configured</div>';
      }
    }

    function setBadge(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

    function chartEmptyState(ctx, message) {
      const inner = ctx.parentElement; // .dash-chart-inner
      ctx.style.display = 'none';
      const empty = document.createElement('div');
      empty.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-size:0.8rem;font-style:italic;';
      empty.textContent = message || 'No data yet';
      inner.appendChild(empty);
    }

    function renderProposalChart(data) {
      const ctx = document.getElementById('chart-proposals');
      if (!ctx || !window.Chart) return;
      if (!data || !data.length) { chartEmptyState(ctx, 'No proposals in last 6 months'); return; }
      const labels = data.map(d => d.month);
      const sent = data.map(d => parseInt(d.sent||0));
      const accepted = data.map(d => parseInt(d.accepted||0));
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            { label: 'Sent', data: sent, backgroundColor: 'rgba(74,144,217,0.35)', borderColor: '#4a90d9', borderWidth: 1, borderRadius: 4 },
            { label: 'Accepted', data: accepted, backgroundColor: 'rgba(62,207,142,0.35)', borderColor: '#3ecf8e', borderWidth: 1, borderRadius: 4 },
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#8fa3b8', font: { size: 10 }, boxWidth: 10 } } },
          scales: {
            x: { ticks: { color: '#8fa3b8', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.04)' } },
            y: { ticks: { color: '#8fa3b8', font: { size: 10 }, stepSize: 1 }, grid: { color: 'rgba(255,255,255,0.04)' }, beginAtZero: true }
          }
        }
      });
    }

    function renderClientMixChart(counts) {
      const ctx = document.getElementById('chart-clients');
      if (!ctx || !window.Chart) return;
      const rels = parseInt(counts.relationships||0);
      const people = parseInt(counts.people||0);
      const cos = parseInt(counts.companies||0);
      if (!rels && !people && !cos) { chartEmptyState(ctx, 'No clients yet'); return; }
      new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: ['Relationships', 'People', 'Companies'],
          datasets: [{
            data: [rels, people, cos],
            backgroundColor: ['rgba(201,168,76,0.7)', 'rgba(74,144,217,0.7)', 'rgba(62,207,142,0.7)'],
            borderColor: ['#c9a84c', '#4a90d9', '#3ecf8e'],
            borderWidth: 1,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { position: 'bottom', labels: { color: '#8fa3b8', font: { size: 10 }, boxWidth: 10, padding: 8 } }
          },
          cutout: '65%',
        }
      });
    }
