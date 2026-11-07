(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatBytes(b) {
    const n = Number(b) || 0;
    if (!n) return '0 B';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function ensureModal() {
    let overlay = document.getElementById('clientDocPickerOverlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'clientDocPickerOverlay';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:3000;align-items:center;justify-content:center;padding:1rem;';
    overlay.innerHTML = `
      <div style="background:var(--card,#161b22);border:1px solid var(--border,#30363d);border-radius:14px;width:min(920px,96vw);max-height:86vh;display:flex;flex-direction:column;box-shadow:0 24px 80px rgba(0,0,0,0.55);" onclick="event.stopPropagation()">
        <div style="padding:1rem 1.15rem;border-bottom:1px solid var(--border,#30363d);display:flex;align-items:center;justify-content:space-between;gap:1rem;">
          <div>
            <div style="font-weight:800;color:var(--text,#f0f6fc);">Attach from Client Docs</div>
            <div id="clientDocPickerScope" style="font-size:0.78rem;color:var(--muted,#8b949e);margin-top:0.15rem;"></div>
          </div>
          <button id="clientDocPickerClose" type="button" style="background:none;border:none;color:var(--muted,#8b949e);font-size:1.25rem;cursor:pointer;line-height:1;">✕</button>
        </div>
        <div style="padding:0.8rem 1.15rem;border-bottom:1px solid var(--border,#30363d);display:flex;gap:0.65rem;align-items:center;flex-wrap:wrap;">
          <input id="clientDocPickerSearch" type="search" placeholder="Search documents…" style="flex:1;min-width:220px;background:var(--input-bg,#0d1117);border:1px solid var(--border,#30363d);border-radius:8px;color:var(--text,#f0f6fc);padding:0.55rem 0.7rem;">
          <div id="clientDocPickerCount" style="font-size:0.78rem;color:var(--muted,#8b949e);"></div>
        </div>
        <div id="clientDocPickerBody" style="overflow:auto;padding:0.8rem 1.15rem;min-height:220px;"></div>
        <div style="padding:0.8rem 1.15rem;border-top:1px solid var(--border,#30363d);display:flex;justify-content:space-between;gap:0.6rem;align-items:center;">
          <div id="clientDocPickerSelectedPreview" style="min-width:0;flex:1;color:var(--muted,#8b949e);font-size:0.76rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
          <div style="display:flex;gap:0.6rem;flex-shrink:0;">
            <button id="clientDocPickerCancel" type="button" class="btn btn-outline btn-sm">Cancel</button>
            <button id="clientDocPickerApply" type="button" class="btn btn-gold btn-sm">Attach selected</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', close);
    overlay.querySelector('#clientDocPickerClose').addEventListener('click', close);
    overlay.querySelector('#clientDocPickerCancel').addEventListener('click', close);
    return overlay;
  }

  let state = { sources: [], selected: new Map(), expanded: new Set(), onApply: null };

  function selectedCount() { return state.selected.size; }

  function sourceKey(source) {
    return `source:${source.key || `${source.ownerType}:${source.ownerId}`}`;
  }

  function yearKey(source, year) {
    return `${sourceKey(source)}:year:${year || 'No year'}`;
  }

  function categoryKey(source, year, category) {
    return `${yearKey(source, year)}:cat:${category || 'Uncategorized'}`;
  }

  function isExpanded(key) { return state.expanded.has(key); }

  function selectedInDocs(docs) {
    return docs.filter(d => state.selected.has(Number(d.id))).length;
  }

  function matchesSearch(doc, source, search) {
    if (!search) return true;
    const hay = [doc.displayName, doc.year, doc.category, doc.section, doc.ownerName, source.label].join(' ').toLowerCase();
    return hay.includes(search);
  }

  function groupedDocs(docs) {
    const years = new Map();
    for (const doc of docs) {
      const year = doc.year || 'No year';
      const category = doc.category || 'Uncategorized';
      if (!years.has(year)) years.set(year, new Map());
      const cats = years.get(year);
      if (!cats.has(category)) cats.set(category, []);
      cats.get(category).push(doc);
    }
    return years;
  }

  function renderDocRow(doc) {
    const checked = state.selected.has(Number(doc.id)) ? 'checked' : '';
    const meta = [doc.year, doc.category, doc.section, formatBytes(doc.sizeBytes)].filter(Boolean).join(' · ');
    return `<label style="display:flex;gap:0.6rem;align-items:flex-start;padding:0.48rem 0.6rem 0.48rem 2rem;border-top:1px solid rgba(255,255,255,0.05);background:rgba(255,255,255,0.025);cursor:pointer;">
      <input type="checkbox" data-doc-id="${doc.id}" ${checked} style="margin-top:0.18rem;">
      <span style="min-width:0;">
        <span style="display:block;color:var(--text,#f0f6fc);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 ${esc(doc.displayName)}</span>
        <span style="display:block;color:var(--muted,#8b949e);font-size:0.74rem;margin-top:0.1rem;">${esc(meta)}</span>
      </span>
    </label>`;
  }

  function renderFolderButton({ key, icon, label, docs, indent = 0 }) {
    const open = isExpanded(key);
    const selected = selectedInDocs(docs);
    return `<button type="button" data-toggle-key="${esc(key)}" style="width:100%;display:flex;align-items:center;gap:0.45rem;padding:0.5rem 0.65rem 0.5rem ${0.65 + indent}rem;background:rgba(255,255,255,0.035);border:0;border-top:1px solid rgba(255,255,255,0.06);color:var(--text,#f0f6fc);cursor:pointer;text-align:left;">
      <span style="width:1rem;color:var(--muted,#8b949e);">${open ? '▾' : '▸'}</span>
      <span>${icon}</span>
      <span style="font-weight:650;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(label)}</span>
      <span style="margin-left:auto;color:var(--muted,#8b949e);font-size:0.72rem;white-space:nowrap;">${selected ? `${selected} selected · ` : ''}${docs.length} docs</span>
    </button>`;
  }

  function render() {
    const overlay = ensureModal();
    const body = overlay.querySelector('#clientDocPickerBody');
    const search = (overlay.querySelector('#clientDocPickerSearch').value || '').trim().toLowerCase();
    const selectedDocs = Array.from(state.selected.values());

    overlay.querySelector('#clientDocPickerCount').textContent = `${selectedCount()} selected`;
    overlay.querySelector('#clientDocPickerApply').textContent = selectedCount() ? `Attach ${selectedCount()} selected` : 'Attach selected';
    overlay.querySelector('#clientDocPickerSelectedPreview').textContent = selectedDocs.length
      ? selectedDocs.slice(0, 4).map(d => d.displayName).join(', ') + (selectedDocs.length > 4 ? ` +${selectedDocs.length - 4} more` : '')
      : 'Select one or more documents to attach.';

    const parts = [];
    for (const source of state.sources) {
      const docs = (source.documents || []).filter(d => matchesSearch(d, source, search));
      if (!docs.length) continue;

      const sKey = sourceKey(source);
      const sourceOpen = search || isExpanded(sKey);
      const sourceSelected = selectedInDocs(docs);
      parts.push(`<div style="margin-bottom:0.55rem;border:1px solid var(--border,#30363d);border-radius:10px;overflow:hidden;background:rgba(255,255,255,0.02);">
        <button type="button" data-toggle-key="${esc(sKey)}" style="width:100%;display:flex;align-items:center;gap:0.55rem;padding:0.7rem 0.75rem;background:rgba(255,255,255,0.045);border:0;color:var(--text,#f0f6fc);cursor:pointer;text-align:left;">
          <span style="width:1rem;color:var(--muted,#8b949e);">${sourceOpen ? '▾' : '▸'}</span>
          <span>${source.ownerType === 'company' ? '🏢' : '👤'}</span>
          <span style="font-weight:800;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(source.label)}</span>
          <span style="margin-left:auto;color:var(--muted,#8b949e);font-size:0.74rem;white-space:nowrap;">${sourceSelected ? `${sourceSelected} selected · ` : ''}${docs.length} docs</span>
        </button>`);

      if (sourceOpen) {
        const years = groupedDocs(docs);
        for (const [year, cats] of years.entries()) {
          const yearDocs = Array.from(cats.values()).flat();
          const yKey = yearKey(source, year);
          const yearOpen = search || isExpanded(yKey);
          parts.push(renderFolderButton({ key: yKey, icon: '📁', label: year, docs: yearDocs, indent: 0.75 }));
          if (!yearOpen) continue;
          for (const [category, catDocs] of cats.entries()) {
            const cKey = categoryKey(source, year, category);
            const catOpen = search || isExpanded(cKey);
            parts.push(renderFolderButton({ key: cKey, icon: '🗂️', label: category, docs: catDocs, indent: 1.6 }));
            if (catOpen) parts.push(catDocs.map(renderDocRow).join(''));
          }
        }
      }

      parts.push('</div>');
    }

    body.innerHTML = parts.length ? parts.join('') : '<div style="color:var(--muted,#8b949e);padding:1.5rem;text-align:center;">No matching client documents found.</div>';
    body.querySelectorAll('[data-toggle-key]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-toggle-key');
        if (!key) return;
        if (state.expanded.has(key)) state.expanded.delete(key);
        else state.expanded.add(key);
        render();
      });
    });
    body.querySelectorAll('input[data-doc-id]').forEach(input => {
      input.addEventListener('change', () => {
        const id = Number(input.dataset.docId);
        const doc = findDoc(id);
        if (!doc) return;
        if (input.checked) state.selected.set(id, doc);
        else state.selected.delete(id);
        render();
      });
    });
  }

  function findDoc(id) {
    for (const source of state.sources) {
      const doc = (source.documents || []).find(d => Number(d.id) === Number(id));
      if (doc) return doc;
    }
    return null;
  }

  function close() {
    const overlay = document.getElementById('clientDocPickerOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  async function open(opts) {
    const overlay = ensureModal();
    state = {
      sources: [],
      selected: new Map((opts.selected || []).map(d => [Number(d.id), d])),
      expanded: new Set(),
      onApply: opts.onApply,
    };
    overlay.style.display = 'flex';
    overlay.querySelector('#clientDocPickerScope').textContent = 'Loading client documents…';
    overlay.querySelector('#clientDocPickerBody').innerHTML = '<div style="display:flex;justify-content:center;padding:2rem;"><div class="spinner"></div></div>';
    overlay.querySelector('#clientDocPickerSearch').value = '';
    overlay.querySelector('#clientDocPickerSelectedPreview').textContent = '';

    const params = new URLSearchParams();
    const scope = opts.scope || {};
    if (scope.threadId) params.set('thread_id', scope.threadId);
    if (scope.personId) params.set('person_id', scope.personId);
    if (scope.companyId) params.set('company_id', scope.companyId);

    try {
      const apiFetch = opts.apiFetch || window.apiFetch;
      const res = await apiFetch('/api/messages/document-picker?' + params.toString());
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load documents');
      state.sources = data.sources || [];
      overlay.querySelector('#clientDocPickerScope').textContent = data.scope?.relationshipName ? `Relationship: ${data.scope.relationshipName}` : 'Client relationship documents';
      render();
    } catch (e) {
      overlay.querySelector('#clientDocPickerScope').textContent = '';
      overlay.querySelector('#clientDocPickerBody').innerHTML = `<div style="color:#f87171;padding:1.5rem;text-align:center;">${esc(e.message || 'Failed to load documents')}</div>`;
    }

    overlay.querySelector('#clientDocPickerSearch').oninput = render;
    overlay.querySelector('#clientDocPickerApply').onclick = () => {
      if (typeof state.onApply === 'function') state.onApply(Array.from(state.selected.values()));
      close();
    };
  }

  window.ClientDocPicker = { open, close, formatBytes };
})();
