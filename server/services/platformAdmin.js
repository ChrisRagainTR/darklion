"use strict";
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { pool } = require("../db");
const security = require("./accountSecurity");
const UNLOCK_HOURS = 8;
const MAX_CODE_ATTEMPTS = 5;
function fail(message, status = 403, code = "ADMIN_REQUIRED") {
  return Object.assign(Error(message), { status, code });
}
// Staff login + active platform grant. Only used to request/verify an emailed
// unlock code; every other admin endpoint requires the unlocked admin token.
async function requireStaffAdmin(token) {
  const actor =
    await require("../middleware/requireFirm").authenticateStaffToken(token);
  if (!actor.sessionId)
    throw fail("Sign in again to access administration", 401);
  const { rows } = await pool.query(
    `SELECT a.user_id,s.version FROM platform_admins a
    LEFT JOIN account_security s ON s.account_id=a.user_id AND s.kind='staff' AND s.firm_id=$2 AND s.signer_role='taxpayer'
    WHERE a.user_id=$1 AND a.revoked_at IS NULL`,
    [actor.userId, actor.id],
  );
  if (!rows[0]) throw fail("Platform administrator access required");
  return { ...actor, version: rows[0].version || 0 };
}
const codeHash = (id, code) =>
  crypto
    .createHmac("sha256", process.env.JWT_SECRET)
    .update(id + ":" + String(code || "").replace(/\D/g, ""))
    .digest("hex");
