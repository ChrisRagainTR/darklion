"use strict";
const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { pool } = require("../db");
const service = require("../services/platformAdmin");
const router = Router();
const limited = (windowMs, max, keyGenerator) =>
  rateLimit({
    windowMs,
    max,
    validate: { trustProxy: false },
    ...(keyGenerator ? { keyGenerator } : {}),
    // JSON so the admin page can show the message instead of a parse error.
    handler: (req, res) =>
      res.status(429).json({
        error: "Too many attempts. Wait a few minutes and try again.",
        code: "RATE_LIMITED",
      }),
  });
const byAdmin = (req) => String((req.admin || req.staffAdmin).userId);
router.use(limited(60000, 120));
function error(res, e) {
  return res.status(e.status || 503).json({
    error: e.status
      ? e.message
      : "Administration is unavailable. Please retry.",
    code: e.code || "ADMIN_UNAVAILABLE",
  });
}
const invalidAuth = (e) =>
  ["JsonWebTokenError", "TokenExpiredError", "NotBeforeError"].includes(
    e.name,
  ) ||
  ["INVALID_TOKEN", "INVALID_TOKEN_TYPE", "INACTIVE_STAFF"].includes(e.code) ||
  ["Session revoked", "New sign-in required"].includes(e.message);
const bearer = (req) => {
  const auth = req.headers.authorization || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
};
// Staff login only: check admin status and request/verify an emailed code.
const staffAdmin = async (req, res, next) => {
  try {
    if (!bearer(req))
      return res.status(401).json({ error: "Sign in to continue" });
    req.staffAdmin = await service.requireStaffAdmin(bearer(req));
    next();
  } catch (e) {
    error(
      res,
      invalidAuth(e)
        ? Object.assign(Error("Sign in again to continue"), { status: 401 })
        : e,
    );
  }
};
// Everything else: the unlocked admin token issued after the emailed code.
const unlockedAdmin = async (req, res, next) => {
  try {
    if (!bearer(req))
      return res
        .status(401)
        .json({ error: "Unlock the admin center to continue", code: "ADMIN_LOCKED" });
    req.admin = await service.requireAdminIdentity(bearer(req));
    next();
  } catch (e) {
    error(
      res,
      invalidAuth(e)
        ? Object.assign(Error("Unlock the admin center to continue"), {
            status: 401,
            code: "ADMIN_LOCKED",
          })
        : e,
    );
  }
};
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    error(res, e);
  }
};
router.get(
  "/status",
  staffAdmin,
  wrap((req) => ({
    admin: true,
    name: req.staffAdmin.name,
    email: service.maskEmail(req.staffAdmin.email),
  })),
);
router.post(
  "/unlock",
  staffAdmin,
  limited(900000, 5, byAdmin),
  wrap((req) =>
    service.startUnlock(req.staffAdmin, req.app.get("platformAdminSendEmail")),
  ),
);
router.post(
  "/unlock/verify",
  staffAdmin,
  limited(900000, 20, byAdmin),
  wrap((req) => service.verifyUnlock(req.staffAdmin, req.body)),
);
router.use(unlockedAdmin);
router.get(
  "/me",
  wrap((req) => ({ name: req.admin.name, userId: req.admin.userId })),
);
router.post(
  "/logout",
  wrap(async (req) => {
    await pool.query(
      "UPDATE platform_admin_unlocks SET revoked_at=NOW() WHERE admin_session_id=$1 AND revoked_at IS NULL",
      [req.admin.sessionId],
    );
    await pool.query(
      "UPDATE account_sessions SET revoked_at=NOW() WHERE id=$1 AND account_id=$2",
      [req.admin.sessionId, req.admin.userId],
    );
    await pool.query(
      "UPDATE support_sessions SET ended_at=NOW(),ended_by=$2 WHERE admin_session_id=$1 AND ended_at IS NULL",
      [req.admin.sessionId, req.admin.userId],
    );
    return { signedOut: true };
  }),
);
router.get(
  "/firms",
  wrap(() => service.listFirms()),
);
router.param("firmId", (req, res, next, value) =>
  /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? next()
    : res.status(400).json({ error: "Invalid firm" }),
);
router.param("sessionId", (req, res, next, value) =>
  /^[a-f0-9-]{36}$/i.test(value)
    ? next()
    : res.status(400).json({ error: "Invalid session" }),
);
router.get(
  "/firms/:firmId",
  wrap((req) => service.firmDetail(Number(req.params.firmId))),
);
router.get(
  "/firms/:firmId/billing",
  wrap((req) => service.billing(Number(req.params.firmId))),
);
router.get(
  "/access-log",
  wrap(() => service.accessLog()),
);
router.post(
  "/support-sessions",
  limited(900000, 10, byAdmin),
  wrap((req) => service.startSupport(req.admin, req.body)),
);
router.get(
  "/support-sessions/:sessionId/events",
  wrap((req) => service.sessionEvents(req.params.sessionId)),
);
router.delete(
  "/support-sessions/:sessionId",
  wrap(async (req) => {
    await service.endSupport(req.params.sessionId, req.admin.userId);
    return { ended: true };
  }),
);
module.exports = router;
