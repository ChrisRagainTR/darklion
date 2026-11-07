'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let currentFilePath = null;
let selectedClient = null; // { id, type, name }
let searchTimer = null;

// ── Init ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  populateYearDropdown();

  // Listen for the job-ready event from main process
  window.electronAPI.onJobReady(({ filePath, jobName }) => {
    currentFilePath = filePath;
    document.getElementById('docName').value = jobName || 'Document';
    document.getElementById('jobLabel').textContent = `From: ${jobName || 'Unknown Job'}`;
  });

  // Close results when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) {
      hideResults();
    }
  });
});

// ── Year dropdown ─────────────────────────────────────────────────────────────
function populateYearDropdown() {
  const sel = document.getElementById('year');
  const currentYear = new Date().getFullYear();
  // Show current year and 4 prior years
  for (let y = currentYear; y >= currentYear - 4; y--) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    sel.appendChild(opt);
  }
}

// ── Client search ─────────────────────────────────────────────────────────────
function onSearchInput() {
  const q = document.getElementById('clientSearch').value.trim();
  if (searchTimer) clearTimeout(searchTimer);
  if (q.length < 2) {
    hideResults();
    return;
  }
  // Debounce 250ms
  searchTimer = setTimeout(() => runSearch(q), 250);
}

async function runSearch(q) {
  try {
    const results = await window.electronAPI.search(q);
    renderResults(results);
  } catch (err) {
    if (err.expired) {
      setStatus('Session expired — please restart and sign in again.', 'error');
    } else {
      setStatus('Search failed: ' + err.message, 'error');
    }
  }
}

function renderResults(data) {
  const container = document.getElementById('clientResults');
  container.innerHTML = '';

  const items = [];

  // People
  (data.people || []).forEach(p => items.push({
    id: p.id,
    type: 'person',
    label: p.full_name || p.name || `Person #${p.id}`,
    sub: p.email || '',
  }));

  // Companies
  (data.companies || []).forEach(c => items.push({
    id: c.id,
    type: 'company',
    label: c.name || `Company #${c.id}`,
    sub: '',
  }));

  // Relationships
  (data.relationships || []).forEach(r => items.push({
    id: r.id,
    type: 'relationship',
    label: r.name || r.display_name || `Household #${r.id}`,
    sub: '',
  }));

  if (items.length === 0) {
    container.innerHTML = '<div class="result-item" style="color:#64748b;cursor:default;">No results found</div>';
    container.style.display = 'block';
    return;
  }

  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'result-item';
    div.innerHTML = `
      <span class="type-badge type-${item.type}">${item.type === 'relationship' ? 'household' : item.type}</span>
      <span>${escapeHtml(item.label)}</span>
      ${item.sub ? `<span style="color:#64748b;font-size:11px;margin-left:auto">${escapeHtml(item.sub)}</span>` : ''}
    `;
    div.addEventListener('click', () => selectClient(item));
    container.appendChild(div);
  });

  container.style.display = 'block';
}

function hideResults() {
  document.getElementById('clientResults').style.display = 'none';
}

function selectClient(item) {
  selectedClient = item;

  // Show chip, hide input
  document.getElementById('clientSearch').style.display = 'none';
  const chip = document.getElementById('selectedClient');
  chip.style.display = 'flex';
  document.getElementById('selectedName').textContent = item.label;

  hideResults();
  updateUploadButton();
}

function clearClient() {
  selectedClient = null;
  document.getElementById('clientSearch').style.display = 'block';
  document.getElementById('clientSearch').value = '';
  document.getElementById('clientSearch').focus();
  document.getElementById('selectedClient').style.display = 'none';
  updateUploadButton();
}

// ── Upload button state ───────────────────────────────────────────────────────
function updateUploadButton() {
  const btn = document.getElementById('uploadBtn');
  btn.disabled = !selectedClient || !currentFilePath;
}

// ── Upload ────────────────────────────────────────────────────────────────────
async function doUpload() {
  if (!selectedClient || !currentFilePath) return;

  const displayName = document.getElementById('docName').value.trim() || 'Document';
  const year = document.getElementById('year').value;
  const category = document.getElementById('category').value;
  const section = document.getElementById('section').value;

  // Show overlay
  document.getElementById('uploading').classList.add('show');
  document.getElementById('uploadBtn').disabled = true;
  setStatus('');

  try {
    await window.electronAPI.upload({
      filePath: currentFilePath,
      ownerType: selectedClient.type,
      ownerId: selectedClient.id,
      year,
      folderSection: section,
      folderCategory: category,
      displayName: displayName.endsWith('.pdf') ? displayName : displayName + '.pdf',
    });

    // Success — notify main to close window and clean up
    window.electronAPI.uploadComplete(currentFilePath);

  } catch (err) {
    document.getElementById('uploading').classList.remove('show');
    document.getElementById('uploadBtn').disabled = false;

    if (err.expired) {
      setStatus('Session expired. Please quit and sign in again.', 'error');
    } else {
      setStatus('Upload failed: ' + (err.message || 'Unknown error'), 'error');
    }
  }
}

// ── Cancel ────────────────────────────────────────────────────────────────────
function doCancel() {
  window.electronAPI.cancel(currentFilePath);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (type ? ` ${type}` : '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
