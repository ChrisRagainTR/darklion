// Client portal: Home, Taxes, and the tax return review-and-sign flow.
// Renders from GET /portal/tax-status so the web portal and the iPhone app always show the same state.
(function () {
  'use strict';

  const core = () => window.PortalCore;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const icon = name => '<i class="icon-' + name + '" aria-hidden="true"></i>';
  const money = n => '$' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US');

  // One date style across the portal: "Oct 5, 2026", always with the year.
  function fmtDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function fmtDue(p) {
    if (!p.dueDate) return p.dueText || '';
    const [y, m, d] = p.dueDate.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }
  function firstName(name) { return String(name || '').trim().split(/\s+/)[0] || ''; }
  // Returns filed before DarkLion tracked filing show "Filed" with no date.
  function filedPhrase(r, withYear) { return r.filedDateKnown === false ? 'Filed' : 'E-filed ' + fmtDate(r.filedAt, withYear); }
  function joinNames(names) {
    if (names.length <= 1) return names[0] || '';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }
  function returnName(r) {
    return r.kind === 'business' ? (r.companyName || 'Business') + ' return' : 'Your ' + r.taxYear + ' tax return';
  }
  function figuresLine(r) {
    return (r.figures || []).map(f => f.label + ' ' + (f.isRefund ? 'refund ' : 'balance due ') + money(f.amount)).join(' · ');
  }

  let status = null;
  let statusError = '';
  let flow = null; // { id, packet, step, error, busy }
  let selectedYear = null; // Taxes page year; null means the current filing year

  // ── Data ────────────────────────────────────────────────────────────────
  async function refresh() {
    try {
      const next = await core().api('/portal/tax-status');
      if (!next || !Array.isArray(next.actions)) throw new Error('Unexpected tax status response');
      status = next;
      statusError = '';
      if (selectedYear === String(status.taxYear)) selectedYear = null;
    } catch (e) {
      if (e.message === 'Unauthorized') throw e;
      statusError = 'Your tax status could not load.';
    }
    renderAll();
    return status;
  }

  function renderAll() {
    renderHome();
    renderTaxBadge();
    if (!flow) renderTaxesList();
  }

  function renderTaxBadge() {
    const badge = document.getElementById('taxes-badge');
    if (!badge) return;
    const count = status ? status.actions.length : 0;
    badge.textContent = count;
    badge.style.display = count ? '' : 'none';
  }

  // ── Shared pieces ───────────────────────────────────────────────────────
  function trackerNote(s, r) {
    const st = s.stage;
    if (st === 'organizer_in_progress' && s.organizer) return s.organizer.progress.resolved + ' of ' + s.organizer.progress.total + ' done';
    if (st === 'more_documents' && s.organizer) {
      const n = s.organizer.requestedItems.length;
      return n ? 'Waiting on ' + n + ' document' + (n === 1 ? '' : 's') : 'Waiting on documents';
    }
    if (st === 'preparing' && s.organizer && s.organizer.submittedAt) return 'Organizer received ' + fmtDate(s.organizer.submittedAt);
    if ((st === 'review' || st === 'sign') && r && r.dueText) return 'Due ' + r.dueText;
    if (st === 'changes_requested') return 'Being updated';
    if (st === 'signed_waiting') return 'Waiting on another signature';
    if (st === 'signed') return 'We\'ll e-file next';
    if (st === 'filed' && r) return filedPhrase(r);
    if (st === 'accepted' && r) return 'Accepted ' + fmtDate(r.acceptedAt);
    return '';
  }

  function trackerHtml(steps, note, label, warn) {
    if (!steps) return '';
    const items = steps.map((step, i) => {
      const mark = step.state === 'done' ? icon('check') : String(i + 1);
      return '<li class="trk-step is-' + step.state + '"><span class="trk-dot">' + mark + '</span><span class="trk-label">' + esc(step.label) + '</span></li>';
    }).join('<li class="trk-line" aria-hidden="true"></li>');
    return '<div class="tracker">' + (label ? '<span class="trk-title">' + esc(label) + '</span>' : '') +
      '<ol class="trk-steps">' + items + '</ol>' +
      (note ? '<span class="trk-note' + (warn ? ' is-warn' : '') + '">' + esc(note) + '</span>' : '') + '</div>';
  }

  function stageTracker(r) {
    const map = { review: 1, sign: 1, changes_requested: 1, signed_waiting: 1, with_other_signers: 1, signed: 2, filed: 3, accepted: 3 };
    const pos = map[r.stage];
    if (pos === undefined) return null;
    return ['We prepare', 'Review & sign', 'Filed'].map((label, i) => ({ label, state: i < pos ? 'done' : i === pos ? 'current' : 'upcoming' }));
  }

  function row({ iconName, title, sub, meta, action, emphasis, onClickAttr }) {
    return '<div class="row' + (emphasis ? ' row-emph' : '') + '"' + (onClickAttr ? ' ' + onClickAttr : '') + '>' +
      '<span class="row-icon">' + icon(iconName) + '</span>' +
      '<div class="row-body"><div class="row-title">' + title + '</div>' +
      (sub ? '<div class="row-sub">' + sub + '</div>' : '') +
      (meta ? '<div class="row-meta">' + meta + '</div>' : '') + '</div>' +
      (action ? '<div class="row-action">' + action + '</div>' : '') + '</div>';
  }

  function btn(label, onclick, kind) {
    return '<button type="button" class="btn ' + (kind || 'btn-gold') + '" onclick="' + onclick + '">' + label + '</button>';
  }

  function signerRows(r) {
    return (r.signers || []).map(sg => {
      let state = 'Not started', cls = 'is-idle';
      if (sg.signedAt) { state = 'Signed ' + fmtDate(sg.signedAt); cls = 'is-done'; }
      else if (sg.approvedAt) { state = 'Approved, not signed yet'; cls = 'is-wait'; }
      return '<div class="list-row"><span class="list-main">' + esc(sg.name) + (sg.isMe ? ' <span class="muted">(you)</span>' : '') + '</span>' +
        '<span class="status-dot ' + cls + '"></span><span class="list-end muted">' + esc(state) + '</span></div>';
    }).join('');
  }

  // Compact two-line signer rows for the narrow side column.
  function signerStack(items) {
    return '<div class="list signer-list">' + items.map(it =>
      '<div class="list-row"><span class="status-dot ' + it.cls + '"></span><div><div class="signer-name">' + esc(it.name) + (it.isMe ? ' <span class="muted">(you)</span>' : '') + '</div>' +
      '<div class="signer-state">' + esc(it.state) + '</div></div></div>').join('') + '</div>';
  }

  function organizerUrl(year) { return '/organizer.html?year=' + encodeURIComponent(year); }

  // ── Home ────────────────────────────────────────────────────────────────
  function greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }

  // Unread messages and new documents, for the Home sentence when no tax step is waiting.
  function newItemsSentence() {
    const parts = [];
    const unread = (core().staff() || []).reduce((n, x) => n + (Number(x.unreadCount) || 0), 0);
    if (unread) parts.push(unread + ' new message' + (unread === 1 ? '' : 's'));
    const fresh = (core().docs() || []).filter(d => core().isDocNew(d)).length;
    if (fresh) parts.push(fresh + ' new document' + (fresh === 1 ? '' : 's'));
    return parts.length ? 'You have ' + joinNames(parts) + '.' : '';
  }

  function homeSentence(s) {
    const r = s.personalReturn;
    const year = s.taxYear;
    const bizActions = s.actions.filter(a => a.type === 'tax_return' && (!r || a.deliveryId !== r.id)).length;
    const extra = bizActions ? ' A business return is also ready for you.' : '';
    switch (s.stage) {
      case 'organizer_ready': return 'Your ' + year + ' tax organizer is ready.' + extra;
      case 'organizer_in_progress': return 'Pick up your ' + year + ' organizer where you left off.' + extra;
      case 'more_documents': return 'We need a few more documents to finish your return.' + extra;
      case 'preparing': return 'We\'re preparing your ' + year + ' return. Nothing is needed from you right now.' + extra;
      case 'review': case 'sign': return 'Your ' + year + ' return is ready for you to review and sign.' + extra;
      case 'with_other_signers': return 'Your ' + year + ' return is out for signatures.' + extra;
      case 'signed_waiting': {
        const others = (r.signers || []).filter(x => !x.isMe && !x.signedAt).map(x => firstName(x.name));
        return 'You\'ve signed. We\'re waiting on ' + (joinNames(others) || 'another signer') + '.' + extra;
      }
      case 'changes_requested': return 'We\'re updating your return based on your note.' + extra;
      case 'signed': return 'Your return is signed. We\'ll e-file it next.' + extra;
      case 'filed': return (r.filedDateKnown === false ? 'Your ' + year + ' return was filed.' : 'Your ' + year + ' return was e-filed on ' + fmtDate(r.filedAt, true) + '.') + extra;
      case 'accepted': return 'Your ' + year + ' return was accepted.' + (newItemsSentence() ? ' ' + newItemsSentence() : ' You\'re all set.') + extra;
      default: return bizActions ? 'A business return is ready for you to review and sign.' : (newItemsSentence() || 'You\'re all caught up.');
    }
  }

  function attentionItems(s) {
    const items = [];
    const returns = [s.personalReturn, ...(s.businessReturns || [])].filter(Boolean);
    for (const a of s.actions) {
      if (a.type === 'tax_return') {
        const r = returns.find(x => x.id === a.deliveryId);
        if (!r) continue;
        const title = r.kind === 'business' ? 'Review and sign the ' + esc(r.taxYear) + ' return for ' + esc(r.companyName) : 'Review and sign your ' + esc(r.taxYear) + ' tax return';
        items.push(row({
          iconName: 'signature', emphasis: true, title,
          sub: esc(figuresLine(r)),
          meta: 'Sent ' + esc(fmtDate(r.sentAt)) + (r.dueText ? ' · Due ' + esc(r.dueText) : ''),
          action: btn(a.stage === 'sign' ? 'Sign now' : 'Review &amp; sign', 'PortalTax.openReturn(' + r.id + ')'),
        }));
      } else if (a.type === 'organizer') {
        const o = s.organizer;
        const started = a.stage === 'organizer_in_progress';
        items.push(row({
          iconName: 'clipboard-list', emphasis: true,
          title: (started ? 'Finish' : 'Complete') + ' your ' + esc(s.taxYear) + ' tax organizer',
          sub: started ? o.progress.resolved + ' of ' + o.progress.total + ' items done. Your answers are saved as you go.'
            : 'A few questions and a checklist of ' + o.progress.total + ' documents based on last year\'s return. You can save and come back.',
          action: '<a class="btn btn-gold" href="' + organizerUrl(s.taxYear) + '">' + (started ? 'Continue organizer' : 'Start organizer') + '</a>',
        }));
      } else if (a.type === 'organizer_requests') {
        const o = s.organizer;
        const list = o.requestedItems.map(i => '<div class="list-row"><span class="list-main">' + icon('file-text') + ' ' + esc(i.name) + '</span></div>').join('');
        items.push('<div class="request-block">' +
          '<div class="request-head">' + icon('message-square') + '<span>Your team asked for more documents</span></div>' +
          (o.reopenNote ? '<blockquote class="quote">' + esc(o.reopenNote) + '</blockquote>' : '') +
          (list ? '<div class="list">' + list + '</div>' : '') +
          '<div class="request-actions"><a class="btn btn-gold" href="' + organizerUrl(s.taxYear) + '">' + icon('upload') + ' Upload documents</a>' +
          '<button type="button" class="btn-link" onclick="PortalCore.goTab(\'messages\')">Reply to your team</button></div></div>');
      }
    }
    return items;
  }

  function extraAttention() {
    const items = [];
    const staff = core().staff() || [];
    const unread = staff.filter(x => Number(x.unreadCount) > 0);
    if (unread.length) {
      const total = unread.reduce((n, x) => n + Number(x.unreadCount), 0);
      const who = unread[0];
      items.push(row({
        iconName: 'message-square',
        title: total === 1 ? 'New message from ' + esc(who.name) : total + ' new messages from ' + esc(joinNames(unread.map(x => firstName(x.name)))),
        sub: who.lastPreview ? esc(who.lastPreview) : '',
        action: '<span class="chev">' + icon('chevron-right') + '</span>',
        onClickAttr: 'role="button" tabindex="0" onclick="PortalCore.goTab(\'messages\')"',
      }));
    }
    const fresh = (core().docs() || []).filter(d => core().isDocNew(d));
    if (fresh.length) {
      items.push(row({
        iconName: 'file-text',
        title: fresh.length === 1 ? 'New document: ' + esc(fresh[0].display_name || 'Document') : fresh.length + ' new documents from your team',
        action: '<span class="chev">' + icon('chevron-right') + '</span>',
        onClickAttr: 'role="button" tabindex="0" onclick="PortalCore.goTab(\'documents\')"',
      }));
    }
    return items;
  }

  function stageSections(s) {
    const r = s.personalReturn;
    let html = '';
    if (r && ['review', 'sign', 'signed_waiting', 'with_other_signers'].includes(r.stage) && r.signers.length) {
      html += '<section class="section"><h2 class="h2">Who needs to sign</h2><div class="list">' + signerRows(r) + '</div>' +
        (r.signers.length > 1 ? '<p class="hint">Each of you signs from your own login.</p>' : '') + '</section>';
    }
    if (r && r.stage === 'changes_requested' && r.changeRequest) {
      const cr = r.changeRequest;
      html += '<section class="section"><h2 class="h2">Your change request</h2>' +
        '<div class="note-block"><div class="note-meta">' + esc(cr.by || 'You') + (cr.at ? ' · ' + esc(fmtDate(cr.at)) : '') + '</div>' +
        '<blockquote class="quote">' + esc(cr.note) + '</blockquote></div>' +
        '<button type="button" class="btn-link" onclick="PortalCore.goTab(\'messages\')">Message your team ' + icon('chevron-right') + '</button></section>';
    }
    if (s.stage === 'preparing' || s.stage === 'more_documents') {
      const o = s.organizer;
      html += '<section class="section"><h2 class="h2">Your ' + esc(s.taxYear) + ' return</h2><div class="list">' +
        (o && o.submittedAt ? '<div class="list-row"><span class="status-dot is-done"></span><span class="list-main">Organizer submitted</span><span class="list-end muted">' + esc(fmtDate(o.submittedAt)) + '</span></div>' : '') +
        '<div class="list-row"><span class="status-dot is-now"></span><span class="list-main">Return in preparation</span><span class="list-end muted">Now</span></div></div></section>';
    }
    return html;
  }

  function comingUpSection(s) {
    const rows = (s.estimatedPayments || []).slice(0, 3).map(p =>
      '<div class="list-row"><span class="list-main">' + esc(p.jurisdiction) + ' estimated payment' + (p.quarter ? ' <span class="muted">(' + esc(p.quarter) + ' quarter)</span>' : '') + '</span>' +
      '<span class="list-num">' + esc(p.amount) + '</span><span class="list-end muted">Due ' + esc(fmtDue(p)) + '</span></div>').join('');
    if (!rows) return '';
    return '<section class="section"><h2 class="h2">Coming up</h2><div class="list">' + rows + '</div>' +
      '<p class="hint">Reminders from your return. Pay federal estimates at <a href="https://www.irs.gov/payments" target="_blank" rel="noopener">irs.gov/payments</a>.</p></section>';
  }

  function recentSection() {
    const docs = (core().docs() || []).slice().sort((a, b) => new Date(b.delivered_at || b.created_at) - new Date(a.delivered_at || a.created_at)).slice(0, 3);
    if (!docs.length) return '';
    return '<section class="section"><div class="section-head"><h2 class="h2">Recently added</h2>' +
      '<button type="button" class="btn-link" onclick="PortalCore.goTab(\'documents\')">All documents ' + icon('chevron-right') + '</button></div><div class="list">' +
      docs.map(d => '<button type="button" class="list-row list-button" onclick="PortalCore.openDoc(' + Number(d.id) + ', this)">' +
        '<span class="file-icon">' + icon('file-text') + '</span><span class="list-main"><span class="list-name" title="' + esc(d.display_name || 'Document') + '">' + esc(d.display_name || 'Document') + '</span></span>' +
        '<span class="list-end muted">' + esc(fmtDate(d.delivered_at || d.created_at)) + '</span><span class="chev">' + icon('chevron-right') + '</span></button>').join('') +
      '</div></section>';
  }

  // How a team member works with this client, from the Messages list when known ("Your tax preparer").
  function roleFor(m) {
    const contact = (core().staff() || []).find(x => Number(x.id) === Number(m.id));
    return (contact && contact.roleLabel) || (m.role === 'owner' ? 'Partner' : 'Advisor');
  }

  function teamPanel(extra) {
    const team = (core().team() || []).slice(0, 3);
    const people = team.map(m => {
      const name = String(m.name || '').replace(/,\s*[A-Z\/]+$/, '').trim();
      const initials = name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const avatar = m.avatar_url
        ? '<img class="avatar" src="' + esc(m.avatar_url) + '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'avatar avatar-initials\',textContent:\'' + esc(initials) + '\'}))">'
        : '<span class="avatar avatar-initials">' + esc(initials) + '</span>';
      return '<div class="team-person">' + avatar + '<div><div class="team-name">' + esc(name) + '</div>' +
        (m.credentials ? '<div class="team-cred">' + esc(m.credentials) + '</div>' : '') +
        '<div class="team-role">' + esc(roleFor(m)) + '</div></div></div>';
    }).join('');
    return '<section class="side-section"><h2 class="h3">Your advisory team</h2>' + (people || '<p class="hint">Your team will appear here.</p>') +
      '<button type="button" class="btn btn-outline btn-block" onclick="PortalCore.goTab(\'messages\')">' + icon('message-square') + ' Message your team</button></section>' + (extra || '');
  }

  function appNote() {
    const firm=window.DarkLionFirm;
    if(!firm?.appStoreUrl)return '';
    return '<section class="side-section side-app"><div class="muted-strong">' + icon('smartphone') + ' '+esc(firm.appName)+' for iPhone</div>' +
      '<p class="hint">Messages, uploads, and signing on the go.</p>' +
      '<a href="' + esc(firm.appStoreUrl) + '" target="_blank" rel="noopener" class="btn-link">Get the app ' + icon('external-link') + '</a></section>';
  }

  function renderHome() {
    const me = core().me();
    if (!me) return;
    const heading = document.getElementById('homeGreeting');
    heading.textContent = greeting() + ', ' + (me.firstName || 'there');
    const s = status;
    const sentence = document.getElementById('homeSentence');
    const tracker = document.getElementById('homeTracker');
    const attention = document.getElementById('homeAttention');
    const sections = document.getElementById('homeSections');
    if (!s) {
      sentence.textContent = statusError ? 'Some of your tax information didn\'t load.' : '';
      tracker.innerHTML = statusError ? '<div class="inline-notice">' + esc(statusError) + ' <button type="button" class="btn-link" onclick="PortalTax.refresh()">Try again</button></div>' : '<div class="skeleton" style="width:420px;height:28px"></div>';
      const extra = extraAttention();
      attention.innerHTML = extra.length ? extra.join('') : '';
      sections.innerHTML = recentSection();
      document.getElementById('homeSide').innerHTML = teamPanel(appNote());
      return;
    }
    sentence.textContent = homeSentence(s);
    const warnStages = ['more_documents', 'changes_requested'];
    tracker.innerHTML = trackerHtml(s.tracker, trackerNote(s, s.personalReturn), s.taxYear + ' taxes', warnStages.includes(s.stage)) ||
      (s.lastFiledReturn && s.lastFiledReturn.acceptedAt ? '<p class="hint">Your ' + esc(s.lastFiledReturn.taxYear) + ' return was accepted ' + esc(fmtDate(s.lastFiledReturn.acceptedAt, true)) + '.</p>' : '');
    const items = attentionItems(s).concat(extraAttention());
    attention.innerHTML = items.length ? items.join('') :
      row({ iconName: 'check', title: 'Nothing to do right now', sub: 'We\'ll let you know here, by email, and on your phone when something needs you.' });
    sections.innerHTML = stageSections(s) + comingUpSection(s) + recentSection();
    document.getElementById('homeSide').innerHTML = teamPanel(appNote());
  }

  // ── Taxes list ──────────────────────────────────────────────────────────
  function returnStatusText(r) {
    switch (r.stage) {
      case 'review': return 'Ready for you to review and sign' + (r.dueText ? ' · Due ' + r.dueText : '');
      case 'sign': return 'Approved. Ready for your signature' + (r.dueText ? ' · Due ' + r.dueText : '');
      case 'with_other_signers': return 'Out for signatures';
      case 'signed_waiting': return 'You signed ' + fmtDate(r.me && r.me.signedAt) + ' · Waiting on another signer';
      case 'changes_requested': return 'We\'re updating it based on your note';
      case 'signed': return 'Signed · We\'ll e-file it next';
      case 'filed': return filedPhrase(r, true);
      case 'accepted': return filedPhrase(r, true) + ' · Accepted ' + fmtDate(r.acceptedAt, true);
      default: return '';
    }
  }

  function returnBlock(r) {
    const act = ['review', 'sign'].includes(r.stage)
      ? btn(r.stage === 'sign' ? 'Sign now' : 'Review &amp; sign', 'PortalTax.openReturn(' + r.id + ')')
      : '<button type="button" class="btn btn-outline" onclick="PortalTax.openReturn(' + r.id + ')">View return</button>';
    return '<div class="return-block"><div class="return-head"><h2 class="h2">' + esc(r.kind === 'business' ? r.companyName + ' — business return' : 'Personal tax return') + '</h2>' + act + '</div>' +
      trackerHtml(stageTracker(r), '', '', false) +
      '<p class="return-status">' + esc(returnStatusText(r)) + (r.figures && r.figures.length ? ' · ' + esc(figuresLine(r)) : '') + '</p></div>';
  }

  function organizerBlock(s) {
    const o = s.organizer;
    if (!o) return '';
    let text = 'Not started', label = 'Start organizer', kind = 'btn-gold';
    if (s.stage === 'organizer_in_progress') { text = o.progress.resolved + ' of ' + o.progress.total + ' items done'; label = 'Continue organizer'; }
    else if (s.stage === 'more_documents') { text = 'Your team asked for ' + (o.requestedItems.length || 'more') + ' more document' + (o.requestedItems.length === 1 ? '' : 's'); label = 'Upload documents'; }
    else if (o.submittedAt || ['submitted', 'closed', 'reviewed'].includes(o.status)) { text = 'Submitted' + (o.submittedAt ? ' ' + fmtDate(o.submittedAt, true) : ''); label = 'View organizer'; kind = 'btn-outline'; }
    const tracker = !s.personalReturn ? trackerHtml(s.tracker, trackerNote(s, null), '', s.stage === 'more_documents') : '';
    return '<div class="return-block"><div class="return-head"><h2 class="h2">' + esc(s.taxYear) + ' tax organizer</h2>' +
      '<a class="btn ' + kind + '" href="' + organizerUrl(s.taxYear) + '">' + label + '</a></div>' + tracker +
      '<p class="return-status">' + esc(text) + '</p></div>';
  }

  function paymentsTable(s) {
    if (!s.estimatedPayments || !s.estimatedPayments.length) return '';
    return '<section class="section"><h2 class="h2">Estimated payment reminders</h2>' +
      '<table class="table"><thead><tr><th>Payment</th><th>Due</th><th class="num">Amount</th></tr></thead><tbody>' +
      s.estimatedPayments.map(p => '<tr><td>' + esc(p.jurisdiction) + (p.quarter ? ' · ' + esc(p.quarter) + ' quarter' : '') + '</td><td>' + esc(fmtDue(p)) + '</td><td class="num">' + esc(p.amount) + '</td></tr>').join('') +
      '</tbody></table><p class="hint">From your most recent return. Pay federal estimates at <a href="https://www.irs.gov/payments" target="_blank" rel="noopener">irs.gov/payments</a>.</p></section>';
  }

  function filedRow(r, withYear) {
    return '<div class="list-row">' + (withYear ? '<button type="button" class="list-year btn-link" onclick="PortalTax.setYear(\'' + esc(r.taxYear) + '\')" title="Show ' + esc(r.taxYear) + '">' + esc(r.taxYear) + '</button>' : '') +
      '<span class="list-main">' + esc(r.kind === 'business' ? r.companyName : 'Personal return') + '</span>' +
      '<span class="list-end muted">' + esc(r.acceptedAt ? 'Accepted ' + fmtDate(r.acceptedAt, true) : r.filedAt ? filedPhrase(r, true) : 'Signed') + '</span>' +
      (r.signedDocId ? '<button type="button" class="btn-link" onclick="PortalCore.openDoc(' + Number(r.signedDocId) + ', this)">Signed copy</button>' : '<span></span>') + '</div>';
  }

  function pastSection(s) {
    const past = s.pastReturns || [];
    if (!past.length) return '';
    return '<section class="section"><h2 class="h2">Past years</h2><div class="list">' + past.map(r => filedRow(r, true)).join('') + '</div></section>';
  }

  // ── Tax years ───────────────────────────────────────────────────────────
  // A year's record combines finished tax-return records with the tax documents filed under that year in Documents,
  // so returns delivered or imported as documents show up too.
  const isYear = y => /^\d{4}$/.test(String(y == null ? '' : y));
  function viewYear(s) { return selectedYear || String(s.taxYear); }
  function taxDocsFor(year) {
    return (core().docs() || []).filter(d => d.folder_category === 'tax' && String(d.year || '') === String(year));
  }
  function taxYears(s) {
    const years = new Set([String(s.taxYear)]);
    (s.pastReturns || []).forEach(r => { if (isYear(r.taxYear)) years.add(String(r.taxYear)); });
    (core().docs() || []).forEach(d => { if (d.folder_category === 'tax' && isYear(d.year)) years.add(String(d.year)); });
    if (selectedYear) years.add(selectedYear);
    return [...years].sort((a, b) => Number(b) - Number(a));
  }
  function yearPicker(s) {
    const years = taxYears(s);
    if (years.length < 2) return '';
    const current = viewYear(s);
    return '<label class="year-pick"><span>Tax year</span><select onchange="PortalTax.setYear(this.value)" aria-label="Tax year">' +
      years.map(y => '<option value="' + esc(y) + '"' + (y === current ? ' selected' : '') + '>' + esc(y) + (y === String(s.taxYear) ? ' (current)' : '') + '</option>').join('') +
      '</select></label>';
  }

  // Returns first, then other tax documents; newest first within each.
  const looksLikeReturn = d => /return|\b(1040|1041|1065|1120s?|990|706|709)\b/i.test(d.display_name || '');
  function docTime(d) { return new Date(d.delivered_at || d.created_at || 0).getTime() || 0; }
  function docRows(list) {
    return list.slice().sort((a, b) => (looksLikeReturn(b) - looksLikeReturn(a)) || (docTime(b) - docTime(a))).map(d => {
      const name = d.display_name || 'Document';
      return '<button type="button" class="list-row list-button" onclick="PortalCore.openDoc(' + Number(d.id) + ', this)">' +
        '<span class="file-icon">' + icon('file-text') + '</span><span class="list-main"><span class="list-name" title="' + esc(name) + '">' + esc(name) + '</span></span>' +
        '<span class="list-end muted">' + esc(fmtDate(d.delivered_at || d.created_at)) + '</span><span class="chev">' + icon('chevron-right') + '</span></button>';
    }).join('');
  }
  function taxDocsSection(year) {
    const docs = taxDocsFor(year);
    if (!docs.length) return '';
    const companies = core().companies() || [];
    const groups = [{ label: 'Personal', docs: docs.filter(d => d.owner_type !== 'company') }].concat(companies.map(c => ({
      label: c.company_name || c.name || 'Business',
      docs: docs.filter(d => d.owner_type === 'company' && Number(d.owner_id) === Number(c.id || c.company_id)),
    }))).filter(g => g.docs.length);
    const body = groups.map(g => {
      const team = g.docs.filter(d => d.folder_section !== 'client_uploaded');
      const mine = g.docs.filter(d => d.folder_section === 'client_uploaded');
      return (groups.length > 1 ? '<h3 class="h3 year-group">' + esc(g.label) + '</h3>' : '') +
        (team.length ? '<div class="list">' + docRows(team) + '</div>' : '') +
        (mine.length ? '<details class="details"><summary>Documents you uploaded (' + mine.length + ')</summary><div class="details-body"><div class="list">' + docRows(mine) + '</div></div></details>' : '');
    }).join('');
    return '<section class="section"><div class="section-head"><h2 class="h2">' + esc(year) + ' tax documents</h2>' +
      '<button type="button" class="btn-link" onclick="PortalCore.goTab(\'documents\')">All documents ' + icon('chevron-right') + '</button></div>' + body + '</section>';
  }

  function pastYearMain(s, year) {
    const filed = (s.pastReturns || []).filter(r => String(r.taxYear) === year);
    const html = (filed.length ? '<section class="section"><h2 class="h2">Filed returns</h2><div class="list">' + filed.map(r => filedRow(r, false)).join('') + '</div></section>' : '') +
      taxDocsSection(year);
    return html || '<div class="empty-calm">' + icon('folder') + '<div><div class="row-title">No returns or tax documents for ' + esc(year) + '</div><div class="row-sub">Choose another year, or message your team if you expected to see something here.</div></div></div>';
  }

  function renderTaxesList() {
    const wrap = document.getElementById('taxesContent');
    if (!wrap) return;
    const s = status;
    const year = s ? viewYear(s) : selectedYear;
    const current = !s || year === String(s.taxYear);
    let main;
    if (!s) {
      main = statusError ? '<div class="inline-notice">' + esc(statusError) + ' <button type="button" class="btn-link" onclick="PortalTax.refresh()">Try again</button></div>' : '<div class="skeleton" style="height:120px"></div>';
    } else if (!current) {
      main = pastYearMain(s, year);
    } else {
      const blocks = [organizerBlock(s), s.personalReturn ? returnBlock(s.personalReturn) : '', ...(s.businessReturns || []).map(returnBlock)].filter(Boolean).join('');
      const docsThisYear = taxDocsSection(s.taxYear);
      main = (blocks || '<div class="empty-calm">' + icon('circle-check') + '<div><div class="row-title">Nothing in progress for ' + esc(s.taxYear) + '</div><div class="row-sub">' +
        (docsThisYear ? 'Your ' + esc(s.taxYear) + ' tax documents are listed below.' : 'When we start your return, you\'ll follow its progress here.') + '</div></div></div>') +
        paymentsTable(s) + docsThisYear + pastSection(s);
    }
    const sub = current ? 'Everything we\'re preparing for you and your businesses' + (s ? ' for ' + esc(s.taxYear) : '') + '.' : 'Your filed returns and tax documents for ' + esc(year) + '.';
    wrap.innerHTML = '<div class="page-head taxes-head"><div><h1 class="page-title">Taxes</h1><p class="page-sub">' + sub + '</p></div>' + (s ? yearPicker(s) : '') + '</div>' +
      '<div class="page-grid"><div class="page-main">' + main + '</div><aside class="page-side">' + teamPanel() + '</aside></div>';
  }

  // Year on the Taxes page. Called from the year picker and from the page address (#taxes/2024).
  function setYear(year) {
    const y = isYear(year) ? String(year) : null;
    selectedYear = y && status && y === String(status.taxYear) ? null : y;
    if (!flow) renderTaxesList();
    if (core().route) core().route();
  }

  // ── Return flow ─────────────────────────────────────────────────────────
  async function openReturn(id) {
    flow = { id, packet: null, step: null, error: '', busy: false, changes: false, reviewed: false, consent: false, sigMode: 'draw' };
    core().goTab('taxes', { keepFlow: true });
    renderFlow();
    await loadPacket();
  }

  async function loadPacket() {
    try {
      flow.packet = await core().api('/portal/mobile/tax-deliveries/' + flow.id);
      flow.error = '';
      if (!flow.step) flow.step = initialStep(flow.packet);
    } catch (e) {
      flow.error = e.message === 'Unauthorized' ? '' : 'This return could not load. ' + e.message;
    }
    renderFlow();
  }

  function initialStep(p) {
    const me = p.currentSigner;
    if (p.delivery.status === 'needs_changes') return 'changes';
    if (!me || me.signedAt || ['signed', 'complete'].includes(p.delivery.status)) return 'done';
    if (me.approvedAt) return 'sign';
    return 'summary';
  }

  function closeFlow() {
    flow = null;
    renderTaxesList();
  }

  function goStep(step) {
    if (!flow || flow.busy) return;
    flow.step = step; flow.error = '';
    renderFlow();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function flowStepper(p) {
    const me = p.currentSigner || {};
    const order = ['summary', 'review', 'sign', 'done'];
    const labels = ['Summary', 'Review', 'Sign', 'Done'];
    const cur = flow.step === 'changes' ? 1 : order.indexOf(flow.step);
    const doneUpTo = me.signedAt ? 3 : me.approvedAt ? 2 : cur;
    return '<ol class="stepper">' + labels.map((label, i) => {
      const state = i === cur ? 'current' : i < Math.max(cur, doneUpTo) ? 'done' : 'upcoming';
      const canGo = state === 'done' && !me.signedAt && i < 2 && flow.step !== 'changes';
      return '<li class="trk-step is-' + state + '">' + (canGo ? '<button type="button" onclick="PortalTax.goStep(\'' + order[i] + '\')">' : '<span>') +
        '<span class="trk-dot">' + (state === 'done' ? icon('check') : i + 1) + '</span><span class="trk-label">' + label + '</span>' + (canGo ? '</button>' : '</span>') + '</li>';
    }).join('<li class="trk-line" aria-hidden="true"></li>') + '</ol>';
  }

  function whoSigns(p) {
    const signers = p.signers || [];
    if (!signers.length) return '';
    const me = p.currentSigner;
    return '<section class="side-section"><h2 class="h3">Who needs to sign</h2>' + signerStack(signers.map(sg => {
      const isMe = me && sg.id === me.id;
      let state = 'Not started', cls = 'is-idle';
      if (sg.signedAt) { state = 'Signed ' + fmtDate(sg.signedAt); cls = 'is-done'; }
      else if (isMe && flow.step === 'sign') { state = 'Signing now'; cls = 'is-now'; }
      else if (sg.approvedAt) { state = 'Approved'; cls = 'is-wait'; }
      else if (isMe && flow.step === 'review') { state = 'Reviewing'; cls = 'is-now'; }
      return { name: sg.name, isMe, state, cls };
    })) + (signers.length > 1 ? '<p class="hint">Each signer uses their own login.</p>' : '') + '</section>';
  }

  function renderFlow() {
    const wrap = document.getElementById('taxesContent');
    if (!wrap || !flow) return;
    const p = flow.packet;
    const d = p && p.delivery;
    const title = d ? (d.companyName ? d.companyName + ' — ' + d.taxYear + ' return' : 'Your ' + d.taxYear + ' tax return') : 'Your tax return';
    let body;
    if (!p) body = flow.error ? '<div class="inline-notice">' + esc(flow.error) + ' <button type="button" class="btn-link" onclick="PortalTax.reload()">Try again</button></div>' : '<div class="skeleton" style="height:240px"></div>';
    else body = ({ summary: stepSummary, review: stepReview, sign: stepSign, done: stepDone, changes: stepChanges }[flow.step] || stepSummary)(p);
    const due = d && d.taxSummary && d.taxSummary.due_date ? '<span class="trk-note">Due ' + esc(d.taxSummary.due_date) + '</span>' : '';
    wrap.innerHTML = '<nav class="crumbs"><button type="button" class="btn-link" onclick="PortalTax.close()">Taxes</button><span>/</span><span>' + esc(d ? d.taxYear + ' ' + (d.companyName ? 'business return' : 'tax return') : 'Tax return') + '</span></nav>' +
      '<div class="page-head"><h1 class="page-title">' + esc(title) + '</h1>' + (p ? '<div class="tracker">' + flowStepper(p) + due + '</div>' : '') + '</div>' +
      '<div class="page-grid"><div class="page-main">' + (flow.error && p ? '<div class="inline-notice" role="alert">' + esc(flow.error) + '</div>' : '') + body + '</div>' +
      '<aside class="page-side">' + teamPanel(p ? whoSigns(p) : '') + '</aside></div>';
    if (p && flow.step === 'sign') initSignature();
  }

  function preparerNote(d) {
    if (!d.introNote) return '';
    const prep = d.preparer;
    const who = prep ? esc(prep.name) + (prep.credentials ? ', ' + esc(prep.credentials) : '') : 'Your team';
    const initials = prep ? String(prep.name).split(/\s+/).map(w => w[0] || '').join('').slice(0, 2).toUpperCase() : '';
    const avatar = prep && prep.avatarUrl ? '<img class="avatar avatar-sm" src="' + esc(prep.avatarUrl) + '" alt="">' : '<span class="avatar avatar-sm avatar-initials">' + (initials ? esc(initials) : icon('message-square')) + '</span>';
    return '<div class="note-block note-from">' + avatar + '<div><div class="note-meta">' + who + ' · ' + esc(fmtDate(d.updatedAt || d.createdAt)) + '</div>' +
      '<div class="note-text">' + esc(d.introNote).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>').replace(/^/, '<p>') + '</p></div></div></div>';
  }

  function summaryFigures(d) {
    const ts = d.taxSummary || {};
    const rep = d.taxReportData || {};
    const figs = [];
    const fed = ts.federal_amount !== undefined && ts.federal_amount !== '' ? parseFloat(ts.federal_amount) : (rep.refund_or_owed_amount != null ? (rep.is_refund ? 1 : -1) * Math.abs(rep.refund_or_owed_amount) : null);
    if (fed !== null && !Number.isNaN(fed)) figs.push(['Federal ' + (fed >= 0 ? 'refund' : 'balance due'), money(fed), fed >= 0 ? 'good' : '']);
    if (ts.state_amount !== undefined && ts.state_amount !== '') {
      const st = parseFloat(ts.state_amount);
      if (!Number.isNaN(st)) figs.push(['State ' + (st >= 0 ? 'refund' : 'balance due'), money(st), st >= 0 ? 'good' : '']);
    }
    if (rep.total_tax != null) figs.push(['Total federal tax', money(rep.total_tax), '']);
    if (!figs.length) return '';
    const meta = [rep.client && rep.client.filing_status, rep.effective_rate ? 'Effective rate ' + rep.effective_rate + '%' : '', rep.adjusted_gross_income ? 'Adjusted gross income ' + money(rep.adjusted_gross_income) : ''].filter(Boolean).join(' · ');
    return '<div class="figures">' + figs.map(f => '<div class="figure"><div class="figure-label">' + esc(f[0]) + '</div><div class="figure-value ' + f[2] + '">' + esc(f[1]) + '</div></div>').join('') + '</div>' +
      (meta ? '<p class="hint">' + esc(meta) + '</p>' : '');
  }

  function highlights(d) {
    const rep = d.taxReportData || {};
    const yoy = rep.prior_year_comparison;
    const rows = [];
    if (yoy && Array.isArray(yoy.highlights)) {
      yoy.highlights.slice(0, 4).forEach(h => rows.push('<div class="list-row"><span class="list-main">' + esc(h.title) + '</span>' + (h.detail ? '<span class="list-end muted">' + esc(h.detail) + '</span>' : '') + '</div>'));
    }
    if (!rows.length && Array.isArray(rep.savings_highlights)) {
      rep.savings_highlights.slice(0, 3).forEach(h => rows.push('<div class="list-row"><span class="list-main">' + esc(h.title) + '</span><span class="list-end muted">' + esc(h.amount || '') + '</span></div>'));
    }
    if (!rows.length) return '';
    const heading = yoy && yoy.prior_tax_year ? 'What changed from ' + yoy.prior_tax_year : 'Highlights';
    return '<section class="section"><h2 class="h2">' + esc(heading) + '</h2><div class="list">' + rows.join('') + '</div></section>';
  }

  function stepSummary(p) {
    const d = p.delivery;
    const rep = d.taxReportData;
    const pays = status ? (status.estimatedPayments || []) : [];
    return preparerNote(d) + summaryFigures(d) + highlights(d) +
      (pays.length && !d.companyId ? '<section class="section"><h2 class="h2">Coming up</h2><div class="list">' + pays.slice(0, 2).map(x => '<div class="list-row"><span class="list-main">' + esc(x.jurisdiction) + ' estimated payment</span><span class="list-num">' + esc(x.amount) + '</span><span class="list-end muted">Due ' + esc(fmtDue(x)) + '</span></div>').join('') + '</div></section>' : '') +
      (rep && window.portalRenderTaxSummary ? '<details class="details"><summary>See the full tax summary</summary><div class="details-body">' + window.portalRenderTaxSummary(rep) + '</div></details>' : '') +
      '<div class="actions">' + (p.currentSigner ? btn('Continue to review', 'PortalTax.goStep(\'review\')') : btn('View the return', 'PortalTax.goStep(\'review\')')) +
      '<button type="button" class="btn-link" onclick="PortalCore.goTab(\'messages\')">Ask a question</button></div>';
  }

  function docViewer(doc) {
    if (!doc) return '<div class="inline-notice">The return document isn\'t attached yet. Message your team if you expected it.</div>';
    const url = doc.signedUrl;
    return '<div class="viewer"><div class="viewer-bar"><span>' + icon('file-text') + ' ' + esc(doc.name || 'Tax return') + '</span>' +
      (url ? '<span class="viewer-actions"><a href="' + esc(url) + '" target="_blank" rel="noopener">' + icon('external-link') + ' Open in new tab</a></span>' : '') + '</div>' +
      (url ? '<iframe class="viewer-frame" src="' + esc(url) + '" title="' + esc(doc.name || 'Tax return') + '"></iframe>' : '<div class="viewer-empty">Preview unavailable.</div>') + '</div>';
  }

  function stepReview(p) {
    const me = p.currentSigner;
    const actions = p.allowedActions || {};
    let foot = '';
    if (!me) foot = '<p class="hint">You can view this return. The people listed on the right sign it.</p>';
    else if (me.approvedAt) foot = '<p class="hint">' + icon('check') + ' You approved this return on ' + esc(fmtDate(me.approvedAt, true)) + '.</p><div class="actions">' + btn('Continue to sign', 'PortalTax.goStep(\'sign\')') + '</div>';
    else if (flow.changes) {
      foot = '<div class="change-form"><label class="label" for="changeNote">What needs to change?</label>' +
        '<textarea id="changeNote" rows="4" placeholder="Describe what looks wrong or is missing. Your team will update the return and send it back."></textarea>' +
        '<div class="actions">' + btn(flow.busy ? 'Sending…' : 'Send to your team', 'PortalTax.requestChanges()') +
        '<button type="button" class="btn-link" onclick="PortalTax.toggleChanges(false)">Cancel</button></div></div>';
    } else {
      foot = '<label class="check"><input type="checkbox" id="reviewedCheck" ' + (flow.reviewed ? 'checked' : '') + ' onchange="PortalTax.setReviewed(this.checked)"> I\'ve reviewed my return and it looks correct.</label>' +
        '<div class="actions"><button type="button" class="btn btn-gold" id="approveBtn" ' + (flow.reviewed && actions.canApprove !== false && !flow.busy ? '' : 'disabled') + ' onclick="PortalTax.approve()">' + (flow.busy ? 'Approving…' : 'Approve return') + '</button>' +
        (actions.canRequestChanges !== false ? '<button type="button" class="btn btn-outline" onclick="PortalTax.toggleChanges(true)">Something needs to change</button>' : '') +
        '<button type="button" class="btn-link" onclick="PortalTax.goStep(\'summary\')">Back to summary</button></div>';
    }
    return '<h2 class="h2">Look over your return</h2><p class="lead">This is the complete return we\'ll file. Take your time.</p>' +
      docViewer(p.documents && p.documents.review) + foot;
  }

  function stepSign(p) {
    const d = p.delivery;
    const me = p.currentSigner;
    const signer = (p.signers || []).find(sg => me && sg.id === me.id);
    const sigDoc = p.documents && p.documents.signature;
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    return '<h2 class="h2">Sign your e-file authorization</h2>' +
      '<p class="lead">By signing, you authorize ' + esc(window.DarkLionFirm?.name || 'your firm') + ' to e-file your ' + esc(d.taxYear) + ' return' + (d.companyName ? ' for ' + esc(d.companyName) : '') + '.</p>' +
      (sigDoc ? '<div class="list"><div class="list-row"><span class="file-icon">' + icon('file-text') + '</span><span class="list-main">' + esc(sigDoc.name || 'Signature pages') + '</span>' +
        (sigDoc.signedUrl ? '<a class="btn-link" href="' + esc(sigDoc.signedUrl) + '" target="_blank" rel="noopener">View form</a>' : '') + '</div></div>' : '') +
      '<div class="label">Your signature</div>' +
      '<div class="segmented" role="tablist"><button type="button" class="' + (flow.sigMode === 'draw' ? 'is-on' : '') + '" onclick="PortalTax.sigMode(\'draw\')">Draw</button>' +
      '<button type="button" class="' + (flow.sigMode === 'type' ? 'is-on' : '') + '" onclick="PortalTax.sigMode(\'type\')">Type</button></div>' +
      (flow.sigMode === 'draw'
        ? '<div class="sig-pad"><canvas id="sigCanvas" width="960" height="240" aria-label="Draw your signature"></canvas><span class="sig-line"></span><button type="button" class="btn-link sig-clear" onclick="PortalTax.clearSig()">Clear</button></div>'
        : '<input class="sig-typed" id="sigTyped" type="text" autocomplete="name" placeholder="Type your full legal name" value="' + esc(flow.typed || '') + '" oninput="PortalTax.setTyped(this.value)">') +
      '<p class="hint">Signing as ' + esc(signer ? signer.name : 'you') + ' · ' + esc(today) + '</p>' +
      '<label class="check"><input type="checkbox" ' + (flow.consent ? 'checked' : '') + ' onchange="PortalTax.setConsent(this.checked)"> I agree to sign electronically. My electronic signature has the same legal effect as a handwritten one.</label>' +
      '<div class="actions"><button type="button" class="btn btn-gold" id="signBtn" ' + (flow.consent && !flow.busy ? '' : 'disabled') + ' onclick="PortalTax.submitSignature()">' + (flow.busy ? 'Submitting…' : 'Sign and submit') + '</button>' +
      '<button type="button" class="btn-link" onclick="PortalTax.goStep(\'review\')">Back to review</button></div>';
  }

  function stepDone(p) {
    const d = p.delivery;
    const me = p.currentSigner;
    const signers = p.signers || [];
    const waiting = signers.filter(sg => !sg.signedAt);
    const allSigned = signers.length > 0 && !waiting.length;
    const name = firstName((signers.find(sg => me && sg.id === me.id) || {}).name || (core().me() || {}).firstName);
    let headline, lead;
    const known = d.filedDateKnown !== false;
    if (d.acceptedAt) { headline = 'Your return was accepted'; lead = (known ? 'E-filed ' + fmtDate(d.filedAt, true) + ' and accepted ' : 'Accepted ') + fmtDate(d.acceptedAt, true) + '. You\'re all set.'; }
    else if (d.filedAt) { headline = 'Your return was filed'; lead = (known ? 'We e-filed it on ' + fmtDate(d.filedAt, true) + '. ' : '') + 'We\'ll update this page when it\'s accepted.'; }
    else if (allSigned) { headline = 'You\'ve signed — thank you' + (name ? ', ' + name : ''); lead = 'Everyone has signed. We\'ll e-file your return next.'; }
    else if (me && me.signedAt) { headline = 'You\'ve signed — thank you' + (name ? ', ' + name : ''); lead = joinNames(waiting.map(sg => sg.name)) + ' still ' + (waiting.length === 1 ? 'needs' : 'need') + ' to sign before we can e-file.'; }
    else { headline = 'Waiting on signatures'; lead = 'This return is with the signers listed on the right.'; }
    const steps = signers.map(sg => '<div class="list-row"><span class="status-dot ' + (sg.signedAt ? 'is-done' : 'is-wait') + '"></span><span class="list-main">' + esc(firstName(sg.name)) + ' signs</span><span class="list-end muted">' + (sg.signedAt ? 'Done ' + esc(fmtDate(sg.signedAt)) : 'Waiting') + '</span></div>').join('') +
      '<div class="list-row"><span class="status-dot ' + (d.filedAt ? 'is-done' : allSigned ? 'is-now' : 'is-idle') + '"></span><span class="list-main">We e-file your return</span><span class="list-end muted">' + (d.filedAt ? (known ? 'Done ' + esc(fmtDate(d.filedAt)) : 'Done') : allSigned ? 'Next' : 'After everyone signs') + '</span></div>' +
      '<div class="list-row"><span class="status-dot ' + (d.acceptedAt ? 'is-done' : 'is-idle') + '"></span><span class="list-main">The IRS accepts your return</span><span class="list-end muted">' + (d.acceptedAt ? 'Done ' + esc(fmtDate(d.acceptedAt)) : 'Usually within a few days of filing') + '</span></div>';
    const docs = [];
    if (p.documents && p.documents.review && p.documents.review.signedUrl) docs.push('<a class="list-row list-button" href="' + esc(p.documents.review.signedUrl) + '" target="_blank" rel="noopener"><span class="file-icon">' + icon('file-text') + '</span><span class="list-main">' + esc(p.documents.review.name || 'Review copy') + '</span><span class="chev">' + icon('download') + '</span></a>');
    if (d.signedDocId) docs.push('<button type="button" class="list-row list-button" onclick="PortalCore.openDoc(' + Number(d.signedDocId) + ', this)"><span class="file-icon">' + icon('file-check') + '</span><span class="list-main">Signed return</span><span class="chev">' + icon('download') + '</span></button>');
    return '<div class="done-head"><span class="done-mark">' + icon('check') + '</span><div><h2 class="h1">' + esc(headline) + '</h2><p class="lead">' + esc(lead) + '</p></div></div>' +
      '<section class="section"><h2 class="h2">What happens next</h2><div class="list">' + steps + '</div></section>' +
      (docs.length ? '<section class="section"><h2 class="h2">Your documents</h2><div class="list">' + docs.join('') + '</div></section>' : '') +
      '<div class="actions">' + btn('Back to home', 'PortalCore.goTab(\'overview\')') + '</div>';
  }

  function stepChanges(p) {
    const d = p.delivery;
    const note = d.needsChangesNote || (p.currentSigner && p.currentSigner.needsChangesNote) || '';
    return '<h2 class="h2">We\'re updating your return</h2><p class="lead">Thanks for letting us know. Your team is making the changes and will send the updated return for your review. You don\'t need to do anything right now.</p>' +
      (note ? '<section class="section"><h2 class="h3">Your note</h2><blockquote class="quote">' + esc(note) + '</blockquote></section>' : '') +
      '<div class="actions">' + btn(icon('message-square') + ' Message your team', 'PortalCore.goTab(\'messages\')', 'btn-outline') + '</div>';
  }

  // ── Actions ─────────────────────────────────────────────────────────────
  async function afterAction(nextStep) {
    await loadPacket();
    if (nextStep) flow.step = nextStep;
    renderFlow();
    refresh().catch(() => undefined);
  }

  async function approve() {
    if (!flow || flow.busy || !flow.reviewed) return;
    flow.busy = true; flow.error = ''; renderFlow();
    try {
      await core().api(flow.packet.actionEndpoints.approve, { method: 'POST', body: '{}' });
      flow.busy = false;
      await afterAction('sign');
    } catch (e) {
      flow.busy = false; flow.error = 'Your approval didn\'t go through. ' + e.message; renderFlow();
    }
  }

  async function requestChanges() {
    if (!flow || flow.busy) return;
    const note = (document.getElementById('changeNote') || {}).value || '';
    if (!note.trim()) { flow.error = 'Tell us what needs to change.'; renderFlow(); return; }
    flow.busy = true; flow.error = ''; renderFlow();
    try {
      await core().api(flow.packet.actionEndpoints.requestChanges, { method: 'POST', body: JSON.stringify({ note: note.trim() }) });
      flow.busy = false; flow.changes = false;
      await afterAction('changes');
    } catch (e) {
      flow.busy = false; flow.error = 'Your request didn\'t send. ' + e.message; renderFlow();
      const box = document.getElementById('changeNote'); if (box) box.value = note;
    }
  }

  // Signature pad: pointer events cover mouse, pen, and touch.
  let sig = { drawn: false, drawing: false };
  function initSignature() {
    const canvas = document.getElementById('sigCanvas');
    if (!canvas || canvas.dataset.ready) return;
    canvas.dataset.ready = '1';
    sig = { drawn: false, drawing: false };
    const ctx = canvas.getContext('2d');
    // Dark ink so the signature reads correctly when embedded on the white signed PDF.
    ctx.strokeStyle = '#1b2233'; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const pos = e => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height }; };
    canvas.addEventListener('pointerdown', e => { sig.drawing = true; canvas.setPointerCapture(e.pointerId); const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); });
    canvas.addEventListener('pointermove', e => { if (!sig.drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); sig.drawn = true; });
    const end = () => { sig.drawing = false; };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  }
  function clearSig() {
    const canvas = document.getElementById('sigCanvas');
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    sig.drawn = false;
  }

  async function submitSignature() {
    if (!flow || flow.busy || !flow.consent) return;
    let data, type;
    if (flow.sigMode === 'draw') {
      if (!sig.drawn) { flow.error = 'Draw your signature in the box, or switch to Type.'; renderFlow(); return; }
      data = document.getElementById('sigCanvas').toDataURL('image/png'); type = 'drawn';
    } else {
      data = String(flow.typed || '').trim(); type = 'typed';
      if (data.length < 2) { flow.error = 'Type your full legal name to sign.'; renderFlow(); return; }
    }
    flow.busy = true; flow.error = ''; renderFlow();
    try {
      await core().api(flow.packet.actionEndpoints.sign, { method: 'POST', body: JSON.stringify({ signature_data: data, signature_type: type }) });
      flow.busy = false;
      await afterAction('done');
    } catch (e) {
      flow.busy = false; flow.error = 'Your signature didn\'t go through. ' + e.message; renderFlow();
    }
  }

  window.PortalTax = {
    refresh,
    renderHome,
    renderTaxes: () => (flow ? renderFlow() : renderTaxesList()),
    openReturn,
    reload: loadPacket,
    close: closeFlow,
    goStep,
    approve,
    requestChanges,
    submitSignature,
    clearSig,
    hasFlow: () => Boolean(flow),
    setYear,
    routeYear: () => selectedYear,
    toggleChanges: on => { flow.changes = on; flow.error = ''; renderFlow(); },
    setReviewed: on => { flow.reviewed = on; const b = document.getElementById('approveBtn'); if (b) b.disabled = !on || flow.busy; },
    setConsent: on => { flow.consent = on; const b = document.getElementById('signBtn'); if (b) b.disabled = !on || flow.busy; },
    setTyped: v => { flow.typed = v; },
    sigMode: m => { flow.sigMode = m; flow.error = ''; renderFlow(); },
    _state: () => ({ status, flow }),
  };
})();
