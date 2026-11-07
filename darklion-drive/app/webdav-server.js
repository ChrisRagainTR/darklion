'use strict';

/**
 * webdav-server.js — Local WebDAV server on http://127.0.0.1:7890
 *
 * Built with Express. Exposes the DarkLion document tree as a WebDAV filesystem.
 * Auth: HTTP Basic, username=darklion, password=JWT token.
 *
 * Folder structure:
 *   /
 *     {Relationship Name}/
 *       {Person or Company Name}/
 *         {Year}/
 *           {folder_category}/
 *             {display_name}.pdf
 *
 * Cache: folder-level responses are cached per-token. The drive intentionally
 * lazy-loads each folder level so opening Drive does not fetch every client and
 * every document in the firm.
 */

const http = require('http');
const express = require('express');
const https = require('https');
const { URL } = require('url');

const PORT = 7891;

// ─── Cache ────────────────────────────────────────────────────────────────────
const DEFAULT_CACHE_TTL_MS = 2 * 60 * 1000;
const RELATIONSHIPS_CACHE_TTL_MS = 10 * 60 * 1000;
const ENTITIES_CACHE_TTL_MS = 5 * 60 * 1000;
const DOCUMENTS_CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map(); // key → { data, ts }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  const ttl = entry.ttl || DEFAULT_CACHE_TTL_MS;
  if (Date.now() - entry.ts > ttl) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, ttl) {
  cache.set(key, { data, ts: Date.now(), ttl: ttl || DEFAULT_CACHE_TTL_MS });
}

function cacheClear() {
  cache.clear();
}

// ─── API helpers (inline, no axios dependency) ────────────────────────────────

