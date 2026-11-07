"use strict";
const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const { pool } = require("../db");
const security = require("../services/accountSecurity");
const { getFirmPreferences } = require("../services/firmPreferences");
const bcrypt = require("bcrypt");
const { auditLog } = require("../services/audit");
const router = Router();
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 40,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  }),
);
router.use((req, res, next) => {
  if (
    req.portal?.preview ||
    req.firm?.isApiToken ||
    (!req.portal && !req.firm?.userId)
  )
    return res.status(403).json({ error: "Personal sign-in required" });
  res.set("Cache-Control", "no-store");
  next();
});
// Messages the security service throws (without a status) for bad user input.
const USER_INPUT_ERRORS = new Set([
  "Invalid account",
  "Authenticator setup expired",
  "Invalid authenticator code",
]);
const route = (fn) => async (req, res) => {
  try {
    await fn(req, res, security.accountFromRequest(req));
  } catch (e) {
    const status = Number(e?.status);
    // Deliberate 4xx errors (401 wrong password, 409 already enabled, ...) are written for the user.
    if (status >= 400 && status < 500)
      return res.status(status).json({ error: e.message || "Account security request failed" });
    if (!e?.status && USER_INPUT_ERRORS.has(e?.message))
      return res.status(400).json({ error: e.message });
    console.error("[account-security] request failed:", e);
    if (status === 503)
      return res.status(503).json({ error: "Account security is unavailable" });
    res.status(500).json({ error: "Account security request failed" });
  }
};
router.get(
  "/",
  route(async (req, res, account) => {
    const record = await security.ensureAccount(account);
    const sessions = await pool.query(
      `SELECT id,device_label,created_at,expires_at FROM account_sessions WHERE ${security.columns} AND revoked_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC`,
      security.identity(account),
    );
    const prefs = await getFirmPreferences(account.firmId);
    res.json({
      mfaEnabled: record.mfa_enabled,
      mfaRequired: account.kind === "staff" && prefs.staffMfaRequired,
      recoveryCodesRemaining: record.recovery_hashes.length,
      currentSessionId: req.portal?.sessionId || req.firm?.sessionId || null,
      sessions: sessions.rows,
    });
  }),
);
router.post(
  "/mfa/setup",
  route(async (req, res, account) =>
    res.json(await security.beginMfa(account, req.body.password)),
  ),
);
router.post(
  "/mfa/enable",
  route(async (req, res, account) => {
    const result = await security.enableMfa(account, req.body.code);
    await pool.query(
      "INSERT INTO audit_log(firm_id,action,detail) VALUES($1,$2,$3)",
      [
        account.firmId,
        "mfa_enabled",
        JSON.stringify({ kind: account.kind, accountId: account.accountId }),
      ],
    );
    res.json(result);
  }),
);
router.post(
  "/mfa/disable",
  route(async (req, res, account) => {
    if (
      account.kind === "staff" &&
      (await getFirmPreferences(account.firmId)).staffMfaRequired
    )
      return res.status(403).json({ error: "Your firm requires MFA" });
    if (
      !(await security.verifyPassword(account, req.body.password)) ||
      !(await security.consumeMfa(account, req.body.code))
    )
      return res
        .status(401)
        .json({ error: "Current password and authenticator code required" });
    await pool.query(
      `UPDATE account_security SET mfa_enabled=FALSE,mfa_secret=NULL,recovery_hashes='[]',pending_secret=NULL,version=version+1 WHERE ${security.columns}`,
      security.identity(account),
    );
    await security.revokeAll(account);
    res.json({ signInAgain: true });
  }),
);
router.post(
  "/sessions/revoke-all",
  route(async (req, res, account) => {
    await security.revokeAll(account);
    res.json({ signInAgain: true });
  }),
);
function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 8)
    return "Password must be at least 8 characters";
  if (password.length > 200) return "Password is too long";
  if (!/[A-Z]/.test(password))
    return "Password must contain at least one uppercase letter";
  if (!/[0-9]/.test(password))
    return "Password must contain at least one number";
  return null;
}
// Change password while signed in. Every session ends, so the user signs in again.
router.post(
  "/password",
  route(async (req, res, account) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!(await security.verifyPassword(account, currentPassword)))
      throw Object.assign(new Error("Current password is incorrect"), {
        status: 400,
      });
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    const hash = await bcrypt.hash(newPassword, 12);
    const [firmId, kind, accountId, signerRole] = security.identity(account);
    if (kind === "staff")
      await pool.query(
        "UPDATE firm_users SET password_hash=$1 WHERE id=$2 AND firm_id=$3",
        [hash, accountId, firmId],
      );
    else
      await pool.query(
        `UPDATE people SET ${signerRole === "spouse" ? "spouse_" : ""}portal_password_hash=$1 WHERE id=$2 AND firm_id=$3`,
        [hash, accountId, firmId],
      );
    await auditLog(firmId, `${kind}_password_changed`, `Password changed (${kind} ${accountId})`, req.ip).catch(() => {});
    await security.revokeAll(account);
    res.json({ signInAgain: true });
  }),
);
// Clients keep their mailing address current themselves.
const ADDRESS_FIELDS = { address_line1: 200, address_line2: 200, city: 100, state: 50, zip: 20 };
router.get(
  "/profile",
  route(async (req, res) => {
    if (!req.portal) return res.status(404).json({ error: "Not found" });
    const row = (
      await pool.query(
        "SELECT address_line1,address_line2,city,state,zip FROM people WHERE id=$1 AND firm_id=$2",
        [req.portal.personId, req.portal.firmId],
      )
    ).rows[0];
    res.json({ email: req.portal.email || "", address: row || {} });
  }),
);
router.put(
  "/profile/address",
  route(async (req, res) => {
    if (!req.portal) return res.status(404).json({ error: "Not found" });
    const values = [];
    for (const [field, max] of Object.entries(ADDRESS_FIELDS)) {
      const value = String(req.body?.[field] ?? "").trim();
      if (value.length > max)
        return res.status(400).json({ error: "Address is too long" });
      values.push(value);
    }
    await pool.query(
      "UPDATE people SET address_line1=$1,address_line2=$2,city=$3,state=$4,zip=$5 WHERE id=$6 AND firm_id=$7",
      [...values, req.portal.personId, req.portal.firmId],
    );
    await auditLog(req.portal.firmId, "portal_address_updated", `Client updated mailing address (person ${req.portal.personId})`, req.ip).catch(() => {});
    res.json({ ok: true });
  }),
);
// Sign out: end this session on the server, not just in the browser.
router.post(
  "/sessions/current/revoke",
  route(async (req, res, account) => {
    const sessionId = req.portal ? req.portal.sessionId : req.firm?.sessionId;
    if (sessionId)
      await pool.query(
        `UPDATE account_sessions SET revoked_at=NOW() WHERE ${security.columns} AND id=$5`,
        [...security.identity(account), sessionId],
      );
    res.json({ ok: true });
  }),
);
router.delete(
  "/sessions/:id",
  route(async (req, res, account) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id))
      return res.status(400).json({ error: "Invalid session" });
    const result = await pool.query(
      `UPDATE account_sessions SET revoked_at=NOW() WHERE ${security.columns} AND id=$5`,
      [...security.identity(account), req.params.id],
    );
    res
      .status(result.rowCount ? 200 : 404)
      .json(result.rowCount ? { ok: true } : { error: "Session not found" });
  }),
);
router.get(
  "/data-requests",
  route(async (req, res, account) => {
    res.json(
      (
        await pool.query(
          `SELECT id,kind,status,note,created_at,updated_at FROM customer_data_requests WHERE firm_id=$1 AND account_kind=$2 AND account_id=$3 AND signer_role=$4 ORDER BY created_at DESC`,
          security.identity(account),
        )
      ).rows,
    );
  }),
);
router.post(
  "/data-requests",
  route(async (req, res, account) => {
    if (!["export", "deletion"].includes(req.body.kind))
      return res.status(400).json({ error: "Choose export or deletion" });
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO customer_data_requests(id,firm_id,account_kind,account_id,signer_role,kind,note) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        ...security.identity(account),
        req.body.kind,
        String(req.body.note || "").slice(0, 1000),
      ],
    );
    res
      .status(201)
      .json({
        id,
        status: "requested",
        message:
          "Your firm will review this request, including any records that must be retained.",
      });
  }),
);
module.exports = router;
