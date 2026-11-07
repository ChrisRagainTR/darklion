"use strict";
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const { context } = require("../services/supportReadOnly");
// Explicitly reviewed read endpoints. Unknown endpoints fail closed, even GETs.
// Adding a route requires reviewing provider calls and side effects as well as SQL.
const reads = [
  /^\/firms\/(me|features|branding|staff|team|tax-season)$/,
  /^\/api\/firm-settings$/,
  /^\/api\/(search|staff|companies|companies\/\d+)$/,
  /^\/api\/relationships(?:\/(all-companies|all-people|\d+(?:\/(team|snapshot|companies|people))?))?$/,
  /^\/api\/people(?:\/\d+)?$/,
  /^\/api\/documents(?:\/(folders|mobile-index|\d+(?:\/(url|open|download))?))?$/,
  /^\/api\/messages(?:\/(all|unread-count|staff-list|sms-exceptions|document-picker|\d+|person\/\d+|company\/\d+|attachments\/\d+\/(download|preview)))?$/,
  /^\/api\/dashboard\/intel$/,
  /^\/api\/document-notifications(?:\/routes)?$/,
  /^\/api\/today$/,
  /^\/api\/my-work(?:\/count)?$/,
  /^\/firms\/team\/\d+\/avatar$/,
  /^\/api\/team-chat\/(status|unread-count|users|conversations|chats|messages|conversations\/\d+\/messages|attachments\/\d+\/(download|preview))$/,
  /^\/api\/pipelines\/(templates(?:\/\d+(?:\/stages)?)?|instances(?:\/\d+(?:\/jobs)?)?|jobs(?:\/\d+\/(history|updates))?|completions|entity-jobs)$/,
  /^\/api\/proposals(?:\/(stats|\d+))?$/,
  /^\/api\/templates$/,
  /^\/api\/summaries(?:\/\d{4}-\d{2}-\d{2})?$/,
];
function readAllowed(req) {
  const path = req.path.replace(/\/$/, "");
  if (req.method === "POST" && path === "/api/search/validate-recents")
    return true;
  return (
    ["GET", "HEAD"].includes(req.method) && reads.some((re) => re.test(path))
  );
}
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object" || value instanceof Date)
    return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    // Credential-shaped keys only: `token`, `access_token`, `inviteToken`, `token_hash`…
    // Status fields such as `token_status` or `token_expires_at` stay visible.
    if (
      /(password|secret|recovery_hash|api_key|encrypted|invite_url|invite_link|tokens?$|token_hash)/i.test(
        key,
      )
    )
      continue;
    result[key] = sanitize(item);
  }
  return result;
}
async function supportSession(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  if (jwt.decode(token)?.type !== "support") return next();
  res.set("Cache-Control", "no-store");
  const admin = require("../services/platformAdmin");
  try {
    req.firm = await admin.authenticateSupport(token);
  } catch (_) {
    return res.status(401).json({
      code: "SUPPORT_EXPIRED",
      error: "Support session expired or revoked. Return to admin.",
    });
  }
  const session = req.firm.supportSession;
  const exit = req.method === "DELETE" && req.path === "/api/support-session";
  const allowed = exit || readAllowed(req);
  try {
    // Audit every request before it runs. No record, no access.
    await pool.query(
      "INSERT INTO support_session_events(support_session_id,method,path,allowed) VALUES($1,$2,$3,$4)",
      [session.id, req.method, req.originalUrl.slice(0, 1000), allowed],
    );
    if (exit) {
      await admin.endSupport(session.id, session.adminUserId);
      return res.json({ ended: true });
    }
  } catch (_) {
    return res.status(503).json({
      code: "SUPPORT_AUDIT_UNAVAILABLE",
      error: "Support access could not be recorded. Please retry.",
    });
  }
  if (!allowed)
    return res.status(403).json({
      code: "SUPPORT_READ_ONLY",
      error: "This action is unavailable in read-only support view.",
    });
  const json = res.json.bind(res);
  res.json = (body) => json(sanitize(body));
  return context.run(true, next);
}
module.exports = { supportSession, readAllowed, sanitize };
