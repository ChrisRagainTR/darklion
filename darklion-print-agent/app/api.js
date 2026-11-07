'use strict';

/**
 * DarkLion API client for the Print Agent.
 * Handles search and document upload.
 */

const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.DARKLION_API_BASE || 'https://darklion.ai';

/**
 * Login to DarkLion and return a JWT token.
 * @param {string} email
 * @param {string} password
 * @returns {{ token: string, firm: object }}
 */
async function login(email, password) {
  const res = await fetch(`${API_BASE}/firms/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Login failed (${res.status})`);
  }

  return res.json();
}

/**
 * Search for clients (people, companies, relationships).
 * @param {string} query
 * @param {string} token JWT
 * @returns {{ people: [], companies: [], relationships: [] }}
 */
async function search(query, token) {
  const url = `${API_BASE}/api/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const expired = res.status === 401;
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Search failed (${res.status})`);
    err.expired = expired && (body.expired === true);
    throw err;
  }

  return res.json();
}

/**
 * Upload a PDF to a client's document folder.
 * @param {object} options
 * @param {string} options.filePath   - Local path to the PDF file
 * @param {string} options.token      - JWT token
 * @param {string} options.ownerType  - 'person' | 'company' | 'relationship'
 * @param {number} options.ownerId    - ID of the owner record
 * @param {string} options.year       - e.g. '2025'
 * @param {string} options.folderSection  - 'firm_uploaded' | 'client_uploaded'
 * @param {string} options.folderCategory - 'tax' | 'other'
 * @param {string} options.displayName    - Human-readable filename shown in DarkLion
 */
async function uploadDocument({
  filePath,
  token,
  ownerType,
  ownerId,
  year,
  folderSection = 'firm_uploaded',
  folderCategory = 'tax',
  displayName,
}) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileName = displayName || path.basename(filePath);

  const form = new FormData();
  form.append('file', fileBuffer, {
    filename: fileName.endsWith('.pdf') ? fileName : `${fileName}.pdf`,
    contentType: 'application/pdf',
  });
  form.append('owner_type', ownerType);
  form.append('owner_id', String(ownerId));
  form.append('year', year || '');
  form.append('folder_section', folderSection);
  form.append('folder_category', folderCategory);
  form.append('display_name', fileName);
  form.append('doc_type', folderCategory); // mirrors folder_category

  const res = await fetch(`${API_BASE}/api/documents/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  if (!res.ok) {
    const expired = res.status === 401;
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Upload failed (${res.status})`);
    err.expired = expired && (body.expired === true);
    throw err;
  }

  return res.json();
}

module.exports = { login, search, uploadDocument };
