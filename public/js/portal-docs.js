// Documents for the client portal. Two stacked sections (from your team, uploaded by you), each with
// year accordions, plus a year bar that jumps both sections to one year. Used for personal documents and each business.
(function () {
  'use strict';

  const core = () => window.PortalCore;
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const icon = n => '<i class="icon-' + n + '" aria-hidden="true"></i>';
  const views = {}; // per container: { docs, opts, year, query, open:Set }
  const pendingQuery = {}; // search carried into a section that hasn't been opened yet

  const CATS = [['tax', 'Tax'], ['bookkeeping', 'Bookkeeping'], ['other', 'Other']];

  function typeBadge(doc) {
    const mime = String(doc.mime_type || '').toLowerCase();
    const name = String(doc.display_name || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    if (mime === 'application/pdf' || ext === 'pdf') return ['PDF', '#e53e3e'];
    if (ext === 'csv' || mime === 'text/csv') return ['CSV', '#38a169'];
    if (/sheet|excel/.test(mime) || ['xlsx', 'xls'].includes(ext)) return ['Excel', '#38a169'];
    if (/word/.test(mime) || ['doc', 'docx'].includes(ext)) return ['Word', '#3182ce'];
    if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'heic', 'gif', 'webp'].includes(ext)) return ['Image', '#805ad5'];
    if (/zip/.test(mime) || ext === 'zip') return ['ZIP', '#718096'];
    return [ext ? ext.toUpperCase().slice(0, 4) : 'File', '#718096'];
  }
  function size(b) {
    if (!b) return '';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1048576).toFixed(1) + ' MB';
  }
  // Date the file was added to the portal, always with the year ("Jun 8, 2026").
  function when(doc) {
    const v = doc.delivered_at || doc.created_at;
    const d = v ? new Date(v) : null;
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  const isLetter = d => String(d.folder_category || '').toLowerCase() === 'engagement_letter' || String(d.doc_type || '').toLowerCase() === 'engagement_letter';
  const fromClient = d => d.folder_section === 'client_uploaded';
  const yearOf = d => String(d.year || 'Undated');
  const catOf = d => (['tax', 'bookkeeping'].includes(d.folder_category) ? d.folder_category : 'other');
  const sortTime = d => new Date(d.delivered_at || d.created_at || 0).getTime();
  const byYearDesc = (a, b) => (a === 'Undated') - (b === 'Undated') || b.localeCompare(a);
  const matches = (d, q) => !q || String(d.display_name || '').toLowerCase().includes(q) || String(d.folder_subcategory || '').toLowerCase().includes(q);
  const ownerKey = d => (d.owner_type === 'company' ? 'co-docs-' + Number(d.owner_id) : 'docsContainer');

  function row(doc, key) {
    const [label, color] = typeBadge(doc);
    const mine = fromClient(doc);
    const isNew = !mine && core().isDocNew(doc);
    // "Viewed" only when the file was actually opened in the portal (viewed_at is set on first open).
    const badges = (mine ? '' : isNew ? '<span class="doc-badge doc-badge-new">NEW</span>' : doc.viewed_at ? '<span class="doc-badge doc-badge-viewed">' + icon('check') + ' Viewed</span>' : '') +
      (doc.size_bytes ? '<span class="doc-badge doc-badge-type">' + esc(size(doc.size_bytes)) + '</span>' : '') +
      (when(doc) ? '<span class="doc-badge doc-badge-type">' + esc(when(doc)) + '</span>' : '');
    return '<div class="doc-row">' +
      '<span class="doc-type-badge" style="background:' + color + '">' + esc(label) + '</span>' +
      '<div class="doc-info"><button type="button" class="doc-name doc-name-btn" title="' + esc(doc.display_name || 'Document') + '" onclick="PortalDocs.open(\'' + key + '\',' + Number(doc.id) + ', this)"><span class="doc-name-text">' + esc(doc.display_name || 'Document') + '</span></button>' +
      '<div class="doc-badges">' + badges + '</div></div>' +
      (mine ? '<button type="button" class="btn-dl" onclick="PortalDocs.move(\'' + key + '\',' + Number(doc.id) + ')">Move</button>' : '') +
      '<button type="button" class="btn-dl" onclick="PortalDocs.open(\'' + key + '\',' + Number(doc.id) + ', this)">' + icon('download') + ' Download</button></div>';
  }

  function yearBody(docs, key) {
    let html = '';
    CATS.forEach(([cat, label]) => {
      const list = docs.filter(d => catOf(d) === cat);
      if (!list.length) return;
      html += '<div class="doc-cat">' + esc(label) + ' <span>' + list.length + '</span></div>';
      const groups = {};
      list.forEach(d => { const g = d.folder_subcategory || ''; (groups[g] = groups[g] || []).push(d); });
      Object.keys(groups).sort().forEach(g => {
        if (g) html += '<div class="doc-subcat">' + icon('folder') + ' ' + esc(g) + '</div>';
        html += groups[g].map(d => row(d, key)).join('');
      });
    });
    return html;
  }

  function folder(key, id, labelHtml, count, hasNew, bodyHtml) {
    const v = views[key];
    const open = v.open.has(id);
    return '<div class="year-folder' + (open ? ' open' : '') + '">' +
      '<button type="button" class="year-header" aria-expanded="' + open + '" onclick="PortalDocs.toggle(\'' + key + '\',\'' + id + '\')">' +
      '<span class="yr-label">' + labelHtml + ' <span class="yr-count">' + count + '</span>' + (hasNew ? ' <span class="yr-new">NEW</span>' : '') + '</span>' +
      '<span class="yr-chevron">▼</span></button>' +
      '<div class="year-body">' + bodyHtml + '</div></div>';
  }

  function section(key, id, title, docs, letters, isMine) {
    const v = views[key];
    const q = v.query.trim().toLowerCase();
    const match = d => matches(d, q);
    const shown = docs.filter(d => (v.year === 'all' || yearOf(d) === v.year) && match(d)).sort((a, b) => sortTime(b) - sortTime(a));
    const years = [...new Set(shown.map(yearOf))].sort(byYearDesc);
    const lettersShown = v.year === 'all' ? letters.filter(match) : [];
    // The count follows the year and search filters: "3 of 10" while filtered.
    const total = docs.length + letters.length;
    const visible = shown.length + lettersShown.length;
    const filtered = v.year !== 'all' || q;
    const countText = filtered && visible !== total ? visible + ' of ' + total : String(total);
    let html = '<section class="docs-section" id="' + key + '-' + id + '">' +
      '<div class="docs-section-head"><h2 class="h2">' + esc(title) + ' <span class="muted doc-count">' + countText + '</span></h2>' +
      (isMine ? '<button type="button" class="btn btn-outline btn-sm" onclick="PortalDocs.upload(\'' + key + '\')">' + icon('upload') + ' Upload</button>' : '') + '</div>';
    if (lettersShown.length) {
      html += folder(key, id + ':letters', 'Engagement letters', lettersShown.length, lettersShown.some(d => core().isDocNew(d)), lettersShown.map(d => row(d, key)).join(''));
    }
    years.forEach(y => {
      const list = shown.filter(d => yearOf(d) === y);
      // A chosen year or a search opens its folders; otherwise follow what the client opened.
      if (v.year !== 'all' || q) v.open.add(id + ':' + y);
      html += folder(key, id + ':' + y, esc(y), list.length, !isMine && list.some(d => core().isDocNew(d)), yearBody(list, key));
    });
    if (!years.length && !lettersShown.length) {
      html += '<div class="docs-empty">' + (q ? 'Nothing matches “' + esc(v.query) + '”.' : isMine ? (v.year === 'all' ? 'You haven\'t uploaded anything yet.' : 'Nothing uploaded for ' + esc(v.year) + '.') : (v.year === 'all' ? 'No documents yet.' : 'Nothing from your team for ' + esc(v.year) + '.')) + '</div>';
    }
    return html + '</section>';
  }

  function render(key) {
    const v = views[key];
    const el = document.getElementById(key);
    if (!v || !el) return;
    const team = v.docs.filter(d => !fromClient(d));
    const letters = team.filter(isLetter);
    const teamDocs = team.filter(d => !isLetter(d));
    const mine = v.docs.filter(fromClient);
    const years = [...new Set(teamDocs.concat(mine).map(yearOf))].sort(byYearDesc);
    const newCount = team.filter(d => core().isDocNew(d)).length;
    const focusSearch = document.activeElement && document.activeElement.id === key + '-q';
    const chip = (y, label) => '<button type="button" class="' + (v.year === y ? 'is-on' : '') + '" onclick="PortalDocs.set(\'' + key + '\',\'year\',\'' + esc(y) + '\')">' + esc(label) + '</button>';

    el.innerHTML =
      '<div class="docs-head"><div>' + (v.opts.hideTitle ? '' : '<h1 class="page-title">' + esc(v.opts.title) + '</h1>') +
        '<p class="page-sub">' + (newCount ? newCount + ' new from your team.' : 'Files your team shared with you and files you sent us.') + '</p></div>' +
        '<label class="docs-search">' + icon('search') + '<input id="' + key + '-q" type="search" placeholder="Search documents" value="' + esc(v.query) + '" oninput="PortalDocs.set(\'' + key + '\',\'query\',this.value)"></label></div>' +
      (years.length > 1 ? '<div class="year-bar" role="toolbar" aria-label="Jump to year">' + chip('all', 'All years') + years.map(y => chip(y, y)).join('') + '</div>' : '') +
      elsewhere(key) +
      '<div class="docs-columns">' +
      section(key, 'team', 'Delivered by your team', teamDocs, letters, false) +
      section(key, 'mine', 'Uploaded by you', mine, [], true) +
      '</div>';
    if (focusSearch) { const i = document.getElementById(key + '-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  // Search covers personal and business documents: matches outside this page are listed with a link there.
  function elsewhere(key) {
    const v = views[key];
    const q = v.query.trim().toLowerCase();
    if (!q) return '';
    const counts = {};
    (core().docs() || []).forEach(d => {
      const k = ownerKey(d);
      if (k !== key && matches(d, q)) counts[k] = (counts[k] || 0) + 1;
    });
    const companies = (core().companies && core().companies()) || [];
    const links = Object.keys(counts).map(k => {
      let label = 'Your personal documents';
      if (k !== 'docsContainer') {
        const id = Number(k.replace('co-docs-', ''));
        const co = companies.find(c => Number(c.id || c.company_id) === id);
        if (!co) return '';
        label = co.company_name || co.name || 'Business';
      }
      return '<button type="button" class="btn-link" onclick="PortalDocs.searchIn(\'' + k + '\',\'' + key + '\')">' + esc(label) + ' (' + counts[k] + ')</button>';
    }).filter(Boolean);
    return links.length ? '<div class="docs-elsewhere" role="status">' + icon('search') + '<span>Also found in</span>' + links.join('') + '</div>' : '';
  }

  function defaultOpen(docs) {
    // The most recent year starts open in both columns, plus engagement letters.
    const open = new Set(['team:letters']);
    const y = [...new Set(docs.filter(d => !isLetter(d)).map(yearOf))].sort(byYearDesc)[0];
    if (y) { open.add('team:' + y); open.add('mine:' + y); }
    return open;
  }

  window.PortalDocs = {
    // opts: { title, companyId }
    mount(containerId, docs, opts) {
      const prev = views[containerId];
      const carried = pendingQuery[containerId];
      delete pendingQuery[containerId];
      views[containerId] = { docs: docs || [], opts: opts || {}, year: carried != null ? 'all' : prev ? prev.year : 'all', query: carried != null ? carried : prev ? prev.query : '', open: prev ? prev.open : defaultOpen(docs || []) };
      render(containerId);
    },
    // Opens the page that holds other matches and runs the same search there.
    searchIn(targetKey, fromKey) {
      const q = views[fromKey] ? views[fromKey].query : '';
      if (views[targetKey]) { views[targetKey].query = q; views[targetKey].year = 'all'; render(targetKey); }
      else pendingQuery[targetKey] = q;
      if (targetKey === 'docsContainer') core().goTab('documents');
      else core().openCompanyDocs(Number(targetKey.replace('co-docs-', '')));
    },
    set(key, field, value) {
      const v = views[key];
      if (!v) return;
      if (field === 'year' && value === 'all') v.open = defaultOpen(v.docs);
      v[field] = value;
      render(key);
    },
    toggle(key, id) {
      const v = views[key];
      if (!v) return;
      // Year folders are linked across the two columns: opening 2025 on one side opens it on the other.
      const year = id.split(':')[1];
      const ids = year && year !== 'letters' ? ['team:' + year, 'mine:' + year] : [id];
      const opening = !v.open.has(id);
      ids.forEach(x => (opening ? v.open.add(x) : v.open.delete(x)));
      render(key);
    },
    upload(key) { core().upload(views[key] && views[key].opts.companyId || null); },
    move(key, id) {
      const d = (views[key] && views[key].docs || []).find(x => Number(x.id) === Number(id));
      if (d) core().move(d.id, d.display_name || 'Document', d.year || '', d.folder_category || 'other', d.document_folder_id || '');
    },
    async open(key, id, el) {
      // Open the tab during the click so browsers allow it, then point it at the file.
      const tab = window.open('', '_blank');
      if (el) el.setAttribute('aria-busy', 'true');
      try {
        const data = await core().api('/portal/documents/' + Number(id) + '/download');
        if (tab) { tab.opener = null; tab.location.href = data.url; } else window.location.href = data.url;
        const d = (views[key] && views[key].docs || []).find(x => Number(x.id) === Number(id));
        if (d && !d.viewed_at) { d.viewed_at = new Date().toISOString(); render(key); }
      } catch (e) {
        if (tab) tab.close();
        alert('That document could not open. ' + e.message);
      } finally {
        if (el) el.removeAttribute('aria-busy');
      }
    },
  };
})();
