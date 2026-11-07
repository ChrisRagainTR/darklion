"use strict";
// Isolated browser fixture using the real routes and database, with no provider
// credentials, background workers or production environment loading.
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const bcrypt = require("bcrypt");
const target = new URL(process.env.DATABASE_URL || "http://unset.invalid");
assert.equal(target.hostname, "localhost");
assert.equal(target.pathname, "/darklion_admin_ui_test");
process.env.DB_SSL = "false";
process.env.JWT_SECRET = "synthetic-admin-browser-signing-key-only";
process.env.ENCRYPTION_KEY = "a".repeat(64);
const { pool, initDB } = require("../../server/db");
const { encrypt } = require("../../server/utils/encryption");
async function start() {
  await initDB();
  if (
    !(
      await pool.query(
        "SELECT 1 FROM firms WHERE email='admin@preview.example.invalid'",
      )
    ).rowCount
  ) {
    const hash = await bcrypt.hash("Synthetic-preview-password-123", 4);
    const admin = (
      await pool.query(
        "INSERT INTO firms(name,email,password_hash) VALUES('Platform','admin@preview.example.invalid',$1) RETURNING id",
        [hash],
      )
    ).rows[0];
    const user = (
      await pool.query(
        "INSERT INTO firm_users(firm_id,name,email,password_hash,role,accepted_at) VALUES($1,'Alex Owner','admin@preview.example.invalid',$2,'owner',NOW()) RETURNING id",
        [admin.id, hash],
      )
    ).rows[0];
    await pool.query("INSERT INTO platform_admins(user_id) VALUES($1)", [
      user.id,
    ]);
    await pool.query(
      "INSERT INTO account_security(firm_id,kind,account_id,mfa_enabled,mfa_secret) VALUES($1,'staff',$2,TRUE,$3)",
      [admin.id, user.id, encrypt("JBSWY3DPEHPK3PXP")],
    );
    for (const [i, name] of [
      "Harbor Tax & Advisory",
      "Northstar Accounting",
      "Summit CPA Group",
      "Willow Bookkeeping",
      "Cedar & Co.",
      "Elm Advisory",
    ].entries()) {
      const f = (
        await pool.query(
          "INSERT INTO firms(name,email,password_hash) VALUES($1,$2,$3) RETURNING id",
          [name, `owner${i}@preview.example.invalid`, hash],
        )
      ).rows[0];
      await pool.query(
        'INSERT INTO firm_preferences(firm_id,settings) VALUES($1,\'{"edition":"public"}\')',
        [f.id],
      );
      const owner = [
        "Maya Chen",
        "Daniel Brooks",
        "Priya Shah",
        "Avery Reed",
        "Jordan Lee",
        "Morgan Ellis",
      ][i];
      for (let n = 0; n < [4, 7, 2, 1, 1, 3][i]; n++)
        await pool.query(
          "INSERT INTO firm_users(firm_id,name,email,password_hash,role,accepted_at,last_login_at) VALUES($1,$2,$3,$4,$5,NOW(),NOW())",
          [
            f.id,
            n === 0 ? owner : `Staff ${n}`,
            `staff${i}-${n}@preview.example.invalid`,
            hash,
            n === 0 ? "owner" : "staff",
          ],
        );
      await pool.query(
        "INSERT INTO darklion_subscriptions(firm_id,status,seat_quantity,current_period_end) VALUES($1,$2,$3,$4)",
        [
          f.id,
          [
            "active",
            "past_due",
            "active",
            "active",
            "unsubscribed",
            "canceled",
          ][i],
          [4, 7, 2, 1, 1, 3][i],
          "2026-10-15",
        ],
      );
      if (i === 0)
        for (const client of [
          "Maple Street Dental",
          "Lakeside Design Studio",
          "Bluebird Consulting",
          "Riverbend Properties",
          "Oak & Anchor LLC",
        ])
          await pool.query(
            "INSERT INTO relationships(firm_id,name,service_tier) VALUES($1,$2,'standard')",
            [f.id, client],
          );
    }
  }
  // Legacy DB initialization backfills one owner from each firms row on restart.
  // These synthetic fixture rows use separate named staff; archive only the
  // generated fixture owners so the displayed seats stay stable across restarts.
  await pool.query(
    `UPDATE firm_users SET archived_at=NOW() WHERE email ~ '^owner[0-9]+@preview[.]example[.]invalid$' AND archived_at IS NULL`,
  );
  // Fake provider responses only in this explicit local fixture. App routes and
  // customer-to-firm verification remain real; no Stripe network calls are made.
  const harbor = (
    await pool.query("SELECT id FROM firms WHERE name='Harbor Tax & Advisory'")
  ).rows[0];
  await pool.query(
    "UPDATE darklion_subscriptions SET customer_id='cus_admin_preview',subscription_id='sub_admin_preview',current_period_end='2026-10-15T16:00:00Z' WHERE firm_id=$1",
    [harbor.id],
  );
  require("../../server/services/subscriptions").stripeClient = () => ({
    customers: {
      retrieve: async () => ({
        id: "cus_admin_preview",
        metadata: { darklion_firm_id: String(harbor.id) },
        livemode: false,
        email: "billing@harbortax.example",
      }),
    },
    subscriptions: {
      retrieve: async () => ({
        id: "sub_admin_preview",
        customer: "cus_admin_preview",
        status: "active",
      }),
    },
    invoices: {
      list: async () => ({
        data: [9, 8, 7].map((month) => ({
          id: "in_preview_" + month,
          created:
            Date.parse(`2026-${String(month).padStart(2, "0")}-15T16:00:00Z`) /
            1000,
          total: 3900,
          currency: "usd",
          status: "paid",
        })),
      }),
    },
  });
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.resolve(__dirname, "../../server/views"));
  // Synthetic fixture only: print the admin unlock code instead of emailing it.
  app.set("platformAdminSendEmail", async (message) => {
    console.log("Synthetic admin unlock code: " + message.subject.slice(0, 6));
    return { ok: true };
  });
  app.use(express.json());
  app.use(require("../../server/middleware/supportSession").supportSession);
  app.use((req, res, next) => {
    res.locals.firmBranding = null;
    res.locals.formatPersonDisplayName =
      require("../../server/utils/displayName").formatPersonDisplayName;
    next();
  });
  app.use(
    express.static(path.resolve(__dirname, "../../public"), { index: false }),
  );
  app.get("/login", (req, res) =>
    res.sendFile(path.resolve(__dirname, "../../public/login.html")),
  );
  app.get(["/admin", "/admin/firms/:id", "/admin/access-log"], (req, res) =>
    res.sendFile(path.resolve(__dirname, "../../public/admin.html")),
  );
  app.get("/account", (req, res) =>
    res.sendFile(path.resolve(__dirname, "../../public/account.html")),
  );
  app.get("/realtime-config.js", (req, res) =>
    res.type("js").send("window.DL_REALTIME_CONFIG={enabled:false}"),
  );
  app.use("/api/platform-admin", require("../../server/routes/platform-admin"));
  app.use("/firms", require("../../server/routes/firms"));
  const { requireFirm } = require("../../server/middleware/requireFirm");
  for (const [mount, name] of [
    ["relationships", "relationships"],
    ["people", "people"],
    ["messages", "messages"],
    ["document-notifications", "document-notifications"],
    ["firm-settings", "firm-settings"],
    ["team-chat", "team-chat"],
    ["documents", "documents"],
    ["pipelines", "pipelines"],
    ["today", "today"],
    ["my-work", "my-work"],
    ["summaries", "summaries"],
    ["dashboard", "dashboard"],
  ])
    app.use(
      "/api/" + mount,
      requireFirm,
      require("../../server/routes/" + name),
    );
  app.use("/api", requireFirm, require("../../server/routes/api"));
  for (const [url, view, nav] of [
    ["/crm", "crm", "relationships"],
    ["/messages", "messages", "messages"],
    ["/today", "today", "today"],
    ["/documents", "documents", "documents"],
    ["/crm/relationship/:id", "crm-relationship", "relationships"],
  ])
    app.get(url, (req, res) =>
      res.render(view, { title: "Workspace", activeNav: nav }),
    );
  app.listen(8798, "127.0.0.1", () =>
    console.log("Synthetic admin preview ready on port 8798"),
  );
}
start().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