function maskEmail(email) {
  const [local, domain] = String(email).split("@");
  return local.slice(0, 2) + "•••@" + domain;
}
async function startUnlock(actor, send) {
  send ||= require("./email").sendEmail;
  const id = crypto.randomUUID(),
    code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  // A new code replaces any pending one for this login.
  await pool.query(
    "UPDATE platform_admin_unlocks SET revoked_at=NOW() WHERE admin_session_id=$1 AND verified_at IS NULL AND revoked_at IS NULL",
    [actor.sessionId],
  );
  await pool.query(
    `INSERT INTO platform_admin_unlocks(id,admin_user_id,admin_session_id,admin_version,code_hash,sent_to)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [id, actor.userId, actor.sessionId, actor.version, codeHash(id, code), actor.email],
  );
  const sent = await send({
    to: actor.email,
    subject: `${code} is your DarkLion admin code`,
    html: `<p>Your DarkLion admin center code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't try to open the admin center, change your password now.</p>`,
  });
  if (sent?.skipped) {
    await pool.query("UPDATE platform_admin_unlocks SET revoked_at=NOW() WHERE id=$1", [id]);
    throw fail("Email delivery is not configured on this server", 503, "EMAIL_UNAVAILABLE");
  }
  return { challengeId: id, sentTo: maskEmail(actor.email) };
}
async function verifyUnlock(actor, input) {
  const id = String(input.challengeId || "");
  if (!/^[a-f0-9-]{36}$/i.test(id))
    throw fail("Request a new code", 400, "INVALID_CODE");
  // Count the attempt first so parallel guesses cannot exceed the limit.
  const { rows } = await pool.query(
    `UPDATE platform_admin_unlocks SET attempts=attempts+1
    WHERE id=$1 AND admin_user_id=$2 AND admin_session_id=$3 AND verified_at IS NULL AND revoked_at IS NULL
      AND code_expires_at>NOW() AND attempts<$4
    RETURNING code_hash`,
    [id, actor.userId, actor.sessionId, MAX_CODE_ATTEMPTS],
  );
  if (!rows[0]) throw fail("Code expired. Request a new code.", 400, "CODE_EXPIRED");
  const expected = Buffer.from(rows[0].code_hash, "hex"),
    given = Buffer.from(codeHash(id, input.code), "hex");
  if (!crypto.timingSafeEqual(expected, given))
    throw fail("That code is not correct", 400, "INVALID_CODE");
  const verified = await pool.query(
    `UPDATE platform_admin_unlocks SET verified_at=NOW(),expires_at=NOW()+$2*INTERVAL '1 hour'
    WHERE id=$1 AND verified_at IS NULL AND revoked_at IS NULL RETURNING expires_at`,
    [id, UNLOCK_HOURS],
  );
  if (!verified.rowCount) throw fail("Code expired. Request a new code.", 400, "CODE_EXPIRED");
  const token = jwt.sign(
    { type: "platform_admin", unlockId: id },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: UNLOCK_HOURS + "h", audience: "darklion-admin" },
  );
  return { token, expiresAt: verified.rows[0].expires_at };
}
// Unlocked admin session. Rechecks the grant, the originating staff login,
// account version and the unlock itself on every request.
async function requireAdminIdentity(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ["HS256"],
    audience: "darklion-admin",
  });
  if (payload.type !== "platform_admin")
    throw fail("Unlock the admin center to continue", 401, "ADMIN_LOCKED");
  const { rows } = await pool.query(
    `SELECT ul.id AS unlock_id,ul.admin_session_id,ul.admin_version,fu.id AS user_id,fu.firm_id,fu.email,
    COALESCE(NULLIF(fu.display_name,''),NULLIF(fu.name,''),fu.email) AS name
    FROM platform_admin_unlocks ul
    JOIN platform_admins a ON a.user_id=ul.admin_user_id AND a.revoked_at IS NULL AND a.created_at<=ul.created_at
    JOIN firm_users fu ON fu.id=ul.admin_user_id AND fu.archived_at IS NULL AND fu.accepted_at IS NOT NULL
    JOIN account_sessions sess ON sess.id=ul.admin_session_id AND sess.account_id=fu.id AND sess.firm_id=fu.firm_id
      AND sess.kind='staff' AND sess.revoked_at IS NULL AND sess.expires_at>NOW()
    LEFT JOIN account_security sec ON sec.firm_id=fu.firm_id AND sec.account_id=fu.id AND sec.kind='staff' AND sec.signer_role='taxpayer'
    WHERE ul.id=$1 AND ul.verified_at IS NOT NULL AND ul.revoked_at IS NULL AND ul.expires_at>NOW()
      AND COALESCE(sec.version,0)=ul.admin_version`,
    [payload.unlockId],
  );
  const row = rows[0];
  if (!row) throw fail("Unlock the admin center to continue", 401, "ADMIN_LOCKED");
  return {
    id: row.firm_id,
    userId: row.user_id,
    sessionId: row.admin_session_id,
    unlockId: row.unlock_id,
    version: row.admin_version,
    email: row.email,
    name: row.name,
  };
}
async function startSupport(actor, input) {
  const firmId = Number(input.firmId),
    userId = Number(input.userId);
  const reason = String(input.reason || "").trim();
  if (
    !Number.isSafeInteger(firmId) ||
    !Number.isSafeInteger(userId) ||
    reason.length < 5 ||
    reason.length > 500
  )
    throw fail(
      "Select a staff member and enter a reason (5–500 characters)",
      400,
      "INVALID_INPUT",
    );
  const account = { firmId: actor.id, kind: "staff", accountId: actor.userId };
  if (!(await security.verifyPassword(account, input.password)))
    throw fail("Current password required", 403, "REAUTH_REQUIRED");
  const { rows } = await pool.query(
    `SELECT u.id,u.firm_id,u.role,u.email,COALESCE(NULLIF(u.display_name,''),u.name,u.email) AS name,
    f.name AS firm_name,COALESCE(s.version,0) AS version FROM firm_users u JOIN firms f ON f.id=u.firm_id
    LEFT JOIN account_security s ON s.firm_id=u.firm_id AND s.account_id=u.id AND s.kind='staff' AND s.signer_role='taxpayer'
    WHERE u.id=$1 AND u.firm_id=$2 AND u.archived_at IS NULL AND u.accepted_at IS NOT NULL AND u.role!='agent'`,
    [userId, firmId],
  );
  const target = rows[0];
  if (!target)
    throw fail("Active staff member not found in this firm", 404, "NOT_FOUND");
  // Recheck the grant/session after reauthentication, before issuing access.
  const stillActive = await pool.query(
    `SELECT 1 FROM platform_admins a JOIN account_sessions s ON s.id=$2
    JOIN platform_admin_unlocks ul ON ul.id=$3 AND ul.revoked_at IS NULL AND ul.expires_at>NOW()
    WHERE a.user_id=$1 AND a.revoked_at IS NULL AND s.account_id=a.user_id AND s.revoked_at IS NULL AND s.expires_at>NOW()`,
    [actor.userId, actor.sessionId, actor.unlockId],
  );
  if (!stillActive.rowCount)
    throw fail("Administrator session was revoked", 401);
  const id = crypto.randomUUID();
  // This insert is the access audit. Fail closed if it cannot be persisted.
  const { rows: sessions } = await pool.query(
    `INSERT INTO support_sessions
    (id,admin_user_id,admin_session_id,admin_version,firm_id,target_user_id,target_version,reason,admin_name,target_name,firm_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING expires_at`,
    [
      id,
      actor.userId,
      actor.sessionId,
      actor.version,
      firmId,
      userId,
      target.version,
      reason,
      actor.name,
      target.name,
      target.firm_name,
    ],
  );
  const token = jwt.sign(
    {
      type: "support",
      supportId: id,
      firmId,
      userId,
      role: target.role,
      name: target.name,
      email: target.email,
      firmName: target.firm_name,
    },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "30m", audience: "darklion-support" },
  );
  return {
    token,
    id,
    firmId,
    name: target.name,
    firmName: target.firm_name,
    expiresAt: sessions[0].expires_at,
  };
}
async function authenticateSupport(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET, {
    algorithms: ["HS256"],
    audience: "darklion-support",
  });
  if (payload.type !== "support") throw fail("Invalid support session", 401);
  const { rows } = await pool.query(
    `SELECT ss.*,u.role,u.email,COALESCE(NULLIF(u.display_name,''),u.name,u.email) AS name
    FROM support_sessions ss
    JOIN platform_admins a ON a.user_id=ss.admin_user_id AND a.revoked_at IS NULL AND a.created_at<=ss.created_at
    JOIN firm_users admin ON admin.id=a.user_id AND admin.archived_at IS NULL AND admin.accepted_at IS NOT NULL
    LEFT JOIN account_security sec ON sec.firm_id=admin.firm_id AND sec.account_id=admin.id AND sec.kind='staff'
      AND sec.signer_role='taxpayer'
    JOIN account_sessions sess ON sess.id=ss.admin_session_id AND sess.account_id=admin.id AND sess.firm_id=admin.firm_id
      AND sess.kind='staff' AND sess.revoked_at IS NULL AND sess.expires_at>NOW()
    JOIN firm_users u ON u.id=ss.target_user_id AND u.firm_id=ss.firm_id AND u.archived_at IS NULL AND u.accepted_at IS NOT NULL AND u.role!='agent'
    LEFT JOIN account_security target ON target.account_id=u.id AND target.firm_id=u.firm_id AND target.kind='staff' AND target.signer_role='taxpayer'
    WHERE COALESCE(sec.version,0)=ss.admin_version AND ss.id=$1 AND ss.ended_at IS NULL AND ss.expires_at>NOW() AND COALESCE(target.version,0)=ss.target_version`,
    [payload.supportId],
  );
  const row = rows[0];
  if (
    !row ||
    row.firm_id !== payload.firmId ||
    row.target_user_id !== payload.userId
  )
    throw fail("Support session expired or revoked", 401, "SUPPORT_EXPIRED");
  return {
    id: row.firm_id,
    userId: row.target_user_id,
    role: row.role,
    email: row.email,
    name: row.name,
    supportSession: {
      id: row.id,
      expiresAt: row.expires_at,
      firmName: row.firm_name,
      adminUserId: row.admin_user_id,
    },
  };
}
const firmSelect = `SELECT f.id,f.name,f.email,f.created_at,
  CASE WHEN COALESCE(p.settings->>'edition','existing')!='public' THEN 'exempt' ELSE COALESCE(s.status,'unsubscribed') END AS status,
  s.seat_quantity AS billed_seats,s.current_period_end,s.cancel_at_period_end,s.updated_at AS billing_updated_at,
  s.customer_id,s.subscription_id,
  (SELECT count(*)::int FROM firm_users u WHERE u.firm_id=f.id AND u.archived_at IS NULL AND u.accepted_at IS NOT NULL AND u.role!='agent') AS seats,
  (SELECT max(last_login_at) FROM firm_users u WHERE u.firm_id=f.id AND u.role!='agent') AS last_login_at,
  (SELECT json_build_object('name',COALESCE(NULLIF(u.display_name,''),u.name),'email',u.email) FROM firm_users u
    WHERE u.firm_id=f.id AND u.role='owner' AND u.archived_at IS NULL ORDER BY u.id LIMIT 1) AS owner
  FROM firms f LEFT JOIN firm_preferences p ON p.firm_id=f.id LEFT JOIN darklion_subscriptions s ON s.firm_id=f.id`;