function apiGet(path, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://darklion.ai${path}`);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 401) {
          const e = new Error('Unauthorized'); e.status = 401; return reject(e);
        }
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Follow redirect to get S3 URL
function getDownloadRedirect(docId, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'darklion.ai',
      port: 443,
      path: `/api/documents/${docId}/download`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(options, (res) => {
      if (res.statusCode === 401) {
        const e = new Error('Unauthorized'); e.status = 401; return reject(e);
      }
      if (res.statusCode === 302 || res.statusCode === 301) {
        return resolve(res.headers.location);
      }
      res.resume();
      reject(new Error(`Expected redirect, got ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

// Stream from S3 signed URL to response
function streamFromUrl(signedUrl, res) {
  return new Promise((resolve, reject) => {
    const url = new URL(signedUrl);
    const transport = url.protocol === 'https:' ? https : http;
    transport.get(signedUrl, (s3res) => {
      if (s3res.statusCode !== 200) {
        res.status(502).end();
        return resolve();
      }
      if (s3res.headers['content-type']) res.setHeader('Content-Type', s3res.headers['content-type']);
      if (s3res.headers['content-length']) res.setHeader('Content-Length', s3res.headers['content-length']);
      s3res.pipe(res);
      s3res.on('end', resolve);
      s3res.on('error', reject);
    }).on('error', reject);
  });
}

// ─── Lazy folder loaders (cached) ─────────────────────────────────────────────

async function getRelationships(token) {
  const cacheKey = `relationships:${token.slice(-16)}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const raw = await apiGet('/api/relationships', token).catch(function() { return []; });
  const relationships = Array.isArray(raw) ? raw : [];
  const rows = relationships
    .map(function(rel) { return { id: rel.id, name: safeName(rel.name || '') }; })
    .filter(function(rel) { return rel.id && rel.name; });

  cacheSet(cacheKey, rows, RELATIONSHIPS_CACHE_TTL_MS);
  return rows;
}

async function getRelationshipByName(token, relName) {
  const relationships = await getRelationships(token);
  return relationships.find(function(rel) { return rel.name === relName; }) || null;
}

async function getEntitiesForRelationship(token, relName) {
  const relationship = await getRelationshipByName(token, relName);
  if (!relationship) return [];

  const cacheKey = `entities:${token.slice(-16)}:${relationship.id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const [peopleRaw, companiesRaw] = await Promise.all([
    apiGet('/api/relationships/' + relationship.id + '/people', token).catch(function() { return []; }),
    apiGet('/api/relationships/' + relationship.id + '/companies', token).catch(function() { return []; }),
  ]);

  const people = Array.isArray(peopleRaw) ? peopleRaw : [];
  const companies = Array.isArray(companiesRaw) ? companiesRaw : [];
  const entities = [];

  for (const p of people) {
    const name = safeName([p.first_name, p.last_name].filter(Boolean).join(' '));
    if (!name) continue;
    entities.push({ id: p.id, type: 'person', name });
  }

  for (const c of companies) {
    const name = safeName(c.company_name || c.name);
    if (!name) continue;
    entities.push({ id: c.id, type: 'company', name });
  }

  cacheSet(cacheKey, entities, ENTITIES_CACHE_TTL_MS);
  return entities;
}

async function getEntityByName(token, relName, entityName) {
  const entities = await getEntitiesForRelationship(token, relName);
  return entities.find(function(entity) { return entity.name === entityName; }) || null;
}

async function getDocsForEntity(token, entity) {
  if (!entity) return [];
  const cacheKey = `docs:${token.slice(-16)}:${entity.type}:${entity.id}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const docsRaw = await apiGet('/api/documents?owner_type=' + encodeURIComponent(entity.type) + '&owner_id=' + encodeURIComponent(entity.id), token).catch(function() { return []; });
  const docs = Array.isArray(docsRaw) ? docsRaw : (Array.isArray(docsRaw.documents) ? docsRaw.documents : []);

  cacheSet(cacheKey, docs, DOCUMENTS_CACHE_TTL_MS);
  return docs;
}

async function getGroupedDocsForEntity(token, entity) {
  const docs = await getDocsForEntity(token, entity);
  return groupDocs(docs, entity.type);
}

async function getDocByPath(token, relName, entityName, year, category, filename) {
  const entity = await getEntityByName(token, relName, entityName);
  if (!entity) return null;
  const docs = await getDocsForEntity(token, entity);
  return docs.find(function(doc) {
    return String(doc.year || 'Unknown') === String(year)
      && (doc.folder_category || 'other') === category
      && doc.display_name === filename
      && doc.folder_category !== 'message_docs';
  }) || null;
}

// Always show these years and categories — empty folders included so you can drag files in
const SCAFFOLD_YEARS = [];
(function() {
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= 2018; y--) SCAFFOLD_YEARS.push(String(y));
})();

const PERSON_CATS   = ['tax', 'other'];
const COMPANY_CATS  = ['tax', 'bookkeeping', 'private', 'other'];

function groupDocs(docs, entityType) {
  // Returns: Map<year, Map<category, doc[]>>
  // Always scaffolds all years + relevant categories so empty folders appear
  const cats = entityType === 'company' ? COMPANY_CATS : PERSON_CATS;
  const yearMap = new Map();

  // Pre-populate scaffold
  for (const yr of SCAFFOLD_YEARS) {
    const catMap = new Map();
    for (const cat of cats) catMap.set(cat, []);
    yearMap.set(yr, catMap);
  }

  // Populate with actual docs
  for (const doc of (docs || [])) {
    const year = String(doc.year || 'Unknown');
    const cat = doc.folder_category || 'other';
    if (cat === 'message_docs') continue; // hide internal docs
    if (!yearMap.has(year)) {
      const catMap = new Map();
      for (const c of cats) catMap.set(c, []);
      yearMap.set(year, catMap);
    }
    const catMap = yearMap.get(year);
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat).push(doc);
  }

  return yearMap;
}

// ─── XML helpers ──────────────────────────────────────────────────────────────

function xmlEscape(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function propfindResponse(href, isDir, size, lastModified) {
  const mod = lastModified ? new Date(lastModified).toUTCString() : new Date().toUTCString();
  const displayName = href.split('/').filter(Boolean).pop() || 'DarkLion Drive';
  return `
  <D:response>
    <D:href>${xmlEscape(href)}</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>${xmlEscape(decodeURIComponent(displayName))}</D:displayname>
        <D:resourcetype>${isDir ? '<D:collection/>' : ''}</D:resourcetype>
        <D:getcontenttype>${isDir ? 'httpd/unix-directory' : 'application/octet-stream'}</D:getcontenttype>
        ${!isDir ? `<D:getcontentlength>${size || 0}</D:getcontentlength>` : ''}
        <D:getlastmodified>${mod}</D:getlastmodified>
        <D:creationdate>${mod}</D:creationdate>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}

function buildMultistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
${responses.join('\n')}
</D:multistatus>`;
}

function safeName(s) {
  // Replace characters that break filesystem paths
  return (s || '').replace(/\//g, '-').replace(/\\/g, '-').replace(/:/g, '-').replace(/\*/g, '-').replace(/\?/g, '-').replace(/"/g, "'").replace(/</g, '(').replace(/>/g, ')').replace(/\|/g, '-');
}

function encPart(s) {
  return encodeURIComponent(safeName(s)).replace(/%20/g, '%20');
}

// ─── Path parsing ──────────────────────────────────────────────────────────────

function parsePath(reqPath) {
  const clean = decodeURIComponent(reqPath).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!clean) return { level: 'root', parts: [] };
  const parts = clean.split('/');
  const levels = ['root', 'relationship', 'entity', 'year', 'category', 'file'];
  return { level: levels[Math.min(parts.length, 5)], parts };
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;

  // Bearer token auth (used by rclone bearer_token config)
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    return token || null;
  }

  // Basic auth: username=darklion, password=JWT token
  if (authHeader.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx < 0) return null;
      return decoded.slice(colonIdx + 1).trim() || null;
    } catch (e) {
      return null;
    }
  }

  return null;
}

