'use strict';

/**
 * api.js — DarkLion API client.
 * Wraps all calls to https://darklion.ai with Bearer token auth.
 * Throws { status: 401 } on auth failure so callers can re-login.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const FormData = require('form-data');

const BASE_URL = 'https://darklion.ai';

// Simple JSON request helper using Node's built-in https
function jsonRequest(method, url, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const transport = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          const err = new Error('Unauthorized');
          err.status = 401;
          return reject(err);
        }
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
      req.write(bodyStr);
    }
    req.end();
  });
}

/**
 * POST /firms/login → { token, firm }
 */
async function login(email, password) {
  const result = await jsonRequest('POST', `${BASE_URL}/firms/login`, {
    body: { email, password },
  });
  if (result.status !== 200 || !result.data.token) {
    const err = new Error(result.data.message || result.data.error || 'Login failed');
    err.status = result.status;
    throw err;
  }
  return result.data; // { token, firm }
}

/**
 * GET /api/relationships → array of relationships
 */
async function getRelationships(token) {
  const result = await jsonRequest('GET', `${BASE_URL}/api/relationships`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (result.status === 401) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return result.data || [];
}

/**
 * GET /api/people?relationship_id=X → array of people
 */
async function getPeople(token, relationshipId) {
  const result = await jsonRequest('GET', `${BASE_URL}/api/people?relationship_id=${relationshipId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (result.status === 401) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return result.data || [];
}

/**
 * GET /api/companies?relationship_id=X → array of companies
 */
async function getCompanies(token, relationshipId) {
  const result = await jsonRequest('GET', `${BASE_URL}/api/companies?relationship_id=${relationshipId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (result.status === 401) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return result.data || [];
}

/**
 * GET /api/documents?owner_type=X&owner_id=Y → array of documents
 */
async function getDocuments(token, ownerType, ownerId) {
  const result = await jsonRequest('GET', `${BASE_URL}/api/documents?owner_type=${ownerType}&owner_id=${ownerId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (result.status === 401) {
    const err = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return result.data || [];
}

/**
 * GET /api/documents/:id/download → follow redirect to S3 signed URL, return the URL
 * We resolve just the redirect URL so the WebDAV server can stream it.
 */
function getDownloadUrl(token, docId) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(`${BASE_URL}/api/documents/${docId}/download`);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 401) {
        const err = new Error('Unauthorized');
        err.status = 401;
        return reject(err);
      }
      if (res.statusCode === 302 || res.statusCode === 301) {
        return resolve(res.headers.location);
      }
      // If no redirect, consume and reject
      res.resume();
      reject(new Error(`Expected redirect from download endpoint, got ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Upload a file via POST /api/documents/upload (multipart).
 * Returns the created document record.
 */
async function uploadDocument(token, { fileBuffer, filename, mimeType, ownerType, ownerId, year, folderSection, folderCategory, displayName }) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', fileBuffer, { filename, contentType: mimeType || 'application/octet-stream' });
    form.append('owner_type', ownerType);
    form.append('owner_id', String(ownerId));
    form.append('year', String(year));
    form.append('folder_section', folderSection || folderCategory || '');
    form.append('folder_category', folderCategory);
    form.append('display_name', displayName);

    const parsed = new URL(`${BASE_URL}/api/documents/upload`);
    const options = {
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 401) {
          const err = new Error('Unauthorized');
          err.status = 401;
          return reject(err);
        }
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    form.pipe(req);
  });
}

module.exports = { login, getRelationships, getPeople, getCompanies, getDocuments, getDownloadUrl, uploadDocument };
