"use strict";
const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const crypto = require("node:crypto");
const { pool } = require("../db");
const {
  hash,
  enroll,
  createInvitation,
} = require("../services/firmEnrollment");
const emailService = require("../services/email");
const router = Router();
router.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 15,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { trustProxy: false },
  }),
);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
function legalConfiguration() {
  const termsUrl = process.env.DARKLION_TERMS_URL,
    privacyUrl = process.env.DARKLION_PRIVACY_URL,
    termsVersion = process.env.DARKLION_TERMS_VERSION;
  const valid = (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch (_) {
      return false;
    }
  };
  return {
    open:
      process.env.DARKLION_PUBLIC_ENROLLMENT === "true" &&
      !!termsVersion &&
      valid(termsUrl) &&
      valid(privacyUrl),
    termsUrl,
    privacyUrl,
    termsVersion,
  };
}
router.get("/configuration", (req, res) =>
  res.json({
    ...legalConfiguration(),
    baseMonthlyCents: 1900,
    staffMonthlyCents: 500,
  }),
);
function appOrigin() {
  return new URL(
    process.env.PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:8080",
  ).origin;
}
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
function signupEmail(heading, body, url, label) {
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0f1923">
  <p style="font-size:20px;font-weight:700;margin:0 0 20px">DarkLion</p>
  <h1 style="font-size:22px;margin:0 0 12px">${escapeHtml(heading)}</h1>
  <p style="font-size:15px;line-height:1.6;margin:0 0 24px">${escapeHtml(body)}</p>
  <p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;background:#c9a84c;color:#0f1923;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:8px">${escapeHtml(label)}</a></p>
  <p style="font-size:13px;line-height:1.6;color:#5b6570;margin:0">If you did not request this, you can ignore this email. Questions? Contact your administrator.</p>
</div>`;
}
// Direct website signup: email a single-use workspace link. The response never
// reveals whether an address already has an account.
router.post("/start", async (req, res) => {
  if (!legalConfiguration().open)
    return res.status(403).json({ error: "New signups are paused. Ask the administrator for an invitation." });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return res.status(400).json({ error: "Enter a valid work email address." });
  const accepted = { ok: true, email };
  try {
    const recent = (
      await pool.query(
        "SELECT COUNT(*)::int AS n FROM firm_enrollment_invitations WHERE email=$1 AND created_at>NOW()-INTERVAL '1 hour'",
        [email],
      )
    ).rows[0].n;
    if (recent >= 3) return res.json(accepted);
    const existing = (
      await pool.query(
        `SELECT 1 FROM firms WHERE LOWER(TRIM(email))=$1
         UNION ALL SELECT 1 FROM firm_users WHERE LOWER(TRIM(email))=$1 AND archived_at IS NULL
         LIMIT 1`,
        [email],
      )
    ).rowCount;
    if (existing) {
      await emailService.sendEmail({
        to: email,
        fromName: "DarkLion",
        subject: "You already have a DarkLion account",
        html: signupEmail(
          "You already have a DarkLion account",
          "This email address is already connected to a DarkLion workspace. Sign in to continue, or reset your password from the sign-in page.",
          appOrigin() + "/login",
          "Sign in to DarkLion",
        ),
      });
      return res.json(accepted);
    }
    const token = await createInvitation({ email, source: "direct", days: 2 });
    await emailService.sendEmail({
      to: email,
      fromName: "DarkLion",
      subject: "Create your DarkLion workspace",
      html: signupEmail(
        "Create your DarkLion workspace",
        "Confirm your email to set up your firm's workspace. Next you'll secure your sign-in and activate your membership: $19 per month plus $5 per staff user. This link works once and expires in 48 hours.",
        appOrigin() + "/join?invitation=" + encodeURIComponent(token),
        "Create my workspace",
      ),
    });
    res.json(accepted);
  } catch (e) {
    console.error("[enrollment] signup email failed:", e.message);
    res.status(503).json({ error: "We could not send your signup email. Please try again in a few minutes." });
  }
});
router.get("/invitation/:token", async (req, res) => {
  try {
    const row = (
      await pool.query(
        "SELECT email,expires_at FROM firm_enrollment_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>NOW()",
        [hash(req.params.token)],
      )
    ).rows[0];
    res
      .status(row ? 200 : 404)
      .json(
        row
          ? { valid: true, email: row.email }
          : { error: "Invitation expired or invalid" },
      );
  } catch (_) {
    res.status(503).json({ error: "Enrollment unavailable" });
  }
});
router.post("/", async (req, res) => {
  if (!legalConfiguration().open)
    return res.status(403).json({ error: "Public enrollment is not open yet" });
  try {
    res.status(201).json(await enroll(req.body));
  } catch (e) {
    res
      .status(400)
      .json({
        error:
          e.name === "ZodError"
            ? "Check the firm name, code, password, and terms acceptance"
            : e.message,
      });
  }
});
// LedgerHQ issues a short-lived signed eligibility assertion after verifying its
// own authenticated member. Browser-supplied firm IDs are never eligibility proof.
router.post("/ledgerhq", async (req, res) => {
  const secret = process.env.LEDGERHQ_ENROLLMENT_SECRET;
  if (!secret || secret.length < 32)
    return res
      .status(503)
      .json({ error: "LedgerHQ enrollment is not configured" });
  const { assertion, signature } = req.body;
  if (
    typeof assertion !== "string" ||
    assertion.length > 4000 ||
    !/^([a-f0-9]{64})$/i.test(signature || "")
  )
    return res.status(401).json({ error: "Invalid membership assertion" });
  const expected = crypto
    .createHmac("sha256", secret)
    .update(assertion)
    .digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(signature, "hex")))
    return res.status(401).json({ error: "Invalid membership assertion" });
  try {
    const data = JSON.parse(
      Buffer.from(assertion, "base64url").toString("utf8"),
    );
    if (
      data.audience !== "darklion-enrollment" ||
      data.eligible !== true ||
      !Number.isInteger(data.exp) ||
      data.exp < Date.now() / 1000 ||
      data.exp > Date.now() / 1000 + 600
    )
      throw Error("Membership assertion expired");
    if (typeof data.firmId !== "string" || !data.firmId.trim())
      throw Error("Membership firm required");
    const existing = (
      await pool.query(
        `SELECT f.slug FROM firm_enrollment_invitations i
         JOIN firms f ON f.id=i.firm_id
         WHERE i.ledgerhq_firm_id=$1 AND i.accepted_at IS NOT NULL`,
        [data.firmId],
      )
    ).rows[0];
    if (existing)
      return res.json({ url: "/login?firm=" + encodeURIComponent(existing.slug) });
    if (!legalConfiguration().open)
      return res.status(403).json({ error: "Public enrollment is not open yet" });
    const token = await createInvitation({
      email: data.email,
      ledgerhqFirmId: data.firmId,
    });
    res
      .status(201)
      .json({ url: "/join?invitation=" + encodeURIComponent(token) });
  } catch (_) {
    res
      .status(400)
      .json({ error: "Membership assertion invalid or already enrolled" });
  }
});
module.exports = router;
