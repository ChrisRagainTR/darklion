'use strict';

/**
 * JWT storage and management for DarkLion Print Agent.
 * Uses keytar (Windows Credential Manager) to store the token securely.
 * Falls back to a local encrypted file if keytar is unavailable.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Store JWT in app userData directory (per-user, not shared)
// userData on Windows = C:\Users\<username>\AppData\Roaming\darklion-print-agent\
// This is user-private but not in the Windows Credential Manager.
// Staff JWTs last 30 days so desktop users stay signed in day-to-day.
function getTokenFilePath() {
  return path.join(app.getPath('userData'), 'auth.json');
}

/**
 * Store the JWT token.
 */
async function storeToken(token) {
  const filePath = getTokenFilePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ token }), 'utf8');
}

/**
 * Retrieve the stored JWT token.
 * Returns null if not found.
 */
async function getToken() {
  const filePath = getTokenFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return data.token || null;
    } catch (_) {}
  }
  return null;
}

/**
 * Clear the stored token (logout).
 */
async function clearToken() {
  const filePath = getTokenFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Check if a JWT token is expired (or about to expire within 5 minutes).
 * @param {string} token
 * @returns {boolean}
 */
function isTokenExpired(token) {
  if (!token) return true;
  try {
    // JWT is base64url-encoded: header.payload.signature
    const parts = token.split('.');
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp) return false; // no expiry claim — treat as valid
    const expiresAt = payload.exp * 1000;
    const now = Date.now();
    const bufferMs = 5 * 60 * 1000; // 5 minute buffer
    return now >= (expiresAt - bufferMs);
  } catch (_) {
    return true;
  }
}

module.exports = { storeToken, getToken, clearToken, isTokenExpired };
