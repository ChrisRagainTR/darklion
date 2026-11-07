(function () {
  'use strict';

  // The phone web app (/app, which may also run inside an older native wrapper with Face ID
  // unlock) still signs in with a Bearer token kept in storage. The web portal moved to an
  // HttpOnly cookie and clears 'portalToken' when it migrates, so this app keeps its own key
  // (copied once from the old shared key, so nobody is signed out).
  const TOKEN_KEY = 'mobilePortalToken';
  const LEGACY_TOKEN_KEY = 'portalToken';
  try {
    if (!localStorage.getItem(TOKEN_KEY) && localStorage.getItem(LEGACY_TOKEN_KEY)) {
      localStorage.setItem(TOKEN_KEY, localStorage.getItem(LEGACY_TOKEN_KEY));
    }
  } catch (_) {}
  function clearStoredToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }

  const authScreen = document.getElementById('auth-screen');
  const mainScreen = document.getElementById('main-screen');
  const loginForm = document.getElementById('login-form');
  const loginEmail = document.getElementById('login-email');
  const loginPassword = document.getElementById('login-password');
  const loginSubmit = document.getElementById('login-submit');
  const loginError = document.getElementById('login-error');
  const signOutBtn = document.getElementById('sign-out-btn');
  const messagesLoading = document.getElementById('messages-loading');
  const contactList = document.getElementById('contact-list');
  const messagesListPanel = document.getElementById('messages-list-panel');
  const threadPanel = document.getElementById('thread-panel');
  const threadBackBtn = document.getElementById('thread-back-btn');
  const threadAvatar = document.getElementById('thread-avatar');
  const threadTitle = document.getElementById('thread-title');
  const threadSubtitle = document.getElementById('thread-subtitle');
  const threadMessages = document.getElementById('thread-messages');
  const messageForm = document.getElementById('message-form');
  const messageBody = document.getElementById('message-body');
  const messageFiles = document.getElementById('message-files');
  const attachBtn = document.getElementById('attach-btn');
  const messageSendBtn = document.getElementById('message-send-btn');
  const messageError = document.getElementById('message-error');
  const composerAttachments = document.getElementById('composer-attachments');
  const messagesRefreshBtn = document.getElementById('messages-refresh-btn');
  const reviewLoading = document.getElementById('review-loading');
  const reviewList = document.getElementById('review-list');
  const reviewListPanel = document.getElementById('review-list-panel');
  const reviewDetailPanel = document.getElementById('review-detail-panel');
  const reviewBackBtn = document.getElementById('review-back-btn');
  const reviewRefreshBtn = document.getElementById('review-refresh-btn');
  const reviewDetailTitle = document.getElementById('review-detail-title');
  const reviewDetailSubtitle = document.getElementById('review-detail-subtitle');
  const reviewDetailContent = document.getElementById('review-detail-content');
  const appToast = document.getElementById('app-toast');
  const changesModal = document.getElementById('changes-modal');
  const changesForm = document.getElementById('changes-form');
  const changesNote = document.getElementById('changes-note');
  const changesError = document.getElementById('changes-error');
  const changesCancelBtn = document.getElementById('changes-cancel-btn');
  const changesSubmitBtn = document.getElementById('changes-submit-btn');

  let dashboard = null;
  let contacts = [];
  let selectedContact = null;
  let selectedFiles = [];
  let messagesLoaded = false;
  let taxDeliveries = [];
  let currentTaxPacket = null;
  let reviewLoaded = false;

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function setError(message) {
    loginError.textContent = message || '';
  }

  function toast(message) {
    if (!appToast) return;
    appToast.textContent = message || '';
    appToast.classList.toggle('hidden', !message);
    clearTimeout(toast._timer);
    if (message) toast._timer = setTimeout(() => appToast.classList.add('hidden'), 2800);
  }

  function isTokenExpired() {
    try {
      const payload = JSON.parse(atob(token().split('.')[1] || ''));
      if (!payload.exp) return false;
      return payload.exp * 1000 <= Date.now() + 30000;
    } catch (_) {
      return true;
    }
  }

  function isNativeApp() {
    return Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }

  function biometricPlugin() {
    return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.BiometricAuthNative;
  }

  async function unlockWithBiometricsIfNeeded() {
    if (!isNativeApp() || sessionStorage.getItem('mobileBiometricUnlocked') === '1') return true;
    const plugin = biometricPlugin();
    if (!plugin || typeof plugin.authenticate !== 'function') return true;

    try {
      if (typeof plugin.checkBiometry === 'function') {
        const info = await plugin.checkBiometry();
        if (info && info.isAvailable === false) return true;
      }
      await plugin.authenticate({
        reason: 'Unlock your client app',
        cancelTitle: 'Cancel',
        allowDeviceCredential: true,
        iosFallbackTitle: 'Use passcode',
        androidTitle: 'Unlock app',
        androidSubtitle: 'Authenticate to continue',
        androidConfirmationRequired: false,
      });
      sessionStorage.setItem('mobileBiometricUnlocked', '1');
      return true;
    } catch (err) {
      clearStoredToken();
      sessionStorage.removeItem('mobileBiometricUnlocked');
      showAuth();
      setError('Unlock canceled. Please sign in again.');
      return false;
    }
  }

  function showAuth() {
    authScreen.classList.remove('hidden');
    mainScreen.classList.add('hidden');
    closeChangesModal();
    setError('');
    setTimeout(() => loginEmail.focus(), 50);
  }

  function showMain() {
    authScreen.classList.add('hidden');
    mainScreen.classList.remove('hidden');
  }

  async function api(path, options = {}) {
    if (!token() || isTokenExpired()) {
      clearStoredToken();
      showAuth();
      throw new Error('Your session expired. Please sign in again.');
    }
    const hasJsonBody = options.body && typeof options.body === 'string';
    const response = await fetch(path, {
      ...options,
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });

    if (response.status === 401) {
      clearStoredToken();
      showAuth();
      throw new Error('Your session expired. Please sign in again.');
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function decodeJwtName() {
    try {
      const payload = JSON.parse(atob(token().split('.')[1] || ''));
      return payload.name || '';
    } catch (_) {
      return '';
    }
  }

  function formatToday() {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase();
  }

  function taxTaskLabel(task) {
    if (!task) return 'Tax return';
    const year = task.taxYear || task.tax_year || '';
    const title = task.title || 'Tax return';
    return year ? `${year} ${title}` : title;
  }

  function deliveryTitle(delivery) {
    if (!delivery) return 'Tax return';
    const year = delivery.taxYear || delivery.tax_year || '';
    const title = delivery.title || 'Tax return';
    return year ? `${year} ${title}` : title;
  }

  function signerStatus(deliveryOrSigner) {
    if (!deliveryOrSigner) return { label: 'View only', className: '' };
    if (deliveryOrSigner.signedAt || deliveryOrSigner.signed_at) return { label: 'Signed', className: 'green' };
    if (deliveryOrSigner.needsChangesAt || deliveryOrSigner.needs_changes_at) return { label: 'Changes requested', className: 'red' };
    if (deliveryOrSigner.approvedAt || deliveryOrSigner.approved_at) return { label: 'Ready to sign', className: '' };
    return { label: 'Needs review', className: '' };
  }

  function renderDashboard() {
    const profile = dashboard.profile || {};
    const counts = dashboard.counts || {};
    const tasks = dashboard.tasks || {};
    const taxDeliveries = Array.isArray(tasks.taxDeliveries) ? tasks.taxDeliveries : [];
    const firstName = profile.firstName || decodeJwtName().split(' ')[0] || 'there';
    const taxActionCount = counts.taxDeliveriesRequiringAction || taxDeliveries.length || 0;
    const unreadMessages = counts.unreadMessages || 0;

    document.getElementById('today-label').textContent = formatToday();
    document.getElementById('welcome-title').textContent = `Hi, ${firstName}`;
    document.getElementById('unread-count').textContent = String(unreadMessages);
    document.getElementById('tax-action-count').textContent = String(taxActionCount);
    document.getElementById('tax-summary-label').textContent = `${taxActionCount} pending`;

    const heroTitle = document.getElementById('hero-title');
    const heroSubtitle = document.getElementById('hero-subtitle');
    const heroAction = document.getElementById('hero-action');

    if (taxActionCount > 0) {
      heroTitle.textContent = taxActionCount === 1 ? 'Your return needs review' : `${taxActionCount} returns need review`;
      heroSubtitle.textContent = 'Review your tax return packet and complete any required signature steps.';
      heroAction.hidden = false;
      heroAction.textContent = 'Review';
      heroAction.onclick = () => switchView('review');
    } else if (unreadMessages > 0) {
      heroTitle.textContent = unreadMessages === 1 ? 'You have a new message' : `You have ${unreadMessages} new messages`;
      heroSubtitle.textContent = 'Open secure messages to read the latest note from your advisor.';
      heroAction.hidden = false;
      heroAction.textContent = 'Open';
      heroAction.onclick = () => switchView('messages');
    } else {
      heroTitle.textContent = 'You’re all caught up';
      heroSubtitle.textContent = 'No tax return actions are waiting right now.';
      heroAction.hidden = true;
    }

    const taskList = document.getElementById('tax-task-list');
    if (taxDeliveries.length === 0) {
      taskList.innerHTML = '<p class="empty-copy">No tax returns need review or signature right now.</p>';
    } else {
      taskList.innerHTML = taxDeliveries.map(task => {
        const status = task.signedAt ? 'Signed' : task.approvedAt ? 'Ready to sign' : 'Needs review';
        return `<button type="button" class="task-row" data-nav="review" data-delivery-id="${escapeHtml(task.id)}">
          <strong>${escapeHtml(taxTaskLabel(task))}</strong>
          <span>${escapeHtml(status)} · updated ${escapeHtml(formatDate(task.updatedAt))}</span>
        </button>`;
      }).join('');
    }

    document.getElementById('home-loading').classList.add('hidden');
    document.getElementById('home-content').classList.remove('hidden');
  }

  function formatDate(value) {
    if (!value) return 'recently';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'recently';
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function avatarHtml(contact) {
    if (contact.avatar_url) return `<img src="${escapeHtml(contact.avatar_url)}" alt="">`;
    return escapeHtml(initials(contact.name || contact.email));
  }

  function formatMessageTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return new Intl.DateTimeFormat(undefined, sameDay ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric' }).format(date);
  }

  function messageDayLabel(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
  }

  function truncateText(value, max = 90) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1).trim()}…`;
  }

  async function loadContacts(force = false) {
    if (messagesLoaded && !force) return;
    messagesLoaded = true;
    messagesLoading.classList.remove('hidden');
    contactList.innerHTML = '';
    try {
      contacts = await api('/portal/messages');
      if (!Array.isArray(contacts)) contacts = [];
      renderContacts();
    } catch (err) {
      contactList.innerHTML = `<section class="empty-state"><h2>Could not load messages</h2><p>${escapeHtml(err.message)}</p></section>`;
    } finally {
      messagesLoading.classList.add('hidden');
    }
  }

  function renderContacts() {
    if (contacts.length === 0) {
      contactList.innerHTML = '<section class="empty-state"><div class="empty-icon">💬</div><h2>No conversations yet</h2><p>Your secure chats will appear here.</p></section>';
      return;
    }

    contactList.innerHTML = contacts.map(contact => {
      const unread = Number(contact.unreadCount || 0);
      const preview = truncateText(contact.lastPreview || contact.credentials || contact.email || 'Start a secure message', 92);
      const name = contact.name || contact.email || 'Your advisor team';
      return `<button type="button" class="contact-row imessage-contact ${unread > 0 ? 'has-unread' : ''}" data-contact-id="${escapeHtml(contact.id)}">
        <span class="avatar">${avatarHtml(contact)}</span>
        <span class="contact-main">
          <span class="contact-line">
            <span class="contact-name">${escapeHtml(name)}</span>
            <span class="contact-time">${escapeHtml(formatMessageTime(contact.lastMessageAt))}</span>
          </span>
          <span class="contact-preview-line">
            <span class="contact-preview">${escapeHtml(preview)}</span>
            <span class="chevron">›</span>
          </span>
        </span>
        ${unread > 0 ? `<span class="unread-pill">${unread}</span>` : ''}
      </button>`;
    }).join('');
  }

  async function openThread(contactId) {
    selectedContact = contacts.find(contact => String(contact.id) === String(contactId));
    if (!selectedContact) return;
    selectedFiles = [];
    renderSelectedFiles();
    messageError.textContent = '';
    messageBody.value = '';
    threadTitle.textContent = selectedContact.name || selectedContact.email || 'Messages';
    threadSubtitle.textContent = 'Secure chat';
    threadAvatar.innerHTML = avatarHtml(selectedContact);
    messagesListPanel.classList.add('hidden');
    threadPanel.classList.remove('hidden');
    await loadThread();
  }

  async function loadThread() {
    if (!selectedContact) return;
    threadMessages.innerHTML = '<div class="mini-loading"><div class="spinner"></div><span>Loading conversation…</span></div>';
    try {
      const contact = selectedContact;
      // markRead=0: messages are marked read below, only after the thread is drawn on a visible screen.
      const data = await api(`/portal/messages/thread/${encodeURIComponent(contact.id)}?markRead=0`);
      if (selectedContact !== contact) return;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      renderThread(messages);
      await markThreadRead(contact, messages);
    } catch (err) {
      threadMessages.innerHTML = `<section class="empty-state"><h2>Could not load conversation</h2><p>${escapeHtml(err.message)}</p></section>`;
    }
  }

  async function markThreadRead(contact, messages) {
    const unread = messages.filter(message => message.sender_type === 'staff' && !message.read_at);
    if (!unread.length || document.hidden || threadPanel.classList.contains('hidden') || selectedContact !== contact) return;
    const upToMessageId = Math.max(...unread.map(message => Number(message.id)));
    try {
      await api(`/portal/messages/thread/${encodeURIComponent(contact.id)}/read`, { method: 'POST', body: JSON.stringify({ upToMessageId }) });
      contact.unreadCount = 0;
      renderContacts();
      refreshDashboardCounts().catch(() => {});
    } catch (err) {
      // Stays unread; the next time the thread is opened it is marked again.
    }
  }

  // Escaped message text with plain http(s) addresses turned into links. Nothing else becomes HTML.
  function messageBodyHtml(value) {
    return escapeHtml(value).replace(/\bhttps?:\/\/(?:(?!&(?:lt|gt|quot|#0?39);)[^\s<])+/gi, match => {
      const trail = (match.match(/(?:[.,;:!?)\]]|&amp;)+$/) || [''])[0];
      const url = match.slice(0, match.length - trail.length);
      return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
    });
  }

  function renderThread(messages) {
    if (messages.length === 0) {
      threadMessages.innerHTML = '<section class="empty-state chat-empty"><div class="empty-icon">💬</div><h2>No messages yet</h2><p>Send a secure message to start the conversation.</p></section>';
      return;
    }

    let lastDay = '';
    threadMessages.innerHTML = messages.map(message => {
      const type = message.sender_type === 'client' ? 'client' : (message.sender_type || 'staff');
      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      const day = messageDayLabel(message.created_at);
      const dayHtml = day && day !== lastDay ? `<div class="message-day-divider"><span>${escapeHtml(day)}</span></div>` : '';
      if (day) lastDay = day;
      const senderLabel = type === 'client' ? 'You' : (message.sender_name || 'Your advisor');
      const attachmentHtml = attachments.length ? `<div class="attachment-list">${attachments.map(att => `<button type="button" class="attachment-link" data-attachment-id="${escapeHtml(att.documentId)}"><span>📎</span><strong>${escapeHtml(att.displayName || 'Attachment')}</strong></button>`).join('')}</div>` : '';
      const bodyHtml = message.body ? `<div class="bubble-body">${messageBodyHtml(message.body)}</div>` : '';
      return `${dayHtml}<div class="message-row ${escapeHtml(type)}">
        <div class="bubble ${escapeHtml(type)}">
          ${bodyHtml}
          ${attachmentHtml}
        </div>
        <div class="bubble-meta">${escapeHtml(senderLabel)} · ${escapeHtml(formatMessageTime(message.created_at))}</div>
      </div>`;
    }).join('');
    threadMessages.scrollTop = threadMessages.scrollHeight;
  }

  function closeThread() {
    threadPanel.classList.add('hidden');
    messagesListPanel.classList.remove('hidden');
    selectedContact = null;
    selectedFiles = [];
    renderSelectedFiles();
  }

  function renderSelectedFiles() {
    if (!selectedFiles.length) {
      composerAttachments.innerHTML = '';
      return;
    }
    composerAttachments.innerHTML = selectedFiles.map(file => `<span class="file-chip">${escapeHtml(file.name)}</span>`).join('');
  }

  async function openAttachment(documentId) {
    if (!documentId) return;
    try {
      const data = await api(`/portal/attachments/${encodeURIComponent(documentId)}/download`);
      if (data.url) window.open(data.url, '_blank', 'noopener');
    } catch (err) {
      messageError.textContent = err.message || 'Could not open attachment.';
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!selectedContact) return;
    if (!token() || isTokenExpired()) {
      clearStoredToken();
      showAuth();
      messageError.textContent = 'Your session expired. Please sign in again.';
      return;
    }
    const body = messageBody.value.trim();
    if (!body && selectedFiles.length === 0) {
      messageError.textContent = 'Write a message or attach a file first.';
      return;
    }

    messageError.textContent = '';
    messageSendBtn.disabled = true;
    messageSendBtn.textContent = 'Sending…';

    try {
      const form = new FormData();
      form.append('staff_user_id', selectedContact.id);
      form.append('body', body);
      selectedFiles.forEach(file => form.append('files', file));
      const response = await fetch('/portal/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token()}` },
        body: form,
      });
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        clearStoredToken();
        showAuth();
        throw new Error('Your session expired. Please sign in again.');
      }
      if (!response.ok) throw new Error(result.error || 'Failed to send message');
      messageBody.value = '';
      selectedFiles = [];
      messageFiles.value = '';
      renderSelectedFiles();
      await loadThread();
      await loadContacts(true);
    } catch (err) {
      messageError.textContent = err.message || 'Could not send message.';
    } finally {
      messageSendBtn.disabled = false;
      messageSendBtn.textContent = 'Send';
    }
  }

  async function refreshDashboardCounts() {
    dashboard = await api('/portal/mobile/dashboard');
    renderDashboard();
  }

  async function loadTaxDeliveries(force = false) {
    if (reviewLoaded && !force) return;
    reviewLoaded = true;
    closeTaxDetail(false);
    reviewLoading.classList.remove('hidden');
    reviewList.innerHTML = '';
    try {
      taxDeliveries = await api('/portal/tax-deliveries');
      if (!Array.isArray(taxDeliveries)) taxDeliveries = [];
      renderTaxDeliveryList();
    } catch (err) {
      reviewList.innerHTML = `<section class="empty-state"><h2>Could not load returns</h2><p>${escapeHtml(err.message)}</p></section>`;
    } finally {
      reviewLoading.classList.add('hidden');
    }
  }

  function renderTaxDeliveryList() {
    if (taxDeliveries.length === 0) {
      reviewList.innerHTML = '<section class="empty-state"><div class="empty-icon">✍️</div><h2>No returns waiting</h2><p>When a tax return is ready for review or signature, it will appear here.</p></section>';
      return;
    }

    reviewList.innerHTML = taxDeliveries.map(delivery => {
      const status = signerStatus(delivery);
      const entity = delivery.company_name || 'Personal return';
      return `<button type="button" class="review-card" data-review-id="${escapeHtml(delivery.id)}">
        <strong>${escapeHtml(deliveryTitle(delivery))}</strong>
        <p>${escapeHtml(entity)} · updated ${escapeHtml(formatDate(delivery.updated_at || delivery.updatedAt))}</p>
        <span class="status-chip ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
      </button>`;
    }).join('');
  }

  async function openTaxDelivery(deliveryId) {
    if (!deliveryId) return;
    reviewListPanel.classList.add('hidden');
    reviewDetailPanel.classList.remove('hidden');
    reviewDetailTitle.textContent = 'Loading return…';
    reviewDetailSubtitle.textContent = 'Secure review packet';
    reviewDetailContent.innerHTML = '<div class="mini-loading"><div class="spinner"></div><span>Loading packet…</span></div>';

    try {
      currentTaxPacket = await api(`/portal/mobile/tax-deliveries/${encodeURIComponent(deliveryId)}`);
      renderTaxPacket();
    } catch (err) {
      reviewDetailContent.innerHTML = `<section class="empty-state"><h2>Could not load return</h2><p>${escapeHtml(err.message)}</p></section>`;
    }
  }

  function closeTaxDetail(clearPacket = true) {
    reviewDetailPanel.classList.add('hidden');
    reviewListPanel.classList.remove('hidden');
    if (clearPacket) currentTaxPacket = null;
  }

  function formatMoneyish(value) {
    if (value === undefined || value === null || value === '') return '—';
    const num = Number(value);
    if (Number.isNaN(num)) return String(value);
    const label = num >= 0 ? 'Refund' : 'Due';
    return `${label}: $${Math.abs(num).toLocaleString()}`;
  }

  function renderTaxSummaryRows(summary) {
    const rows = [];
    if (summary && Object.keys(summary).length) {
      if (summary.federal_amount !== undefined) rows.push(['Federal', formatMoneyish(summary.federal_amount)]);
      if (summary.state_amount !== undefined) rows.push(['State', formatMoneyish(summary.state_amount)]);
      if (summary.due_date) rows.push(['Due date', summary.due_date]);
      if (summary.filing_status) rows.push(['Filing status', summary.filing_status]);
    }
    if (rows.length === 0) return '<p>No tax summary is available yet. Please review the return PDF carefully.</p>';
    return `<div class="summary-grid">${rows.map(([label, value]) => `<div class="summary-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}</div>`;
  }

  function renderTaxPacket() {
    if (!currentTaxPacket) return;
    const { delivery, currentSigner, signers, allowedActions, documents, consentLanguage } = currentTaxPacket;
    const status = signerStatus(currentSigner || delivery);
    const entity = delivery.companyName || 'Personal return';
    reviewDetailTitle.textContent = deliveryTitle(delivery);
    reviewDetailSubtitle.textContent = `${entity} · ${status.label}`;

    const signersHtml = Array.isArray(signers) && signers.length
      ? signers.map(s => {
        const sStatus = signerStatus(s);
        return `<div class="summary-row"><span>${escapeHtml(s.name || s.signerRole)}</span><strong>${escapeHtml(sStatus.label)}</strong></div>`;
      }).join('')
      : '<p>No signer details available.</p>';

    const reviewDoc = documents && documents.review;
    const signatureDoc = documents && documents.signature;
    const canApprove = allowedActions && allowedActions.canApprove;
    const canRequestChanges = allowedActions && allowedActions.canRequestChanges;
    const canSign = allowedActions && allowedActions.canSign;

    reviewDetailContent.innerHTML = `<div class="detail-stack">
      <section class="detail-card">
        <span class="status-chip ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>
        <h3 style="margin-top:0.85rem;">${escapeHtml(entity)}</h3>
        <p>${escapeHtml(delivery.introNote || 'Please review your tax return packet carefully before approving and signing.')}</p>
      </section>

      <section class="detail-card">
        <h3>Tax summary</h3>
        ${renderTaxSummaryRows(delivery.taxSummary || {})}
      </section>

      <section class="detail-card">
        <h3>Documents</h3>
        <div class="action-stack">
          ${reviewDoc ? `<button type="button" class="secondary-btn" data-open-doc="review">Open review copy</button>` : '<p>Review copy is not available.</p>'}
          ${signatureDoc ? `<button type="button" class="secondary-btn" data-open-doc="signature">Open signature document</button>` : ''}
        </div>
      </section>

      <section class="detail-card">
        <h3>Signer status</h3>
        <div class="summary-grid">${signersHtml}</div>
      </section>

      <section class="detail-card">
        <h3>Review decision</h3>
        <p class="consent-copy">Approve only after you have reviewed the return PDF. If anything looks wrong, request changes and add a note for the team.</p>
        <div class="action-stack" style="margin-top:0.8rem;">
          ${canApprove ? '<button type="button" class="primary-btn" data-tax-action="approve">I reviewed and approve</button>' : ''}
          ${canRequestChanges ? '<button type="button" class="danger-btn" data-tax-action="changes">Request changes</button>' : ''}
          ${!canApprove && !canRequestChanges ? '<p>No review action is currently available for this signer.</p>' : ''}
        </div>
      </section>

      <section class="detail-card">
        <h3>Signature</h3>
        <p class="consent-copy">${escapeHtml(consentLanguage || 'Your electronic signature has the same legal effect as a handwritten signature.')}</p>
        ${canSign ? `<form class="signature-box" id="tax-sign-form" style="margin-top:0.85rem;">
          <label><span>Type your full legal name</span><input id="tax-signature-name" autocomplete="name" required></label>
          <button type="submit" class="primary-btn">Sign return</button>
          <p class="form-error" id="tax-action-error" role="alert"></p>
        </form>` : `<p style="margin-top:0.8rem;">${currentSigner && currentSigner.signedAt ? 'This signer has already signed.' : 'Approve the return before signing.'}</p><p class="form-error" id="tax-action-error" role="alert"></p>`}
      </section>
    </div>`;
  }

  function taxActionError(message) {
    const el = document.getElementById('tax-action-error');
    if (el) el.textContent = message || '';
  }

  function setTaxActionBusy(isBusy) {
    reviewDetailContent.querySelectorAll('[data-tax-action], #tax-sign-form button[type="submit"], [data-open-doc]').forEach(button => {
      button.disabled = Boolean(isBusy);
    });
  }

  async function openTaxDocument(kind) {
    const doc = currentTaxPacket && currentTaxPacket.documents && currentTaxPacket.documents[kind];
    if (!doc) return;
    if (doc.signedUrl) {
      window.open(doc.signedUrl, '_blank', 'noopener');
      return;
    }
    if (doc.apiUrl) {
      const data = await api(doc.apiUrl);
      if (data.url) window.open(data.url, '_blank', 'noopener');
    }
  }

  async function postTaxAction(action, payload = {}) {
    if (!currentTaxPacket) return null;
    const endpoint = currentTaxPacket.actionEndpoints && currentTaxPacket.actionEndpoints[action];
    if (!endpoint) throw new Error('Action is not available.');
    return api(endpoint, {
      method: 'POST',
      body: Object.keys(payload).length ? JSON.stringify(payload) : undefined,
    });
  }

  async function approveTaxReturn() {
    if (!window.confirm('Approve this tax return as reviewed?')) return;
    taxActionError('');
    setTaxActionBusy(true);
    try {
      await postTaxAction('approve');
      await reloadCurrentTaxPacket();
      await refreshDashboardCounts();
      toast('Return approved. You can sign when ready.');
    } catch (err) {
      taxActionError(err.message || 'Could not approve return.');
    } finally {
      setTaxActionBusy(false);
    }
  }

  function openChangesModal() {
    changesError.textContent = '';
    changesNote.value = '';
    changesModal.classList.remove('hidden');
    setTimeout(() => changesNote.focus(), 50);
  }

  function closeChangesModal() {
    if (!changesModal) return;
    changesModal.classList.add('hidden');
    if (changesError) changesError.textContent = '';
  }

  async function requestTaxChanges(note) {
    if (!note || !note.trim()) return;
    taxActionError('');
    changesError.textContent = '';
    changesSubmitBtn.disabled = true;
    changesSubmitBtn.textContent = 'Sending…';
    try {
      await postTaxAction('requestChanges', { note: note.trim() });
      closeChangesModal();
      await reloadCurrentTaxPacket();
      await refreshDashboardCounts();
      toast('Change request sent to your advisor.');
    } catch (err) {
      changesError.textContent = err.message || 'Could not request changes.';
    } finally {
      changesSubmitBtn.disabled = false;
      changesSubmitBtn.textContent = 'Send request';
    }
  }

  async function signTaxReturn(event) {
    event.preventDefault();
    const input = document.getElementById('tax-signature-name');
    const signature = (input && input.value || '').trim();
    if (!signature) {
      taxActionError('Type your full legal name to sign.');
      return;
    }
    if (!window.confirm('Submit your electronic signature for this return?')) return;
    taxActionError('');
    setTaxActionBusy(true);
    try {
      await postTaxAction('sign', { signature_data: signature, signature_type: 'typed' });
      await reloadCurrentTaxPacket();
      await refreshDashboardCounts();
      toast('Signature received. Thank you.');
    } catch (err) {
      taxActionError(err.message || 'Could not submit signature.');
    } finally {
      setTaxActionBusy(false);
    }
  }

  async function reloadCurrentTaxPacket() {
    const id = currentTaxPacket && currentTaxPacket.delivery && currentTaxPacket.delivery.id;
    if (!id) return;
    currentTaxPacket = await api(`/portal/mobile/tax-deliveries/${encodeURIComponent(id)}`);
    reviewLoaded = false;
    renderTaxPacket();
  }

  async function loadDashboard() {
    const unlocked = await unlockWithBiometricsIfNeeded();
    if (!unlocked) return;
    showMain();
    document.getElementById('home-loading').classList.remove('hidden');
    document.getElementById('home-content').classList.add('hidden');
    dashboard = await api('/portal/mobile/dashboard');
    renderDashboard();
  }

  async function handleLogin(event) {
    event.preventDefault();
    setError('');
    loginSubmit.disabled = true;
    loginSubmit.textContent = 'Signing in…';

    try {
      const payload = {
        email: loginEmail.value.trim(),
        password: loginPassword.value,
      };
      const params = new URLSearchParams(window.location.search);
      const firmSlug = (params.get('firm') || params.get('slug') || '').trim();
      if (firmSlug) payload.firmSlug = firmSlug;

      const response = await fetch('/portal-auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Login failed');
      localStorage.setItem(TOKEN_KEY, body.token);
      sessionStorage.setItem('mobileBiometricUnlocked', '1');
      loginPassword.value = '';
      if (isNativeApp() && biometricPlugin()) toast('Face ID / Touch ID unlock enabled for this session.');
      await loadDashboard();
    } catch (err) {
      setError(err.message || 'Could not sign in. Please try again.');
    } finally {
      loginSubmit.disabled = false;
      loginSubmit.textContent = 'Sign in';
    }
  }

  function switchView(name) {
    const views = {
      home: document.getElementById('view-home'),
      messages: document.getElementById('view-messages'),
      review: document.getElementById('view-review'),
    };
    Object.entries(views).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
    document.querySelectorAll('.nav-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.nav === name));
    if (name === 'messages') loadContacts().catch(err => console.warn('[mobile-app] messages load failed:', err.message));
    if (name === 'review') loadTaxDeliveries().catch(err => console.warn('[mobile-app] tax delivery load failed:', err.message));
  }

  function signOut() {
    fetch('/portal/account-security/sessions/current/revoke', { method: 'POST', keepalive: true, headers: { 'Authorization': 'Bearer ' + token() } }).catch(() => {});
    clearStoredToken();
    sessionStorage.removeItem('mobileBiometricUnlocked');
    dashboard = null;
    contacts = [];
    selectedContact = null;
    selectedFiles = [];
    taxDeliveries = [];
    currentTaxPacket = null;
    messagesLoaded = false;
    reviewLoaded = false;
    closeThread();
    closeTaxDetail();
    showAuth();
  }

  document.addEventListener('click', event => {
    const deliveryTarget = event.target.closest('[data-delivery-id]');
    if (deliveryTarget) {
      switchView('review');
      openTaxDelivery(deliveryTarget.dataset.deliveryId);
      return;
    }
    const navTarget = event.target.closest('[data-nav]');
    if (!navTarget) return;
    const target = navTarget.dataset.nav;
    if (target) switchView(target);
  });

  loginForm.addEventListener('submit', handleLogin);
  signOutBtn.addEventListener('click', signOut);
  threadBackBtn.addEventListener('click', closeThread);
  messagesRefreshBtn.addEventListener('click', () => loadContacts(true));
  messageForm.addEventListener('submit', sendMessage);
  attachBtn.addEventListener('click', () => messageFiles.click());
  messageFiles.addEventListener('change', () => {
    selectedFiles = Array.from(messageFiles.files || []).slice(0, 8);
    renderSelectedFiles();
  });
  contactList.addEventListener('click', event => {
    const row = event.target.closest('.contact-row');
    if (row) openThread(row.dataset.contactId);
  });
  messageBody.addEventListener('input', () => {
    messageBody.style.height = 'auto';
    messageBody.style.height = Math.min(messageBody.scrollHeight, 120) + 'px';
  });
  threadMessages.addEventListener('click', event => {
    const attachment = event.target.closest('[data-attachment-id]');
    if (attachment) openAttachment(attachment.dataset.attachmentId);
  });
  reviewBackBtn.addEventListener('click', () => closeTaxDetail());
  reviewRefreshBtn.addEventListener('click', () => loadTaxDeliveries(true));
  reviewList.addEventListener('click', event => {
    const card = event.target.closest('[data-review-id]');
    if (card) openTaxDelivery(card.dataset.reviewId);
  });
  reviewDetailContent.addEventListener('click', event => {
    const docBtn = event.target.closest('[data-open-doc]');
    if (docBtn) {
      openTaxDocument(docBtn.dataset.openDoc).catch(err => taxActionError(err.message));
      return;
    }
    const actionBtn = event.target.closest('[data-tax-action]');
    if (!actionBtn) return;
    if (actionBtn.dataset.taxAction === 'approve') approveTaxReturn();
    if (actionBtn.dataset.taxAction === 'changes') openChangesModal();
  });
  reviewDetailContent.addEventListener('submit', event => {
    if (event.target && event.target.id === 'tax-sign-form') signTaxReturn(event);
  });
  changesCancelBtn.addEventListener('click', closeChangesModal);
  changesModal.addEventListener('click', event => {
    if (event.target === changesModal) closeChangesModal();
  });
  changesForm.addEventListener('submit', event => {
    event.preventDefault();
    requestTaxChanges(changesNote.value);
  });

  if (token()) {
    loadDashboard().catch(err => {
      console.warn('[mobile-app] dashboard load failed:', err.message);
      showAuth();
      setError(err.message);
    });
  } else {
    showAuth();
  }
})();
