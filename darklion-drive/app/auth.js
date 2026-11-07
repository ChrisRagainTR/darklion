'use strict';

/**
 * auth.js — Login, token storage, and session management.
 * Token stored at: app.getPath('userData')/auth.json
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let _authPath = null;

function getAuthPath() {
  if (!_authPath) {
    _authPath = path.join(app.getPath('userData'), 'auth.json');
  }
  return _authPath;
}

/**
 * Load stored auth from disk.
 * Returns { token, email, firmName } or null.
 */
function loadAuth() {
  try {
    const authPath = getAuthPath();
    if (!fs.existsSync(authPath)) return null;
    const data = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    if (!data.token) return null;
    return data;
  } catch (e) {
    return null;
  }
}

/**
 * Save auth to disk.
 */
function saveAuth(token, email, firmName) {
  try {
    const authPath = getAuthPath();
    fs.writeFileSync(authPath, JSON.stringify({ token, email, firmName, savedAt: Date.now() }, null, 2));
    return true;
  } catch (e) {
    console.error('[Auth] Failed to save auth:', e.message);
    return false;
  }
}

/**
 * Clear stored auth.
 */
function clearAuth() {
  try {
    const authPath = getAuthPath();
    if (fs.existsSync(authPath)) {
      fs.unlinkSync(authPath);
    }
  } catch (e) {
    console.error('[Auth] Failed to clear auth:', e.message);
  }
}

module.exports = { loadAuth, saveAuth, clearAuth };
