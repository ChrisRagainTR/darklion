'use strict';
// Web client portal session cookie (S3c).
// The browser portal keeps its sign-in in an HttpOnly cookie so page scripts can't read it.
// Bearer tokens keep working unchanged for the native iPhone app, the phone web app (/app),
// and pages opened with a token (old sessions being migrated, advisor preview links).

const COOKIE_NAME = 'portal_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Minimal Cookie header parser (no cookie-parser dependency).
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

// A real token from "Authorization: Bearer <jwt>". Pages that used to send
// "Bearer null", "Bearer undefined" or "Bearer " fall through to the cookie.
function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  if (!/^Bearer\s/i.test(header)) return null;
  const token = header.slice(7).trim();
  return JWT_SHAPE.test(token) ? token : null;
}

function cookieToken(req) {
  const token = parseCookies(req.headers?.cookie)[COOKIE_NAME];
  return token && JWT_SHAPE.test(token) ? token : null;
}

// Bearer wins when present (native app, migration, preview); otherwise the cookie.
function portalCredential(req) {
  const bearer = bearerToken(req);
  if (bearer) return { token: bearer, source: 'bearer' };
  const cookie = cookieToken(req);
  if (cookie) return { token: cookie, source: 'cookie' };
  return { token: null, source: null };
}

function hostOf(value) {
  if (!value || value === 'null') return null;
  try { return new URL(value).host.toLowerCase(); } catch { return null; }
}

// CSRF guard for cookie-authenticated writes: the request must come from a page on this
// same host. Origin is checked first; Referer is the fallback when Origin is absent or "null".
function sameOriginRequest(req) {
  // Host as the browser sees it; proxies may forward it, and default ports are dropped
  // the same way URL.host drops them from the Origin.
  const hosts = [req.headers?.host, String(req.headers?.['x-forwarded-host'] || '').split(',')[0]]
    .map(h => String(h || '').trim().toLowerCase().replace(/:(443|80)$/, ''))
    .filter(Boolean);
  if (!hosts.length) return false;
  const origin = hostOf(req.headers?.origin);
  if (origin) return hosts.includes(origin);
  const referer = hostOf(req.headers?.referer);
  return !!referer && hosts.includes(referer);
}

function isSafeMethod(method) {
  return SAFE_METHODS.has(String(method || 'GET').toUpperCase());
}

function cookieOptions(req, maxAgeMs) {
  const opts = { httpOnly: true, sameSite: 'strict', path: '/', secure: !!req.secure };
  if (maxAgeMs !== undefined) opts.maxAge = maxAgeMs;
  return opts;
}

// Remaining lifetime of a signed token, from its exp claim (seconds since epoch).
function remainingMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Math.max(0, Number(payload.exp) * 1000 - Date.now());
  } catch { return 0; }
}

function setSessionCookie(req, res, token) {
  const maxAge = remainingMs(token);
  if (!maxAge) return false;
  res.cookie(COOKIE_NAME, token, cookieOptions(req, maxAge));
  return true;
}

function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
}

// Sign-in responses set the cookie only when the web sign-in page asks for it
// (body.session === 'cookie') from this same site. The native app never asks, so its
// login responses are unchanged and no cookie lands in its HTTP cookie store.
function wantsWebSession(req) {
  return req.body?.session === 'cookie' && sameOriginRequest(req);
}

module.exports = {
  COOKIE_NAME,
  parseCookies,
  bearerToken,
  cookieToken,
  portalCredential,
  sameOriginRequest,
  isSafeMethod,
  setSessionCookie,
  clearSessionCookie,
  wantsWebSession,
  remainingMs,
};