// ─── Express app ──────────────────────────────────────────────────────────────

function createApp(onUnauthorized) {
  const app = express();

  // OPTIONS — capability discovery
  app.options('*', (req, res) => {
    res.setHeader('DAV', '1, 2');
    res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, LOCK, UNLOCK, PROPPATCH');
    res.setHeader('MS-Author-Via', 'DAV');
    res.status(200).end();
  });

  // Auth + dispatch for all other methods
  app.all('*', async (req, res) => {
    const token = extractToken(req);
    if (!token) {
      res.setHeader('WWW-Authenticate', 'Basic realm="DarkLion Drive"');
      return res.status(401).send('Authentication required');
    }

    const method = req.method.toUpperCase();

    try {
      switch (method) {
        case 'PROPFIND':
          return await handlePropfind(req, res, token);
        case 'GET':
        case 'HEAD':
          return await handleGet(req, res, token, method === 'HEAD');
        case 'PUT':
          return await handlePut(req, res, token);
        case 'DELETE':
          return res.status(403).end(); // Read-only for safety
        case 'MKCOL':
          // Only allow MKCOL at category level (Explorer sometimes creates temp dirs on upload)
          // Block everything else so Explorer shows "no permission" at wrong levels
          var mcolParsed = parsePath(req.path);
          if (mcolParsed.level === 'category') return res.status(201).end();
          return res.status(403).end();
        case 'LOCK':
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return res.status(200).end(`<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
  <D:lockdiscovery>
    <D:activelock>
      <D:locktype><D:write/></D:locktype>
      <D:lockscope><D:exclusive/></D:lockscope>
      <D:depth>0</D:depth>
      <D:timeout>Second-3600</D:timeout>
      <D:locktoken><D:href>opaquelocktoken:darklion-drive</D:href></D:locktoken>
    </D:activelock>
  </D:lockdiscovery>
</D:prop>`);
        case 'UNLOCK':
          return res.status(204).end();
        case 'PROPPATCH':
          res.setHeader('Content-Type', 'application/xml; charset=utf-8');
          return res.status(207).end(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`);
        case 'MOVE':
        case 'COPY':
          return res.status(501).end();
        default:
          return res.status(405).end();
      }
    } catch (err) {
      if (err.status === 401) {
        console.log('[WebDAV] Token expired — triggering re-login');
        if (onUnauthorized) onUnauthorized();
        res.setHeader('WWW-Authenticate', 'Basic realm="DarkLion Drive"');
        return res.status(401).send('Token expired');
      }
      console.error('[WebDAV] Error:', err.message);
      res.status(500).end();
    }
  });

  return app;
}

// ─── PROPFIND ─────────────────────────────────────────────────────────────────

async function handlePropfind(req, res, token) {
  const depth = req.headers['depth'] || '1';
  const { level, parts } = parsePath(req.path);
  console.log('[WebDAV] PROPFIND path:', JSON.stringify(req.path), 'level:', level, 'parts:', JSON.stringify(parts), 'depth:', depth);
  const responses = [];

  if (level === 'root') {
    responses.push(propfindResponse('/', true, 0, null));
    if (depth !== '0') {
      const relationships = await getRelationships(token);
      for (const rel of relationships) {
        responses.push(propfindResponse('/' + encPart(rel.name) + '/', true, 0, null));
      }
    }

  } else if (level === 'relationship') {
    const [relName] = parts;
    responses.push(propfindResponse('/' + encPart(relName) + '/', true, 0, null));
    if (depth !== '0') {
      const entities = await getEntitiesForRelationship(token, relName);
      for (const entity of entities) {
        responses.push(propfindResponse(`/${encPart(relName)}/${encPart(entity.name)}/`, true, 0, null));
      }
    }

  } else if (level === 'entity') {
    const [relName, entityName] = parts;
    responses.push(propfindResponse(`/${encPart(relName)}/${encPart(entityName)}/`, true, 0, null));
    if (depth !== '0') {
      const entity = await getEntityByName(token, relName, entityName);
      if (entity) {
        const groupedDocs = await getGroupedDocsForEntity(token, entity);
        for (const [year] of groupedDocs) {
          responses.push(propfindResponse(`/${encPart(relName)}/${encPart(entityName)}/${encPart(year)}/`, true, 0, null));
        }
      }
    }

  } else if (level === 'year') {
    const [relName, entityName, year] = parts;
    responses.push(propfindResponse(`/${encPart(relName)}/${encPart(entityName)}/${encPart(year)}/`, true, 0, null));
    if (depth !== '0') {
      const entity = await getEntityByName(token, relName, entityName);
      if (entity) {
        const groupedDocs = await getGroupedDocsForEntity(token, entity);
        const catMap = groupedDocs.get(year);
        if (catMap) {
          for (const [cat] of catMap) {
            responses.push(propfindResponse(`/${encPart(relName)}/${encPart(entityName)}/${encPart(year)}/${encPart(cat)}/`, true, 0, null));
          }
        }
      }
    }

  } else if (level === 'category') {
    const [relName, entityName, year, category] = parts;
    responses.push(propfindResponse(`/${encPart(relName)}/${encPart(entityName)}/${encPart(year)}/${encPart(category)}/`, true, 0, null));
    if (depth !== '0') {
      const entity = await getEntityByName(token, relName, entityName);
      if (entity) {
        const groupedDocs = await getGroupedDocsForEntity(token, entity);
        const catMap = groupedDocs.get(year);
        if (catMap) {
          const docs = catMap.get(category) || [];
          for (const doc of docs) {
            const href = `/${encPart(relName)}/${encPart(entityName)}/${encPart(year)}/${encPart(category)}/${encPart(doc.display_name)}`;
            responses.push(propfindResponse(href, false, doc.size_bytes || 0, doc.created_at));
          }
        }
      }
    }

  } else if (level === 'file') {
    const [relName, entityName, year, category, filename] = parts;
    const doc = await getDocByPath(token, relName, entityName, year, category, filename);
    if (!doc) return res.status(404).end();
    const href = `/${encPart(relName)}/${encPart(entityName)}/${encPart(year)}/${encPart(category)}/${encPart(filename)}`;
    responses.push(propfindResponse(href, false, doc.size_bytes || 0, doc.created_at));
  }

  res.status(207)
    .setHeader('Content-Type', 'application/xml; charset=utf-8')
    .end(buildMultistatus(responses));
}

// ─── GET ──────────────────────────────────────────────────────────────────────

async function handleGet(req, res, token, headOnly) {
  const { level, parts } = parsePath(req.path);

  if (level !== 'file') {
    return res.status(200).setHeader('Content-Type', 'text/html').end('<html><body><h2>DarkLion Drive</h2></body></html>');
  }

  const [relName, entityName, year, category, filename] = parts;

  const doc = await getDocByPath(token, relName, entityName, year, category, filename);
  if (!doc) return res.status(404).end();

  const signedUrl = await getDownloadRedirect(doc.id, token);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.display_name)}"`);
  if (doc.mime_type) res.setHeader('Content-Type', doc.mime_type);
  if (doc.size_bytes) res.setHeader('Content-Length', doc.size_bytes);

  if (headOnly) return res.status(200).end();

  await streamFromUrl(signedUrl, res);
}

// ─── PUT ──────────────────────────────────────────────────────────────────────

async function handlePut(req, res, token) {
  const { level, parts } = parsePath(req.path);
  // Only accept files at the correct depth: relationship/entity/year/category/filename
  // Return 403 (not 409) so Explorer shows "no permission" and blocks the drag
  if (level !== 'file') return res.status(403).end();

  const [relName, entityName, year, category, filename] = parts;

  const entity = await getEntityByName(token, relName, entityName);
  if (!entity) return res.status(409).end();

  // Collect body
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buffer = Buffer.concat(chunks);
  const mimeType = req.headers['content-type'] || 'application/octet-stream';

  // Build multipart form upload
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType });
  form.append('owner_type', entity.type);
  form.append('owner_id', String(entity.id));
  form.append('year', String(year));
  form.append('folder_section', 'firm_uploaded'); // always upload as advisor docs so they show in the web app
  form.append('folder_category', category);
  form.append('display_name', filename);

  await new Promise((resolve, reject) => {
    const options = {
      hostname: 'darklion.ai',
      port: 443,
      path: '/api/documents/upload',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
    };
    const req2 = https.request(options, (r) => {
      r.resume();
      if (r.statusCode === 401) {
        const e = new Error('Unauthorized'); e.status = 401; return reject(e);
      }
      resolve(r.statusCode);
    });
    req2.on('error', reject);
    form.pipe(req2);
  });

  // Invalidate cache
  cacheClear();

  res.status(201).end();
}

// ─── Server lifecycle ─────────────────────────────────────────────────────────

let _server = null;

function startServer(onUnauthorized) {
  return new Promise((resolve, reject) => {
    if (_server) {
      console.log('[WebDAV] Server already running');
      return resolve();
    }

    const app = createApp(onUnauthorized);
    _server = http.createServer(app);

    _server.listen(PORT, '127.0.0.1', () => {
      console.log(`[WebDAV] Server listening on http://127.0.0.1:${PORT}`);
      resolve();
    });

    _server.on('error', (err) => {
      console.error('[WebDAV] Server error:', err.message);
      reject(err);
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!_server) return resolve();
    _server.close(() => {
      _server = null;
      console.log('[WebDAV] Server stopped');
      resolve();
    });
  });
}

module.exports = { startServer, stopServer, cacheClear, PORT };