// Estimates only; invoices can include credits, discounts or proration.
function withEstimate(firm) {
  const { BASE_MONTHLY_CENTS, STAFF_MONTHLY_CENTS } = require("./subscriptions");
  const billable = !["exempt", "unsubscribed", "canceled", "incomplete_expired"].includes(firm.status);
  return {
    ...firm,
    base_monthly_cents: BASE_MONTHLY_CENTS,
    staff_monthly_cents: STAFF_MONTHLY_CENTS,
    estimate_cents: billable ? BASE_MONTHLY_CENTS + STAFF_MONTHLY_CENTS * firm.seats : null,
  };
}
async function listFirms() {
  return (await pool.query(firmSelect + " ORDER BY lower(f.name),f.id")).rows.map(withEstimate);
}
async function firmDetail(id) {
  const firm = (await pool.query(firmSelect + " WHERE f.id=$1", [id])).rows[0];
  if (!firm) throw fail("Firm not found", 404, "NOT_FOUND");

  const staff = (
    await pool.query(
      `SELECT id,COALESCE(NULLIF(display_name,''),name,email) AS name,email,role
    FROM firm_users WHERE firm_id=$1 AND archived_at IS NULL AND accepted_at IS NOT NULL AND role!='agent' ORDER BY name`,
      [id],
    )
  ).rows;
  return { firm: withEstimate(firm), staff, activity: await accessLog(id) };
}
async function accessLog(firmId) {
  return (
    await pool.query(
      `SELECT ss.id,ss.firm_id,ss.admin_name,ss.target_name,ss.firm_name,ss.reason,ss.created_at,ss.expires_at,ss.ended_at,
    COALESCE(NULLIF(e.display_name,''),e.name) AS ended_by_name,
    (SELECT count(*)::int FROM support_session_events ev WHERE ev.support_session_id=ss.id) AS request_count,
    (ss.ended_at IS NULL AND ss.expires_at>NOW()) AS active FROM support_sessions ss
    LEFT JOIN firm_users e ON e.id=ss.ended_by ${firmId ? "WHERE ss.firm_id=$1" : ""}
    ORDER BY ss.created_at DESC LIMIT 100`,
      firmId ? [firmId] : [],
    )
  ).rows;
}
// What was requested during a support session, grouped so polling stays readable.
async function sessionEvents(id) {
  return (
    await pool.query(
      `SELECT method,path,allowed,count(*)::int AS count,min(created_at) AS first_at,max(created_at) AS last_at
    FROM support_session_events WHERE support_session_id=$1
    GROUP BY method,path,allowed ORDER BY min(id) LIMIT 500`,
      [id],
    )
  ).rows;
}
async function endSupport(id, endedBy) {
  await pool.query(
    "UPDATE support_sessions SET ended_at=NOW(),ended_by=$2 WHERE id=$1 AND ended_at IS NULL",
    [id, endedBy],
  );
}
async function billing(id, stripe) {
  const firm = (
    await pool.query(
      "SELECT customer_id,subscription_id FROM darklion_subscriptions WHERE firm_id=$1",
      [id],
    )
  ).rows[0];
  if (!firm?.customer_id)
    return {
      invoices: [],
      dashboardUrl: null,
      message: "No Stripe customer is linked to this firm.",
    };
  stripe ||= require("./subscriptions").stripeClient();
  const customer = await stripe.customers.retrieve(firm.customer_id);
  if (customer.deleted || customer.metadata?.darklion_firm_id !== String(id))
    throw fail(
      "Stripe customer could not be verified for this firm",
      409,
      "BILLING_MISMATCH",
    );
  const invoices = await stripe.invoices.list({
    customer: firm.customer_id,
    limit: 6,
  });
  const sub = firm.subscription_id
    ? await stripe.subscriptions.retrieve(firm.subscription_id)
    : null;
  if (
    sub &&
    (typeof sub.customer === "string" ? sub.customer : sub.customer.id) !==
      customer.id
  )
    throw fail("Subscription customer mismatch", 409, "BILLING_MISMATCH");
  return {
    refreshedAt: new Date().toISOString(),
    email: customer.email,
    status: sub?.status,
    dashboardUrl: `https://dashboard.stripe.com/${customer.livemode ? "" : "test/"}customers/${encodeURIComponent(customer.id)}`,
    invoices: invoices.data.map((i) => ({
      id: i.id,
      date: i.created,
      amount: i.total,
      currency: i.currency,
      status: i.status,
    })),
  };
}
module.exports = {
  requireStaffAdmin,
  startUnlock,
  verifyUnlock,
  maskEmail,
  sessionEvents,
  endSupport,
  requireAdminIdentity,
  startSupport,
  authenticateSupport,
  listFirms,
  firmDetail,
  accessLog,
  billing,
};
