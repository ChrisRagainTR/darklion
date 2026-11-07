"use strict";
const assert = require("node:assert/strict");
const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");

async function verifyAdminCenter(pool, t) {
  const security = require("../../server/services/accountSecurity");
  const service = require("../../server/services/platformAdmin");
  const { encrypt } = require("../../server/utils/encryption");
  const {
    requireFirm,
    authenticateStaffToken,
  } = require("../../server/middleware/requireFirm");
  const password = "Synthetic-admin-password-123";
  const hash = await bcrypt.hash(password, 4);
  const createFirm = async (name, email) =>
    (
      await pool.query(
        "INSERT INTO firms(name,email,password_hash) VALUES($1,$2,$3) RETURNING id",
        [name, email, hash],
      )
    ).rows[0].id;
  const adminFirm = await createFirm(
    "Synthetic Platform",
    "platform@admin.example.invalid",
  );
  const targetFirm = await createFirm(
    "Synthetic Harbor",
    "owner@harbor.example.invalid",
  );
  const otherFirm = await createFirm(
    "Synthetic Other",
    "owner@other-admin.example.invalid",
  );
  async function user(firm, name, role = "owner") {
    return (
      await pool.query(
        "INSERT INTO firm_users(firm_id,name,email,password_hash,role,accepted_at) VALUES($1,$2,$3,$4,$5,NOW()) RETURNING id",
        [
          firm,
          name,
          name.replace(/ /g, "").toLowerCase() + "@admin.example.invalid",
          hash,
          role,
        ],
      )
    ).rows[0].id;
  }
  const adminUser = await user(adminFirm, "Platform Admin"),
    targetUser = await user(targetFirm, "Harbor Owner"),
    otherUser = await user(otherFirm, "Other Owner");
  const account = { firmId: adminFirm, kind: "staff", accountId: adminUser };
  await security.ensureAccount(account);
  const secret = "JBSWY3DPEHPK3PXP";
  await pool.query(
    "UPDATE account_security SET mfa_enabled=TRUE,mfa_secret=$2 WHERE account_id=$1 AND kind='staff'",
    [adminUser, encrypt(secret)],
  );
  const adminToken = await security.createSession(
    account,
    { type: "staff", firmId: adminFirm, userId: adminUser },
    {},
    { version: 0, mfa: true },
  );
  const ownerToken = await security.createSession(
    { firmId: targetFirm, kind: "staff", accountId: targetUser },
    { type: "staff", firmId: targetFirm, userId: targetUser },
  );
  const actor = await authenticateStaffToken(adminToken);
  await pool.query("INSERT INTO platform_admins(user_id) VALUES($1)", [
    adminUser,
  ]);
  const app = express();
  const sentEmails = [];
  app.set("platformAdminSendEmail", async (message) => {
    sentEmails.push(message);
    return { ok: true };
  });
  app.use(express.json());
  app.use(require("../../server/middleware/supportSession").supportSession);
  app.use("/api/platform-admin", require("../../server/routes/platform-admin"));
  app.use(
    "/api/relationships",
    requireFirm,
    require("../../server/routes/relationships"),
  );
  app.use(
    "/api/messages",
    requireFirm,
    require("../../server/routes/messages"),
  );
  app.use(
    "/api/firm-settings",
    requireFirm,
    require("../../server/routes/firm-settings"),
  );
  app.use("/firms", require("../../server/routes/firms"));
  app.get("/api/search", requireFirm, async (req, res) => {
    try {
      await pool.query("UPDATE firms SET name=$1 WHERE id=$2", [
        "BAD",
        req.firm.id,
      ]);
      res.json({ wrote: true });
    } catch (e) {
      res.status(409).json({ code: e.code });
    }
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (path, token = adminToken, method = "GET", body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body:
        body && !["GET", "HEAD"].includes(method)
          ? JSON.stringify(body)
          : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  const lastCode = () => sentEmails.at(-1).subject.match(/^(\d{6}) /)[1];
  // Workspace login -> emailed code -> unlocked admin token.
  const unlockAs = async (staffToken) => {
    const started = await call("/api/platform-admin/unlock", staffToken, "POST");
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const verified = await call("/api/platform-admin/unlock/verify", staffToken, "POST", {
      challengeId: started.body.challengeId,
      code: lastCode(),
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    return verified.body.token;
  };
  let admin = await unlockAs(adminToken);
  await t.test(
    "firm owner and API key cannot administer other firms",
    async () => {
      assert.equal(
        (await call("/api/platform-admin/status", ownerToken)).status,
        403,
      );
      assert.equal(
        (await call("/api/platform-admin/unlock", ownerToken, "POST")).status,
        403,
      );
      assert.equal(
        (await call("/api/platform-admin/firms", ownerToken)).status,
        401,
      );
      assert.equal(
        (await call("/api/platform-admin/firms", "dlk_synthetic")).status,
        401,
      );
      assert.equal(
        (await call("/api/platform-admin/firms", admin)).status,
        200,
      );
    },
  );
  await t.test(
    "workspace login alone cannot use administration without the emailed code",
    async () => {
      const locked = await call("/api/platform-admin/firms", adminToken);
      assert.equal(locked.status, 401);
      assert.equal(locked.body.code, "ADMIN_LOCKED");
      const status = await call("/api/platform-admin/status", adminToken);
      assert.equal(status.body.admin, true);
      assert.ok(!status.body.email.includes("platformadmin@"), "email is masked");
      assert.equal(sentEmails.at(-1).to, "platformadmin@admin.example.invalid");
      // Unlock tokens are purpose-bound: not a staff login, not a support token.
      await assert.rejects(() => authenticateStaffToken(admin));
      assert.equal((await call("/api/relationships", admin)).status, 401);
    },
  );
  await t.test(
    "emailed codes are single-use, attempt-limited, expiring and login-bound",
    async () => {
      const staff = await service.requireStaffAdmin(adminToken);
      const codes = [];
      const capture = async (m) => {
        codes.push(m.subject.slice(0, 6));
        return { ok: true };
      };
      const first = await service.startUnlock(staff, capture);
      await assert.rejects(
        () => service.verifyUnlock(staff, { challengeId: first.challengeId, code: "000000" === codes[0] ? "111111" : "000000" }),
        (e) => e.code === "INVALID_CODE",
      );
      // A new code replaces the pending one.
      const second = await service.startUnlock(staff, capture);
      await assert.rejects(
        () => service.verifyUnlock(staff, { challengeId: first.challengeId, code: codes[0] }),
        (e) => e.code === "CODE_EXPIRED",
      );
      // Another login of the same person cannot redeem this login's code.
      const otherLogin = await security.createSession(
        account,
        { type: "staff", firmId: adminFirm, userId: adminUser },
        {},
        { version: 0, mfa: true },
      );
      const otherStaff = await service.requireStaffAdmin(otherLogin);
      await assert.rejects(
        () => service.verifyUnlock(otherStaff, { challengeId: second.challengeId, code: codes[1] }),
        (e) => e.code === "CODE_EXPIRED",
      );
      const ok = await service.verifyUnlock(staff, { challengeId: second.challengeId, code: codes[1] });
      assert.ok(ok.token);
      await assert.rejects(
        () => service.verifyUnlock(staff, { challengeId: second.challengeId, code: codes[1] }),
        (e) => e.code === "CODE_EXPIRED",
        "codes are single use",
      );
      // Five wrong guesses lock the code, even before it expires.
      const third = await service.startUnlock(staff, capture);
      const wrong = codes[2] === "999999" ? "888888" : "999999";
      for (let i = 0; i < 5; i++)
        await assert.rejects(() => service.verifyUnlock(staff, { challengeId: third.challengeId, code: wrong }));
      await assert.rejects(
        () => service.verifyUnlock(staff, { challengeId: third.challengeId, code: codes[2] }),
        (e) => e.code === "CODE_EXPIRED",
      );
      const fourth = await service.startUnlock(staff, capture);
      await pool.query("UPDATE platform_admin_unlocks SET code_expires_at=NOW()-INTERVAL '1 second' WHERE id=$1", [fourth.challengeId]);
      await assert.rejects(
        () => service.verifyUnlock(staff, { challengeId: fourth.challengeId, code: codes[3] }),
        (e) => e.code === "CODE_EXPIRED",
      );
      // Unconfigured email never silently "sends" a code.
      await assert.rejects(
        () => service.startUnlock(staff, async () => ({ ok: true, skipped: true })),
        (e) => e.status === 503 && e.code === "EMAIL_UNAVAILABLE",
      );
      // The unlock dies with the login it came from.
      await pool.query("UPDATE account_sessions SET revoked_at=NOW() WHERE id=$1", [otherStaff.sessionId]);
      const otherUnlock = await service.startUnlock(otherStaff, capture);
      const otherAdmin = (await service.verifyUnlock(otherStaff, { challengeId: otherUnlock.challengeId, code: codes.at(-1) })).token;
      assert.equal((await call("/api/platform-admin/me", otherAdmin)).status, 401);
      assert.equal((await call("/api/platform-admin/me", ok.token)).status, 200);
    },
  );
  await t.test("multiple admins each unlock with their own emailed code", async () => {
    const second = await user(adminFirm, "Second Admin", "staff");
    const prepare = (email) => require("node:child_process").execFileSync(
      process.execPath, [require.resolve("../../scripts/platform-admin"), "prepare", String(second), email],
      { env: process.env, stdio: "pipe" });
    assert.throws(() => prepare("wrong@admin.example.invalid"));
    assert.equal((await pool.query("SELECT 1 FROM platform_admins WHERE user_id=$1", [second])).rowCount, 0);
    prepare("secondadmin@admin.example.invalid");
    const login = await call("/firms/login", "", "POST", {email:"secondadmin@admin.example.invalid",password});
    assert.equal(login.status, 200);
    const secondToken = login.body.token;
    const secondAdmin = await unlockAs(secondToken);
    assert.equal(sentEmails.at(-1).to, "secondadmin@admin.example.invalid");
    assert.equal((await call("/api/platform-admin/me", secondAdmin)).body.userId, second);
    assert.equal((await call("/api/platform-admin/me", admin)).body.userId, adminUser);
    const ghost = await call("/api/platform-admin/support-sessions", secondAdmin, "POST", {firmId:targetFirm,userId:targetUser,reason:"Second admin support check",password});
    assert.equal(ghost.status, 200);
    assert.equal((await call("/api/relationships", ghost.body.token)).status, 200);
    await call("/api/platform-admin/support-sessions/"+ghost.body.id, secondAdmin, "DELETE");
    // Security version changes (password reset, sign out everywhere) end the unlock.
    await security.ensureAccount({ firmId: adminFirm, kind: "staff", accountId: second });
    await pool.query("UPDATE account_security SET version=version+1 WHERE account_id=$1 AND kind='staff'", [second]);
    assert.equal((await call("/api/platform-admin/me", secondAdmin)).status, 401);
    await pool.query("UPDATE account_security SET version=version-1 WHERE account_id=$1 AND kind='staff'", [second]);
    assert.equal((await call("/api/platform-admin/me", secondAdmin)).status, 200);
    // Revocation ends the unlock; preparation never reactivates it.
    await pool.query("UPDATE platform_admins SET revoked_at=NOW() WHERE user_id=$1", [second]);
    prepare("secondadmin@admin.example.invalid");
    assert.equal((await call("/api/platform-admin/me", secondAdmin)).status, 401);
    assert.equal((await call("/api/platform-admin/status", secondToken)).status, 403);
    // A regrant starts over: old unlocks stay dead.
    await pool.query("UPDATE platform_admins SET revoked_at=NULL,created_at=NOW() WHERE user_id=$1", [second]);
    assert.equal((await call("/api/platform-admin/me", secondAdmin)).status, 401);
    // Rate-limited requests return JSON the admin page can display.
    let limited;
    for (let i = 0; i < 6 && !limited; i++) {
      const r = await call("/api/platform-admin/unlock", secondToken, "POST");
      if (r.status === 429) limited = r;
    }
    assert.equal(limited?.body.code, "RATE_LIMITED");
    assert.equal((await call("/api/platform-admin/me", admin)).status, 200);
  });
  await t.test(
    "directory distinguishes exempt and unpaid firms and counts accepted staff",
    async () => {
      await pool.query(
        'INSERT INTO firm_preferences(firm_id,settings) VALUES($1,\'{"edition":"public"}\')',
        [targetFirm],
      );
      await pool.query(
        "INSERT INTO darklion_subscriptions(firm_id,status,seat_quantity,customer_id,subscription_id) VALUES($1,'past_due',1,'cus_admin_synthetic','sub_admin_synthetic')",
        [targetFirm],
      );
      const rows = (await call("/api/platform-admin/firms", admin)).body;
      assert.equal(rows.find((f) => f.id === targetFirm).status, "past_due");
      assert.equal(rows.find((f) => f.id === adminFirm).status, "exempt");
      assert.equal(rows.find((f) => f.id === targetFirm).seats, 1);
      assert.equal(rows.find((f) => f.id === targetFirm).estimate_cents, 1900 + 500);
      assert.equal(rows.find((f) => f.id === adminFirm).estimate_cents, null);
    },
  );
  const input = {
    firmId: targetFirm,
    userId: targetUser,
    reason: "Investigating synthetic missing documents",
    password,
  };
  await t.test(
    "support creation rejects wrong password and missing reason",
    async () => {
      assert.equal(
        (
          await call(
            "/api/platform-admin/support-sessions",
            admin,
            "POST",
            { ...input, password: "wrong" },
          )
        ).body.code,
        "REAUTH_REQUIRED",
      );
      assert.equal(
        (
          await call(
            "/api/platform-admin/support-sessions",
            admin,
            "POST",
            { ...input, reason: "" },
          )
        ).status,
        400,
      );
    },
  );
  const started = await call(
    "/api/platform-admin/support-sessions",
    admin,
    "POST",
    input,
  );
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const support = started.body;
  const rel = (
    await pool.query(
      "INSERT INTO relationships(firm_id,name) VALUES($1,'Harbor private client') RETURNING id",
      [targetFirm],
    )
  ).rows[0];
  const otherRel = (
    await pool.query(
      "INSERT INTO relationships(firm_id,name) VALUES($1,'Other private client') RETURNING id",
      [otherFirm],
    )
  ).rows[0];
  await t.test(
    "support is one-firm scoped, records real actor, and cannot be a normal login",
    async () => {
      assert.equal(
        (await call("/api/relationships", support.token)).body.length,
        1,
      );
      assert.equal(
        (await call("/api/relationships/" + otherRel.id, support.token)).status,
        404,
      );
      assert.equal(
        (await call("/firms/me", support.token)).body.id,
        targetFirm,
      );
      assert.equal(
        (await call("/api/platform-admin/firms", support.token)).status,
        403,
      );
      await assert.rejects(() => authenticateStaffToken(support.token));
      const log = (await service.accessLog(targetFirm))[0];
      assert.equal(log.admin_name, "Platform Admin");
      assert.equal(log.target_name, "Harbor Owner");
      assert.equal(log.reason, input.reason);
    },
  );
  await t.test(
    "writes, invite links, secrets, OAuth and unknown GETs are denied",
    async () => {
      for (const [path, method] of [
        ["/api/relationships", "POST"],
        ["/api/relationships/" + rel.id, "DELETE"],
        ["/firms/team/" + targetUser + "/invite-link", "GET"],
        ["/firms/api-tokens", "GET"],
        ["/api/account-security", "GET"],
        ["/auth/connect", "GET"],
        ["/api/documents/1/extracted_data", "GET"],
        ["/api/new-future-route", "GET"],
      ])
        assert.equal(
          (await call(path, support.token, method, { name: "BAD" })).status,
          403,
          path,
        );
    },
  );
  await t.test(
    "database read-only transaction rejects hidden GET writes",
    async () => {
      assert.equal(
        (await call("/api/search", support.token)).body.code,
        "25006",
      );
      assert.equal(
        (await pool.query("SELECT name FROM firms WHERE id=$1", [targetFirm]))
          .rows[0].name,
        "Synthetic Harbor",
      );
      assert.equal(
        (await call("/api/relationships/" + rel.id, support.token)).status,
        200,
      );
    },
  );
  await t.test(
    "message viewing preserves unread and mention state",
    async () => {
      const person = (
        await pool.query(
          "INSERT INTO people(firm_id,first_name,last_name,email) VALUES($1,'Synthetic','Client','client@admin.example.invalid') RETURNING id",
          [targetFirm],
        )
      ).rows[0];
      const thread = (
        await pool.query(
          "INSERT INTO message_threads(firm_id,person_id,staff_user_id,subject) VALUES($1,$2,$3,'Unread support test') RETURNING id",
          [targetFirm, person.id, targetUser],
        )
      ).rows[0];
      const msg = (
        await pool.query(
          "INSERT INTO messages(thread_id,sender_type,sender_id,body) VALUES($1,'client',$2,'Keep unread') RETURNING id",
          [thread.id, person.id],
        )
      ).rows[0];
      await pool.query(
        "INSERT INTO message_mentions(message_id,firm_user_id,firm_id) VALUES($1,$2,$3)",
        [msg.id, targetUser, targetFirm],
      );
      const result = await call("/api/messages/" + thread.id, support.token);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(
        (await pool.query("SELECT read_at FROM messages WHERE id=$1", [msg.id]))
          .rows[0].read_at,
        null,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM message_mentions WHERE message_id=$1",
            [msg.id],
          )
        ).rowCount,
        1,
      );
    },
  );
  await t.test(
    "support response removes credentials from legacy SELECT-star endpoints",
    async () => {
      await pool.query(
        "INSERT INTO companies(firm_id,realm_id,company_name,access_token,refresh_token,token_expires_at) VALUES($1,'synthetic-admin-realm','Synthetic Co','never-return-access','never-return-refresh',0)",
        [targetFirm],
      );
      const result = await call(
        "/api/relationships/all-companies",
        support.token,
      );
      assert.equal(result.status, 200);
      assert.ok(!JSON.stringify(result.body).includes("never-return"));
      const staff = await call("/firms/staff", support.token);
      assert.equal(staff.status, 200);
    },
  );
  await t.test(
    "relationship team and snapshot load in read-only support view",
    async () => {
      const team = await call("/api/relationships/" + rel.id + "/team", support.token);
      assert.equal(team.status, 200, JSON.stringify(team.body));
      const snapshot = await call("/api/relationships/" + rel.id + "/snapshot", support.token);
      assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
      assert.deepEqual(snapshot.body.active_engagements, []);
    },
  );
  await t.test(
    "credential filter keeps status fields",
    async () => {
      const { sanitize } = require("../../server/middleware/supportSession");
      assert.deepEqual(
        sanitize({ token_status: "expired", token_expires_at: 1, access_token: "x", refreshToken: "x", token: "x", token_hash: "x", nested: [{ invite_token: "x", name: "ok" }] }),
        { token_status: "expired", token_expires_at: 1, nested: [{ name: "ok" }] },
      );
    },
  );
  await t.test(
    "every support request is audited and exit records who ended it",
    async () => {
      const events = await service.sessionEvents(support.id);
      assert.ok(events.some((e) => e.path === "/api/relationships" && e.allowed && e.count >= 1));
      assert.ok(events.some((e) => e.path === "/api/new-future-route" && !e.allowed));
      const exitSession = await call("/api/platform-admin/support-sessions", admin, "POST", {
        ...input,
        reason: "Synthetic exit audit check",
      });
      assert.equal(exitSession.status, 200, JSON.stringify(exitSession.body));
      // Staff and admin tokens cannot use the support self-exit.
      assert.equal((await fetch(base + "/api/support-session", { method: "DELETE", headers: { Authorization: "Bearer " + adminToken } })).status, 404);
      assert.equal((await call("/api/support-session", exitSession.body.token, "DELETE")).status, 200);
      assert.equal((await call("/api/relationships", exitSession.body.token)).status, 401);
      const logRow = (await service.accessLog(targetFirm)).find((r) => r.id === exitSession.body.id);
      assert.equal(logRow.ended_by_name, "Platform Admin");
      assert.equal(logRow.request_count, 1);
      const viaApi = await call("/api/platform-admin/support-sessions/" + support.id + "/events", admin);
      assert.equal(viaApi.status, 200);
      assert.ok(viaApi.body.length >= 2);
      assert.equal((await call("/api/platform-admin/support-sessions/" + support.id + "/events", adminToken)).status, 401);
    },
  );
  await t.test(
    "billing validates customer ownership and returns real provider invoice amounts",
    async () => {
      const stripe = {
        customers: {
          retrieve: async () => ({
            id: "cus_admin_synthetic",
            metadata: { darklion_firm_id: String(targetFirm) },
            livemode: false,
            email: "billing@example.invalid",
          }),
        },
        invoices: {
          list: async () => ({
            data: [
              {
                id: "in_synthetic",
                created: 1,
                total: 2400,
                currency: "usd",
                status: "paid",
              },
            ],
          }),
        },
        subscriptions: {
          retrieve: async () => ({
            id: "sub_admin_synthetic",
            customer: "cus_admin_synthetic",
            status: "active",
          }),
        },
      };
      const b = await service.billing(targetFirm, stripe);
      assert.equal(b.invoices[0].amount, 2400);
      assert.match(b.dashboardUrl, /\/test\/customers\/cus_admin_synthetic$/);
      stripe.customers.retrieve = async () => ({
        id: "cus_admin_synthetic",
        metadata: { darklion_firm_id: String(otherFirm) },
      });
      await assert.rejects(
        () => service.billing(targetFirm, stripe),
        (e) => e.code === "BILLING_MISMATCH",
      );
    },
  );
  await t.test(
    "staff archival immediately invalidates support, even with unexpired JWT",
    async () => {
      await pool.query("UPDATE firm_users SET archived_at=NOW() WHERE id=$1", [
        targetUser,
      ]);
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        401,
      );
      await pool.query("UPDATE firm_users SET archived_at=NULL WHERE id=$1", [
        targetUser,
      ]);
    },
  );
  await t.test(
    "revocation and expiry are checked against persisted session state",
    async () => {
      const tv = (
        await pool.query(
          "SELECT version FROM account_security WHERE account_id=$1 AND kind='staff'",
          [targetUser],
        )
      ).rows[0].version;
      await pool.query(
        "UPDATE support_sessions SET target_version=$2 WHERE id=$1",
        [support.id, tv],
      );
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        200,
      );
      await pool.query(
        "UPDATE support_sessions SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",
        [support.id],
      );
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        401,
      );
      await pool.query(
        "UPDATE support_sessions SET expires_at=NOW()+INTERVAL '30 minutes' WHERE id=$1",
        [support.id],
      );
      assert.equal(
        (
          await call(
            "/api/platform-admin/support-sessions/" + support.id,
            admin,
            "DELETE",
          )
        ).status,
        200,
      );
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        401,
      );
      assert.equal(
        (await call("/api/platform-admin/me", admin)).status,
        200,
        "admin session remains intact",
      );
    },
  );
  await t.test(
    "revoking the original admin session invalidates support immediately",
    async () => {
      await pool.query(
        "UPDATE support_sessions SET ended_at=NULL WHERE id=$1",
        [support.id],
      );
      await pool.query(
        "UPDATE account_sessions SET revoked_at=NOW() WHERE id=$1",
        [actor.sessionId],
      );
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        401,
      );
      await pool.query(
        "UPDATE account_sessions SET revoked_at=NULL WHERE id=$1",
        [actor.sessionId],
      );
    },
  );
  await t.test(
    "target identity cannot cross firm boundaries and failed audit never grants a token",
    async () => {
      const adminActor = await service.requireAdminIdentity(admin);
      await pool.query(
        "UPDATE account_security SET last_totp_step=-1 WHERE account_id=$1 AND kind='staff'",
        [adminUser],
      );
      await assert.rejects(
        () =>
          service.startSupport(
            adminActor,
            { ...input, userId: otherUser },
          ),
        (e) => e.status === 404,
      );
      await pool.query(
        "UPDATE account_security SET last_totp_step=-1 WHERE account_id=$1 AND kind='staff'",
        [adminUser],
      );
      await pool.query(
        "ALTER TABLE support_sessions ADD CONSTRAINT synthetic_audit_failure CHECK(reason!='Synthetic rejected audit')",
      );
      await assert.rejects(
        () =>
          service.startSupport(
            adminActor,
            {
              ...input,
              reason: "Synthetic rejected audit",
            },
          ),
        (e) => e.code === "23514",
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM support_sessions WHERE reason='Synthetic rejected audit'",
          )
        ).rowCount,
        0,
      );
      await pool.query(
        "ALTER TABLE support_sessions DROP CONSTRAINT synthetic_audit_failure",
      );
    },
  );
  await t.test(
    "administrator logout revokes its session and support access",
    async () => {
      await pool.query(
        "UPDATE support_sessions SET ended_at=NULL WHERE id=$1",
        [support.id],
      );
      assert.equal(
        (await call("/api/platform-admin/logout", admin, "POST")).status,
        200,
      );
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        401,
      );
      assert.equal(
        (await call("/api/platform-admin/me", admin)).status,
        401,
      );
      assert.equal(
        (await call("/api/platform-admin/status", adminToken)).status,
        401,
        "admin sign-out also signs out the workspace login",
      );
      await pool.query(
        "UPDATE account_sessions SET revoked_at=NULL WHERE id=$1",
        [actor.sessionId],
      );
      assert.equal(
        (await call("/api/platform-admin/me", admin)).status,
        401,
        "restoring the login does not revive the unlock",
      );
      admin = await unlockAs(adminToken);
    },
  );
  await t.test(
    "revoking platform access invalidates support and administration",
    async () => {
      await pool.query(
        "UPDATE support_sessions SET ended_at=NULL WHERE id=$1",
        [support.id],
      );
      await pool.query(
        "UPDATE platform_admins SET revoked_at=NOW() WHERE user_id=$1",
        [adminUser],
      );
      assert.equal(
        (await call("/api/relationships", support.token)).status,
        401,
      );
      assert.equal(
        (await call("/api/platform-admin/firms", admin)).status,
        401,
      );
    },
  );
}
module.exports = { verifyAdminCenter };
