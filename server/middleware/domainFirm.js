'use strict';
const { pool } = require('../db');

// Simple in-memory cache — refresh every 60 seconds
const cache = new Map(); // domain -> { firm, cachedAt }
const CACHE_TTL = 60000;

async function domainFirmMiddleware(req, res, next) {
  const hostname = req.hostname; // e.g. my.yourfirm.com or the main app host

  // Skip the main app host and admin host (default)
  let appHost = '';
  try { appHost = new URL(process.env.APP_URL || '').hostname; } catch (_) {}
  if (!hostname || hostname === appHost || hostname === process.env.ADMIN_HOSTNAME || hostname === 'localhost' || hostname.includes('railway.app')) {
    req.customDomain = null;
    req.domainFirm = null;
    return next();
  }

  // Check cache
  const cached = cache.get(hostname);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) {
    req.customDomain = hostname;
    req.domainFirm = cached.firm;
    return next();
  }

  // Look up in DB
  try {
    const { rows } = await pool.query(
      `SELECT f.id, f.name, f.slug, fd.domain, fd.verified_at
       FROM firm_domains fd
       JOIN firms f ON f.id = fd.firm_id
       WHERE fd.domain = $1 AND fd.verified_at IS NOT NULL`,
      [hostname]
    );
    const firm = rows[0] || null;
    cache.set(hostname, { firm, cachedAt: Date.now() });
    req.customDomain = hostname;
    req.domainFirm = firm;
  } catch (err) {
    console.error('[domainFirmMiddleware] error:', err.message);
    req.customDomain = null;
    req.domainFirm = null;
  }

  next();
}

// Invalidate cache for a specific domain (call when domain is added/removed)
function invalidateDomainCache(domain) {
  cache.delete(domain);
}

module.exports = { domainFirmMiddleware, invalidateDomainCache };
