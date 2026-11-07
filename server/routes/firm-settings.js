"use strict";
const { Router } = require("express");
const { pool } = require("../db");
const {
  getFirmPreferences,
  updateFirmPreferences,
} = require("../services/firmPreferences");
const router = Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
router.get("/", async (req, res) => {
  try {
    res.json(await getFirmPreferences(req.firm.id));
  } catch (_) {
    res.status(503).json({ error: "Firm settings unavailable" });
  }
});
router.use((req, res, next) =>
  ["owner", "admin"].includes(req.firm.role) && !req.firm.isApiToken
    ? next()
    : res.status(403).json({ error: "Firm administrator required" }),
);
router.get("/services", async (req, res) => {
  const state = require("../services/offerReadiness").offerReadiness();
  try {
    const jobs = (
      await pool.query(
        "SELECT status,COUNT(*)::int AS count FROM summary_jobs WHERE firm_id=$1 GROUP BY status",
        [req.firm.id],
      )
    ).rows;
    const usage = (
      await pool.query(
        "SELECT feature,status,COUNT(*)::int AS requests,SUM(input_tokens)::text AS input_tokens,SUM(output_tokens)::text AS output_tokens FROM ai_usage WHERE firm_id=$1 AND created_at>=date_trunc('month',NOW()) GROUP BY feature,status ORDER BY feature,status",
        [req.firm.id],
      )
    ).rows;
    const seatSync =
      (
        await pool.query(
          "SELECT attempts,next_attempt_at FROM subscription_seat_sync WHERE firm_id=$1",
          [req.firm.id],
        )
      ).rows[0] || null;
    res.json({ ...state, jobs, usage, seatSync });
  } catch (_) {
    res.status(503).json({ error: "Service status unavailable" });
  }
});
router.put("/", async (req, res) => {
  try {
    if (
      req.body.staffMfaRequired === false &&
      (await getFirmPreferences(req.firm.id)).edition === "public"
    )
      return res
        .status(400)
        .json({ error: "Public workspaces require staff MFA" });
    if (
      req.body.aiDailyRequests > 200 &&
      (await getFirmPreferences(req.firm.id)).edition === "public"
    )
      return res
        .status(400)
        .json({
          error: "Contact support to increase the included AI allowance",
        });
    const prefs = await updateFirmPreferences(req.firm.id, req.body);
    await pool.query(
      "INSERT INTO audit_log(firm_id,action,detail) VALUES($1,$2,$3)",
      [
        req.firm.id,
        "firm_preferences_changed",
        JSON.stringify({
          userId: req.firm.userId,
          fields: Object.keys(req.body),
        }),
      ],
    );
    res.json(prefs);
  } catch (e) {
    res
      .status(400)
      .json({
        error: e.name === "ZodError" ? "Invalid firm settings" : e.message,
      });
  }
});
router.get("/notification-routes", async (req, res) => {
  try {
    res.json(
      (
        await pool.query(
          "SELECT folder_category,staff_user_id FROM document_notification_routes WHERE firm_id=$1 ORDER BY folder_category,staff_user_id",
          [req.firm.id],
        )
      ).rows,
    );
  } catch (_) {
    res.status(503).json({ error: "Notification settings unavailable" });
  }
});
router.put("/notification-routes", async (req, res) => {
  const entries = req.body.routes;
  if (
    !Array.isArray(entries) ||
    entries.length > 300 ||
    entries.some(
      (e) =>
        !["tax", "bookkeeping", "other"].includes(e.folder_category) ||
        !Number.isSafeInteger(e.staff_user_id) ||
        e.staff_user_id < 1,
    )
  )
    return res.status(400).json({ error: "Invalid notification routes" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM firms WHERE id=$1 FOR UPDATE", [
      req.firm.id,
    ]);
    const ids = [...new Set(entries.map((e) => e.staff_user_id))];
    const staff = await client.query(
      "SELECT id FROM firm_users WHERE firm_id=$1 AND id=ANY($2::int[]) AND accepted_at IS NOT NULL AND archived_at IS NULL",
      [req.firm.id, ids],
    );
    if (staff.rowCount !== ids.length)
      throw Error("Select active staff in your firm");
    await client.query(
      "DELETE FROM document_notification_routes WHERE firm_id=$1",
      [req.firm.id],
    );
    for (const e of entries)
      await client.query(
        "INSERT INTO document_notification_routes(firm_id,folder_category,staff_user_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [req.firm.id, e.folder_category, e.staff_user_id],
      );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});
router.get("/data-requests", async (req, res) => {
  try {
    res.json(
      (
        await pool.query(
          "SELECT * FROM customer_data_requests WHERE firm_id=$1 ORDER BY created_at DESC LIMIT 200",
          [req.firm.id],
        )
      ).rows,
    );
  } catch (_) {
    res.status(503).json({ error: "Requests unavailable" });
  }
});
router.put("/data-requests/:id", async (req, res) => {
  if (
    !["reviewing", "retained", "completed", "cancelled"].includes(
      req.body.status,
    ) ||
    !/^[a-f0-9-]{36}$/i.test(req.params.id)
  )
    return res.status(400).json({ error: "Invalid request update" });
  try {
    const result = await pool.query(
      "UPDATE customer_data_requests SET status=$1,note=$2,updated_at=NOW() WHERE id=$3 AND firm_id=$4 RETURNING id,status",
      [
        req.body.status,
        String(req.body.note || "").slice(0, 1000),
        req.params.id,
        req.firm.id,
      ],
    );
    res
      .status(result.rowCount ? 200 : 404)
      .json(result.rows[0] || { error: "Request not found" });
  } catch (_) {
    res.status(503).json({ error: "Request update unavailable" });
  }
});
module.exports = router;
router.get("/stripe-accounts", async (req, res) => {
  try {
    res.json(
      (
        await require("../services/firmIntegrations").stripeAccounts(
          req.firm.id,
        )
      ).map(({ name, label }) => ({ name, label })),
    );
  } catch (_) {
    res.status(503).json({ error: "Integration settings unavailable" });
  }
});
router.put("/stripe-accounts/:name", async (req, res) => {
  if (req.firm.role !== "owner")
    return res.status(403).json({ error: "Firm owner required" });
  try {
    await require("../services/firmIntegrations").saveStripeAccount(
      req.firm.id,
      { name: req.params.name, label: req.body.label, key: req.body.key },
    );
    res.json({ ok: true });
  } catch (_) {
    res
      .status(400)
      .json({
        error:
          "Could not verify this restricted Stripe key. Check its customer, subscription, and invoice read permissions.",
      });
  }
});
router.delete("/stripe-accounts/:name", async (req, res) => {
  if (req.firm.role !== "owner")
    return res.status(403).json({ error: "Firm owner required" });
  await pool.query(
    "DELETE FROM firm_integration_secrets WHERE firm_id=$1 AND provider='stripe' AND account_name=$2",
    [req.firm.id, req.params.name],
  );
  res.json({ ok: true });
});
