'use strict';

// login.js — renderer process for the login window.
// Communicates with main process via window.darkLion (contextBridge).

(async function () {
  const form = document.getElementById('loginForm');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const connectBtn = document.getElementById('connectBtn');
  const errorBox = document.getElementById('errorBox');
  const statusBox = document.getElementById('statusBox');
  const versionLabel = document.getElementById('versionLabel');

  // Load version
  try {
    const version = await window.darkLion.getVersion();
    versionLabel.textContent = `v${version}`;
  } catch (e) {
    // ignore
  }

  function setLoading(loading) {
    connectBtn.disabled = loading;
    if (loading) {
      connectBtn.innerHTML = '<span class="spinner"></span>Connecting...';
      statusBox.textContent = 'Authenticating with DarkLion...';
    } else {
      connectBtn.textContent = 'Connect Drive';
      statusBox.textContent = '';
    }
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.add('visible');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.remove('visible');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError('Please enter your email and password.');
      return;
    }

    setLoading(true);

    try {
      const result = await window.darkLion.login(email, password);
      if (result.success) {
        statusBox.innerHTML = '<span class="spinner"></span>Mounting drive L:...';
        // Window will be closed by main process after successful mount
      } else {
        setLoading(false);
        showError(result.error || 'Login failed. Please check your credentials.');
      }
    } catch (err) {
      setLoading(false);
      showError('Connection error. Please try again.');
      console.error('Login error:', err);
    }
  });

  // Focus email on load
  emailInput.focus();
})();
