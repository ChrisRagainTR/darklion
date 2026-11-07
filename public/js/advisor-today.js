// Advisor Today: what needs staff attention across the firm this tax season.
(function () {
  'use strict';

  const token = (window.DLAuth ? window.DLAuth.token() : localStorage.getItem('dl_token'));
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const icon = n => '<i class="icon-' + n + '" aria-hidden="true"></i>';
  const $ = id => document.getElementById(id);
  let data = null;

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({}, opts, { headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (opts && opts.headers) || {}) }));
    if (res.status === 401) { localStorage.removeItem('dl_token'); window.location.replace('/login?expired=1'); throw new Error('Unauthorized'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(body.error || 'Request failed (' + res.status + ')'); e.status = res.status; throw e; }
    return body;
  }
  function toast(msg, isError) {
    const t = $('toast'); if (!t) return;
    t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = 'toast'; }, 3500);
  }
  function initials(name) { return String(name || '?').replace(/[^A-Za-z &]/g, '').split(/\s+|&/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || '?'; }
  function fmtDate(v) {
    if (!v) return '';
    const d = new Date(v); if (Number.isNaN(d.getTime())) return '';
    const o = { month: 'short', day: 'numeric' }; if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString('en-US', o);
  }
  function ago(days) { return days == null ? '' : days === 0 ? 'Today' : days === 1 ? '1 day' : days + ' days'; }
  function me() { try { return JSON.parse(atob(token.split('.')[1])); } catch (e) { return {}; } }

  function greeting() {
    const h = new Date().getHours();
    const first = String(me().name || '').trim().split(/\s+/)[0];
    $('td-greeting').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + (first ? ', ' + first : '');
  }

  function sentence(c) {
    const parts = [];
    if (c.readyToEfile) parts.push(c.readyToEfile + (c.readyToEfile === 1 ? ' return is' : ' returns are') + ' ready to e-file');
    if (c.changesRequested) parts.push(c.changesRequested + (c.changesRequested === 1 ? ' client asked' : ' clients asked') + ' for changes');
    if (!parts.length && c.waitingOnClients) parts.push(c.waitingOnClients + ' waiting on clients');
    return parts.length ? parts.join(' and ') + '.' : 'Nothing is waiting on you right now.';
  }

  function season(d) {
    const c = d.counts;
    const col = (label, n, href, hot) => '<a class="td-stat' + (hot && n ? ' is-hot' : '') + '" href="' + href + '"><span class="td-stat-label">' + esc(label) + '</span><span class="td-stat-n">' + n + '</span></a>';
    $('td-season').innerHTML = '<div class="td-season-title"><strong>' + esc(d.taxYear) + ' season</strong><span>Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '</span></div>' +
      col('Organizers out', c.organizersOut, '/tax-season') +
      col('Preparing', c.preparing, '/tax-season') +
      col('Waiting on clients', c.waitingOnClients, '#td-g-waiting') +
      col('Ready to e-file', c.readyToEfile, '#td-g-ready', true) +
      col('E-filed', c.filedAwaitingAcceptance, '#td-g-filed') +
      col('Accepted', c.accepted, '/tax-season');
  }

  function row(item, meta, action) {
    return '<div class="td-row" data-id="' + esc(item.id) + '">' +
      '<span class="td-av">' + (item.kind === 'business' ? icon('building-2') : esc(initials(item.name))) + '</span>' +
      '<div class="td-row-body">' + (item.href ? '<a class="td-row-name" href="' + esc(item.href) + '">' + esc(item.name) + '</a>' : '<span class="td-row-name">' + esc(item.name) + '</span>') +
      '<div class="td-row-meta">' + meta + '</div></div>' +
      '<div class="td-row-action">' + action + '</div></div>';
  }
  function group(id, title, list, render, empty) {
    if (!list.total) return empty ? '<section class="td-group" id="' + id + '"><div class="td-group-label">' + esc(title) + '</div><div class="td-empty">' + esc(empty) + '</div></section>' : '';
    return '<section class="td-group" id="' + id + '"><div class="td-group-label">' + esc(title) + ' <span>' + list.total + '</span></div>' + list.items.map(render).join('') +
      (list.total > list.items.length ? '<a class="td-more" href="/tax-season">' + (list.total - list.items.length) + ' more in Tax Season ' + icon('chevron-right') + '</a>' : '') + '</section>';
  }
  const returnLabel = i => esc(i.taxYear) + ' ' + (i.kind === 'business' ? 'business return' : 'Form 1040');

  function needs(d) {
    const html =
      group('td-g-ready', 'Ready to e-file', d.readyToEfile, i => row(i, returnLabel(i) + ' · All signed ' + esc(fmtDate(i.lastSignedAt)),
        '<button class="btn btn-gold" data-act="filed" data-id="' + i.id + '">Mark e-filed</button>')) +
      group('td-g-changes', 'Changes requested', d.changesRequested, i => row(i, '<span class="td-quote">' + esc(i.note || 'Change requested') + '</span> · ' + esc(ago(i.days)),
        i.href ? '<a class="btn btn-outline" href="' + esc(i.href) + '">Open client</a>' : '')) +
      group('td-g-waiting', 'Waiting on clients', d.waitingOnClients, i => row(i,
        esc(i.detail) + ' · <span class="td-age' + (i.days >= 7 ? ' is-old' : '') + '">' + icon('clock') + ' ' + esc(ago(i.days)) + '</span>',
        i.type === 'signature'
          ? (i.canRemind ? '<button class="btn btn-outline" data-act="remind" data-id="' + i.id + '">Send reminder</button>' : '<span class="td-note">Reminded ' + esc(fmtDate(i.remindedAt)) + '</span>')
          : (i.href ? '<a class="btn btn-outline" href="' + esc(i.href) + '">Open client</a>' : ''))) +
      group('td-g-filed', 'E-filed · waiting on acceptance', d.filedAwaitingAcceptance, i => row(i, returnLabel(i) + ' · E-filed ' + esc(fmtDate(i.filedAt)),
        '<button class="btn btn-outline" data-act="accepted" data-id="' + i.id + '">Mark accepted</button>'));
    $('td-needs').innerHTML = html || '<div class="td-empty-big">' + icon('circle-check') + '<div><strong>Nothing needs you right now.</strong><span>Returns ready to e-file, change requests, and clients waiting on signatures will show up here.</span></div></div>';
  }

  async function load() {
    try {
      data = await api('/api/today');
      $('td-sentence').textContent = sentence(data.counts);
      season(data); needs(data);
      $('td-accepted').innerHTML = '<div class="td-panel-head"><h2 class="td-h3">Accepted this week</h2></div><div class="td-accepted">' + icon('file-check') +
        '<span><strong>' + data.counts.acceptedThisWeek + '</strong> ' + (data.counts.acceptedThisWeek === 1 ? 'return' : 'returns') + '</span></div>';
    } catch (e) {
      if (e.message === 'Unauthorized') return;
      $('td-needs').innerHTML = '<div class="td-notice">Tax season status didn’t load. <button class="td-link-btn" id="td-retry">Try again</button></div>';
      $('td-retry').onclick = load;
    }
  }

  async function side() {
    const [threads, work] = await Promise.all([api('/api/messages').catch(() => null), api('/api/my-work').catch(() => null)]);
    const unread = (Array.isArray(threads) ? threads : (threads && threads.threads) || []).filter(t => Number(t.unread_count) > 0).slice(0, 4);
    $('td-inbox').innerHTML = threads == null ? '<div class="td-empty">Inbox didn’t load.</div>' : unread.length ? unread.map(t => {
      const name = [t.first_name, t.last_name].filter(Boolean).join(' ') || 'Client';
      return '<a class="td-mini" href="/messages?thread=' + encodeURIComponent(t.id) + '"><span class="td-av sm">' + esc(initials(name)) + '</span><span class="td-mini-body"><span class="td-mini-top"><strong>' + esc(name) + '</strong><em>' + esc(fmtDate(t.last_message_at_sub || t.last_message_at)) + '</em></span><span class="td-mini-sub">' + esc(String(t.last_body || t.subject || '').slice(0, 90)) + '</span></span><span class="td-dot"></span></a>';
    }).join('') : '<div class="td-empty">No unread client messages.</div>';
    const items = work && Array.isArray(work.items) ? work.items.slice(0, 4) : null;
    $('td-mywork').innerHTML = items == null ? '<div class="td-empty">My Work didn’t load.</div>' : items.length ? items.map(i =>
      '<a class="td-mini" href="' + esc(i.link || '/my-work') + '"><span class="td-av sm">' + icon(i.kind === 'task' ? 'circle-check' : 'kanban') + '</span><span class="td-mini-body"><span class="td-mini-top"><strong>' + esc(i.title || 'Work item') + '</strong></span><span class="td-mini-sub">' +
      esc([i.entity && i.entity.name, i.dueDate ? 'Due ' + fmtDate(i.dueDate + 'T12:00:00') : ''].filter(Boolean).join(' · ')) + '</span></span></a>').join('') : '<div class="td-empty">Nothing assigned to you.</div>';
  }

  document.addEventListener('click', async e => {
    const b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    const id = b.dataset.id, act = b.dataset.act;
    const label = b.textContent;
    b.disabled = true; b.textContent = act === 'remind' ? 'Sending…' : 'Saving…';
    try {
      if (act === 'remind') {
        const r = await api('/api/tax-deliveries/' + id + '/remind', { method: 'POST', body: '{}' });
        toast(r.emailed ? 'Reminder sent to ' + r.emailed + ' signer' + (r.emailed === 1 ? '' : 's') + '.' : 'Reminder sent by app notification (no email on file).');
      } else {
        await api('/api/tax-deliveries/' + id + '/efile', { method: 'POST', body: JSON.stringify({ status: act }) });
        toast(act === 'filed' ? 'Marked e-filed. The client sees it now.' : 'Marked accepted. The client was notified.');
      }
      await load();
    } catch (err) {
      b.disabled = false; b.textContent = label;
      toast(err.message, true);
      if (err.status === 429) load();
    }
  });

  greeting();
  load();
  side();
  setInterval(() => { if (document.visibilityState === 'visible') { load(); side(); } }, 60000);
})();
