"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const express = require("express");
const bcrypt = require("bcrypt");

async function verifyPublicOffer(pool, t) {
  process.env.JWT_SECRET = "synthetic-public-offer-signing-key-only-32";
  process.env.DARKLION_TERMS_VERSION = "synthetic-v1";
  process.env.DARKLION_STRIPE_BASE_PRICE_ID = "price_synthetic_base";
  process.env.DARKLION_STRIPE_SEAT_PRICE_ID = "price_synthetic_seat";
  const security = require("../../server/services/accountSecurity");
  const enrollment = require("../../server/services/firmEnrollment");
  const prefs = require("../../server/services/firmPreferences");
  const subscriptions = require("../../server/services/subscriptions");
  const importService = require("../../server/services/contactImport");
  const { requireFirm } = require("../../server/middleware/requireFirm");
  const { requirePortal } = require("../../server/middleware/requirePortal");
  const password = "Synthetic-test-password-123";
  const invite = await enrollment.createInvitation({
    email: "public-owner@example.invalid",
    ledgerhqFirmId: "synthetic-member-001",
  });
  const input = {
    token: invite,
    name: "Synthetic Public Firm",
    ownerName: "Synthetic Owner",
    slug: "synthetic-public",
    password,
    acceptTerms: true,
    termsVersion: "synthetic-v1",
  };
  const results = await Promise.allSettled([
    enrollment.enroll(input),
    enrollment.enroll(input),
  ]);
  assert.equal(
    results.filter((r) => r.status === "fulfilled").length,
    1,
    "an invitation can only create one firm",
  );
  const firm = results.find((r) => r.status === "fulfilled").value.firm;
  const owner = (
    await pool.query("SELECT id FROM firm_users WHERE firm_id=$1", [firm.id])
  ).rows[0];
  const account = { firmId: firm.id, kind: "staff", accountId: owner.id };
  assert.equal(
    (await prefs.getFirmPreferences(firm.id)).staffMfaRequired,
    true,
  );
  assert.equal(
    (
      await require("../../server/services/firmFeatures").getFirmFeatures(
        firm.id,
      )
    ).embedded_chat,
    false,
  );
  const app = express();
  app.use(express.json({ limit: "600kb" }));
  app.use("/firms", require("../../server/routes/firms"));
  app.use("/portal-auth", require("../../server/routes/portal-auth"));
  app.use(
    "/api/account-security",
    requireFirm,
    require("../../server/routes/account-security"),
  );
  app.use(
    "/portal/account-security",
    requirePortal,
    require("../../server/routes/account-security"),
  );
  app.use(
    "/api/onboarding",
    requireFirm,
    require("../../server/routes/onboarding"),
  );
  app.use(
    "/api/firm-settings",
    requireFirm,
    require("../../server/routes/firm-settings"),
  );
  app.use(
    "/api/subscription",
    requireFirm,
    require("../../server/routes/subscriptions").router,
  );
  app.use(
    "/api/summaries",
    requireFirm,
    require("../../server/routes/summaries"),
  );
  app.use(
    "/portal/mobile",
    requirePortal,
    require("../../server/routes/portal-mobile"),
  );
  app.get("/api/data", requireFirm, (_req, res) => res.json({ ok: true }));
  app.post("/api/data", requireFirm, (_req, res) => res.json({ ok: true }));
  app.get("/portal/data", requirePortal, (req, res) => res.json(req.portal));
  app.use("/portal", requirePortal, require("../../server/routes/portal"));
  app.use("/enrollment", require("../../server/routes/enrollment"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  async function request(
    path,
    { token, body, method = body ? "POST" : "GET", status = 200 } = {},
  ) {
    const response = await fetch(base + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(
      response.status,
      status,
      path + " " + JSON.stringify(result).slice(0, 200),
    );
    return result;
  }
  let token, recovery, secondFirm;
  try {
    await t.test("signed membership handoff resumes existing firms and respects closed enrollment", async () => {
      process.env.LEDGERHQ_ENROLLMENT_SECRET = "synthetic-enrollment-signing-secret-only";
      const signed = (firmId, overrides = {}) => {
        const assertion = Buffer.from(JSON.stringify({ audience: "darklion-enrollment", eligible: true,
          firmId, email: "verified-owner@example.invalid", exp: Math.floor(Date.now()/1000)+300, ...overrides })).toString("base64url");
        return { assertion, signature: crypto.createHmac("sha256", process.env.LEDGERHQ_ENROLLMENT_SECRET).update(assertion).digest("hex") };
      };
      const path = "/enrollment/ledgerhq";
      await request(path, { body: { ...signed("synthetic-member-001"), signature: "0".repeat(64) }, status: 401 });
      await request(path, { body: signed("synthetic-member-001", { eligible: false }), status: 400 });
      await request(path, { body: signed("synthetic-member-001", { exp: 1 }), status: 400 });
      process.env.DARKLION_PUBLIC_ENROLLMENT = "false";
      assert.equal((await request(path, { body: signed("synthetic-member-001") })).url, "/login?firm="+firm.slug);
      await request(path, { body: signed("synthetic-member-new"), status: 403 });
      process.env.DARKLION_PUBLIC_ENROLLMENT = "true";
      process.env.DARKLION_TERMS_URL = "https://example.invalid/terms";
      process.env.DARKLION_PRIVACY_URL = "https://example.invalid/privacy";
      const invitation = await request(path, { body: signed("synthetic-member-new"), status: 201 });
      assert.match(invitation.url, /^\/join\?invitation=[A-Za-z0-9_-]+$/);
      process.env.DARKLION_PUBLIC_ENROLLMENT = "false";
    });
    await t.test(
      "MFA enrollment, replay prevention, recovery, and session revocation use actual routes",
      async () => {
        await request("/firms/register", {
          body: {
            name: "Unverified firm",
            email: "fake@unverified.example.invalid",
            password,
          },
          status: 403,
        });
        const login = await request("/firms/login", {
          body: {
            email: input.token ? "public-owner@example.invalid" : "",
            password,
          },
        });
        token = login.token;
        assert.equal(login.mfaSetupRequired, true);
        await request("/api/data", { token, status: 403 });
        const setup = await request("/api/account-security/mfa/setup", {
          token,
          body: { password },
        });
        const enabled = await request("/api/account-security/mfa/enable", {
          token,
          body: { code: security.totp(setup.secret) },
        });
        recovery = enabled.recoveryCodes;
        assert.equal(recovery.length, 10);
        await request("/api/account-security", { token, status: 401 });
        await assert.rejects(
          security.requireLoginMfa(account, security.totp(setup.secret)),
          /authenticator/,
        );
        const logged = await request("/firms/login", {
          body: {
            email: "public-owner@example.invalid",
            password,
            firmSlug: firm.slug,
            mfaCode: recovery[0],
          },
        });
        token = logged.token;
        const duplicates = await Promise.all([
          security.consumeMfa(account, recovery[1]),
          security.consumeMfa(account, recovery[1]),
        ]);
        assert.equal(duplicates.filter(Boolean).length, 1);
        await request("/api/data", { token });
        await request("/api/data", { token, body: {}, status: 402 });
        const encrypted = (
          await pool.query(
            "SELECT mfa_secret,recovery_hashes FROM account_security WHERE firm_id=$1 AND kind='staff'",
            [firm.id],
          )
        ).rows[0];
        assert.notEqual(encrypted.mfa_secret, setup.secret);
        assert.ok(!encrypted.recovery_hashes.includes(recovery[0]));
        const another = await security.createSession(
          account,
          { firmId: firm.id, userId: owner.id, type: "staff" },
          "",
          await security.requireLoginMfa(account, recovery[2]),
        );
        await request(
          "/api/account-security/sessions/" + jwt.decode(another).sid,
          { token, method: "DELETE" },
        );
        await request("/api/data", { token: another, status: 401 });
        await assert.rejects(
          security.createSession(account, {
            firmId: firm.id,
            userId: owner.id,
            type: "staff",
          }),
          /authenticator/,
        );
      },
    );
    await t.test(
      "imports are atomic, repeatable, firm scoped, and send no invitations",
      async () => {
        const csv =
          "relationship,first_name,last_name,email,phone,company_name\nPublic Household,Synthetic,Client,shared-client@example.invalid,,Public Company\n";
        const preview = await request("/api/onboarding/import", {
          token,
          body: { csv, dryRun: true },
        });
        assert.equal(preview.valid, true);
        const result = await request("/api/onboarding/import", {
          token,
          body: { csv, key: "synthetic-import-0001" },
        });
        assert.equal(result.created, 1);
        const replay = await request("/api/onboarding/import", {
          token,
          body: { csv, key: "synthetic-import-0001" },
        });
        assert.equal(replay.replayed, true);
        await request("/api/onboarding/import", {
          token,
          body: {
            csv: csv.replace("Synthetic", "Other"),
            key: "synthetic-import-0001",
          },
          status: 400,
        });
        const person = (
          await pool.query("SELECT * FROM people WHERE firm_id=$1", [firm.id])
        ).rows[0];
        assert.equal(person.portal_enabled, false);
        assert.equal(person.portal_invite_token, null);
        const exportData = await request("/api/onboarding/export", { token });
        assert.equal(exportData.people.length, 1);
        assert.equal(exportData.companies.length, 1);
        assert.equal(exportData.people[0].portal_password_hash, undefined);
        const info = await request("/api/onboarding", { token });
        assert.equal(info.counts.contacts, 1);
        await request("/api/firm-settings", {
          token,
          method: "PUT",
          body: { staffMfaRequired: false },
          status: 400,
        });
      },
    );
    await t.test(
      "unique logins, preferences, Stripe keys, and data requests stay in their owning firm",
      async () => {
        const invitation = await enrollment.createInvitation({
          email: "public-beta@example.invalid",
          ledgerhqFirmId: "synthetic-member-002",
        });
        secondFirm = (
          await enrollment.enroll({
            ...input,
            token: invitation,
            slug: "synthetic-public-beta",
            name: "Synthetic Beta",
          })
        ).firm;
        const foreign = (
          await pool.query("SELECT id FROM firm_users WHERE firm_id=$1", [
            secondFirm.id,
          ])
        ).rows[0];
        await request("/api/firm-settings", {
          token,
          method: "PUT",
          body: { staffContactOrder: [foreign.id] },
          status: 400,
        });
        await request("/api/firm-settings/notification-routes", {
          token,
          method: "PUT",
          body: {
            routes: [{ folder_category: "tax", staff_user_id: foreign.id }],
          },
          status: 400,
        });
        await request("/api/firm-settings/notification-routes", {
          token,
          method: "PUT",
          body: {
            routes: [{ folder_category: "tax", staff_user_id: owner.id }],
          },
        });
        await request('/firms/branding', {
          token, method: 'PUT', body: { portal_logo_style: 'icon' },
        });
        assert.equal((await request('/firms/branding', { token })).portal_logo_style, 'icon');
        assert.equal((await pool.query('SELECT portal_logo_style FROM firms WHERE id=$1', [secondFirm.id])).rows[0].portal_logo_style, null);
        await request('/firms/branding', {
          token, method: 'PUT', body: { portal_logo_style: 'invalid' }, status: 400,
        });
        const req = await request("/api/account-security/data-requests", {
          token,
          body: { kind: "deletion", note: "Synthetic request" },
          status: 201,
        });
        assert.equal(
          (await request("/api/firm-settings/data-requests", { token }))[0].id,
          req.id,
        );
        const integrations = require("../../server/services/firmIntegrations");
        process.env.STRIPE_SECRET_KEY = "synthetic-never-sent";
        assert.deepEqual(await integrations.stripeAccounts(firm.id), []);
        delete process.env.STRIPE_SECRET_KEY;
        await assert.rejects(pool.query(
          "UPDATE firm_users SET email=$1,password_hash=$2 WHERE id=$3",
          ["public-owner@example.invalid", await bcrypt.hash(password, 4), foreign.id],
        ), { code: '23505', constraint: 'login_identity_single_firm' });
        const scoped = await request("/firms/login", {
          body: { email: "public-beta@example.invalid", password, firmSlug: firm.slug },
        });
        assert.equal(scoped.firm.id, secondFirm.id);
        await assert.rejects(importService.importContacts({
          firmId: secondFirm.id,
          csv: "relationship,first_name,last_name,email\nBeta,Other,Client,shared-client@example.invalid\n",
          key: "synthetic-import-0002",
        }), { code: '23505' });
        // Staff may also have client access within their own firm.
        await pool.query(
          "INSERT INTO people(firm_id,first_name,email,portal_enabled,portal_password_hash) VALUES($1,'Staff client',$2,true,$3)",
          [secondFirm.id, "public-beta@example.invalid", await bcrypt.hash(password, 4)],
        );
        const portalLogin = await request("/portal-auth/login", {
          body: { email: "public-beta@example.invalid", password, firmSlug: firm.slug },
        });
        assert.equal(portalLogin.person.firmId, secondFirm.id);
      },
    );
    await t.test(
      "subscription events are idempotent and status controls writes without blocking exports",
      async () => {
        await pool.query(
          "INSERT INTO darklion_subscriptions(firm_id,customer_id) VALUES($1,'cus_synthetic')",
          [firm.id],
        );
        let status = "active";
        const stripe = {
          subscriptions: {
            retrieve: async () => ({
              id: "sub_synthetic",
              customer: "cus_synthetic",
              status,
              metadata: { darklion_firm_id: String(firm.id) },
              items: {
                data: [
                  {
                    id: "item_base",
                    price: { id: "price_synthetic_base" },
                    quantity: 1,
                  },
                  {
                    id: "item_seats",
                    price: { id: "price_synthetic_seat" },
                    quantity: 1,
                    current_period_end: 1800000000,
                  },
                ],
              },
            }),
          },
        };
        const event = {
          id: "evt_synthetic_active",
          type: "customer.subscription.updated",
          data: { object: { id: "sub_synthetic" } },
        };
        assert.equal(
          (await subscriptions.handleSubscriptionEvent(event, stripe)).ok,
          true,
        );
        assert.equal(
          (await subscriptions.handleSubscriptionEvent(event, stripe))
            .duplicate,
          true,
        );
        await request("/api/data", { token, body: {} });
        assert.equal(
          (await request("/api/subscription", { token })).monthlyCents,
          2400,
        );
        status = "canceled";
        await subscriptions.handleSubscriptionEvent(
          { ...event, id: "evt_synthetic_cancel" },
          stripe,
        );
        await request("/api/data", { token, body: {}, status: 402 });
        await request("/api/onboarding/export", { token });
        // An event for the old cancelled subscription cannot replace its active successor.
        await pool.query(
          "UPDATE darklion_subscriptions SET subscription_id='sub_successor',status='active' WHERE firm_id=$1",
          [firm.id],
        );
        const previous = stripe.subscriptions.retrieve;
        stripe.subscriptions.retrieve = async (id) => ({
          ...(await previous()),
          id,
          status: id === "sub_successor" ? "active" : "canceled",
        });
        assert.equal(
          (
            await subscriptions.handleSubscriptionEvent(
              { ...event, id: "evt_late_old" },
              stripe,
            )
          ).ignored,
          true,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT subscription_id FROM darklion_subscriptions WHERE firm_id=$1",
              [firm.id],
            )
          ).rows[0].subscription_id,
          "sub_successor",
        );
        await pool.query(
          "UPDATE darklion_subscriptions SET status='canceled' WHERE firm_id=$1",
          [firm.id],
        );
      },
    );
    await t.test(
      "public summary readers enforce current membership on web and agent API",
      async () => {
        const person = (
          await pool.query("SELECT id FROM people WHERE firm_id=$1", [firm.id])
        ).rows[0];
        const colleague = (
          await pool.query(
            "INSERT INTO firm_users(firm_id,email,name,role,accepted_at) VALUES($1,'summary-colleague@example.invalid','Colleague','staff',NOW()) RETURNING id",
            [firm.id],
          )
        ).rows[0];
        const thread = (
          await pool.query(
            "INSERT INTO message_threads(firm_id,person_id,staff_user_id,subject) VALUES($1,$2,$3,'Private') RETURNING id",
            [firm.id, person.id, colleague.id],
          )
        ).rows[0];
        const summary = {
          date: "2026-09-24",
          by_staff: [
            {
              staff_user_id: colleague.id,
              staff_name: "Colleague",
              threads: [
                {
                  thread_id: thread.id,
                  staff_user_id: colleague.id,
                  visible_staff_ids: [colleague.id, owner.id],
                  bullets: "Synthetic private context",
                },
              ],
            },
          ],
          team_chats: [],
        };
        await pool.query(
          "INSERT INTO conversation_summaries(firm_id,summary_date,summary_json) VALUES($1,$2,$3)",
          [firm.id, summary.date, summary],
        );
        const agent = require("../../server/services/agentCommunications");
        const get = () =>
          agent.getConversationSummary({
            firmId: firm.id,
            staffUserId: owner.id,
            date: summary.date,
          });
        assert.equal((await get()).thread_count, 0);
        await pool.query(
          "INSERT INTO thread_participants(thread_id,firm_id,firm_user_id) VALUES($1,$2,$3)",
          [thread.id, firm.id, owner.id],
        );
        assert.equal((await get()).thread_count, 1);
        assert.equal(
          (await request("/api/summaries/" + summary.date, { token }))
            .summary_json.thread_count,
          1,
        );
        await pool.query(
          "UPDATE thread_participants SET archived_at=NOW() WHERE thread_id=$1",
          [thread.id],
        );
        assert.equal((await get()).thread_count, 0);
        assert.equal(
          (await request("/api/summaries/" + summary.date, { token }))
            .summary_json.thread_count,
          0,
        );
        await pool.query(
          "UPDATE firm_users SET archived_at=NOW() WHERE id=$1",
          [colleague.id],
        );
      },
    );
    await t.test(
      "staff seat reconciliation ignores logins and preserves simultaneous changes",
      async () => {
        const before = (
          await pool.query(
            "SELECT revision FROM subscription_seat_sync WHERE firm_id=$1",
            [firm.id],
          )
        ).rows[0].revision;
        await pool.query(
          "UPDATE firm_users SET last_login_at=NOW() WHERE id=$1",
          [owner.id],
        );
        assert.equal(
          (
            await pool.query(
              "SELECT revision FROM subscription_seat_sync WHERE firm_id=$1",
              [firm.id],
            )
          ).rows[0].revision,
          before,
        );
        const teammate = (
          await pool.query(
            "INSERT INTO firm_users(firm_id,email,name,role,accepted_at) VALUES($1,'billing-colleague@example.invalid','Billing colleague','staff',NOW()) RETURNING id",
            [firm.id],
          )
        ).rows[0];
        const current = (
          await pool.query(
            "SELECT revision FROM subscription_seat_sync WHERE firm_id=$1",
            [firm.id],
          )
        ).rows[0].revision;
        assert.ok(Number(current) > Number(before));
        assert.equal(
          (
            await pool.query(
              "DELETE FROM subscription_seat_sync WHERE firm_id=$1 AND revision=$2",
              [firm.id, before],
            )
          ).rowCount,
          0,
        );
        await pool.query(
          "UPDATE darklion_subscriptions SET status='active' WHERE firm_id=$1",
          [firm.id],
        );
        let quantity = 1,
          updates = 0;
        const stripe = {
          subscriptions: {
            retrieve: async () => ({
              id: "sub_successor",
              status: "active",
              items: {
                data: [
                  {
                    id: "seat-item",
                    quantity,
                    price: { id: "price_synthetic_seat" },
                  },
                ],
              },
            }),
            update: async (_id, body) => {
              quantity = body.items[0].quantity;
              updates++;
            },
          },
        };
        await Promise.all([
          subscriptions.syncSeats(firm.id, stripe),
          subscriptions.syncSeats(firm.id, stripe),
        ]);
        assert.equal(quantity, 2);
        assert.equal(updates, 1);
        await pool.query(
          "UPDATE firm_users SET archived_at=NOW() WHERE id=$1",
          [teammate.id],
        );
        await subscriptions.syncSeats(firm.id, stripe);
        assert.equal(quantity, 1);
        await pool.query(
          "UPDATE darklion_subscriptions SET status='canceled' WHERE firm_id=$1",
          [firm.id],
        );
      },
    );
    await t.test(
      "ordinary staff cannot manage credentials, domains, or another staff profile",
      async () => {
        const staff = (
          await pool.query(
            "INSERT INTO firm_users(firm_id,email,name,role,accepted_at) VALUES($1,'ordinary@example.invalid','Ordinary','staff',NOW()) RETURNING id",
            [firm.id],
          )
        ).rows[0];
        await pool.query(
          "UPDATE firm_preferences SET settings=settings || '{\"staffMfaRequired\":false}' WHERE firm_id=$1",
          [firm.id],
        );
        const staffToken = await security.createSession(
          { firmId: firm.id, kind: "staff", accountId: staff.id },
          { firmId: firm.id, userId: staff.id, type: "staff" },
        );
        for (const path of ["/firms/api-tokens", "/firms/domains"])
          await request(path, { token: staffToken, status: 403 });
        for (const path of ["/firms/api-tokens", "/firms/domains"])
          await request(path, { token: staffToken, body: {}, status: 402 });
        await request("/firms/team/" + owner.id + "/display-name", {
          token: staffToken,
          method: "PUT",
          body: { display_name: "Changed" },
          status: 403,
        });
        await request("/firms/team/" + staff.id + "/display-name", {
          token: staffToken,
          method: "PUT",
          body: { display_name: "Ordinary Staff" },
        });
        await pool.query(
          "UPDATE firm_preferences SET settings=settings || '{\"staffMfaRequired\":true}' WHERE firm_id=$1",
          [firm.id],
        );
        await pool.query(
          "UPDATE firm_users SET archived_at=NOW() WHERE id=$1",
          [staff.id],
        );
      },
    );
    await t.test(
      "scheduled summaries honor local time and do not requeue completed work",
      async () => {
        const jobs = require("../../server/services/summaryJobs");
        await prefs.updateFirmPreferences(firm.id, {
          timezone: "America/Los_Angeles",
        });
        await pool.query(
          "UPDATE darklion_subscriptions SET status='active' WHERE firm_id=$1",
          [firm.id],
        );
        await jobs.enqueueDueSummaries(pool, new Date("2026-09-27T04:00:00Z"));
        const before = (
          await pool.query(
            "SELECT id,status,summary_date::text FROM summary_jobs WHERE firm_id=$1 AND summary_date='2026-09-25'",
            [firm.id],
          )
        ).rows[0];
        assert.ok(before);
        await pool.query(
          "UPDATE summary_jobs SET status='completed' WHERE id=$1",
          [before.id],
        );
        await jobs.enqueueDueSummaries(pool, new Date("2026-09-27T04:00:00Z"));
        assert.equal(
          (
            await pool.query("SELECT status FROM summary_jobs WHERE id=$1", [
              before.id,
            ])
          ).rows[0].status,
          "completed",
        );
        await jobs.enqueueDueSummaries(pool, new Date("2026-09-27T05:00:00Z"));
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM summary_jobs WHERE firm_id=$1 AND summary_date='2026-09-26'",
              [firm.id],
            )
          ).rowCount,
          1,
        );
        await pool.query("UPDATE summary_jobs SET status='completed'");
        await pool.query(
          "UPDATE darklion_subscriptions SET status='canceled' WHERE firm_id=$1",
          [firm.id],
        );
      },
    );
    await t.test(
      "portal account and spouse revocation do not cross identities; passwords revoke old staff sessions",
      async () => {
        const person = (
          await pool.query("SELECT id FROM people WHERE firm_id=$1", [firm.id])
        ).rows[0];
        await pool.query(
          "UPDATE people SET portal_enabled=TRUE,spouse_portal_enabled=TRUE,spouse_email='spouse@example.invalid' WHERE id=$1",
          [person.id],
        );
        const primaryAccount = {
            firmId: firm.id,
            kind: "portal",
            accountId: person.id,
          },
          spouseAccount = { ...primaryAccount, signerRole: "spouse" };
        const primary = await security.createSession(primaryAccount, {
          firmId: firm.id,
          personId: person.id,
          type: "portal",
          signerRole: "taxpayer",
        });
        const spouse = await security.createSession(spouseAccount, {
          firmId: firm.id,
          personId: person.id,
          type: "portal",
          signerRole: "spouse",
        });
        await request("/portal/data", { token: primary });
        await request("/portal/data", { token: spouse });
        await pool.query("UPDATE firm_users SET display_name='' WHERE id=$1", [owner.id]);
        const staffNames = await request('/portal/firm-team', { token: primary });
        assert.equal(staffNames.find(s => s.id === owner.id).name, 'Synthetic Owner');
        const contacts = await request('/portal/messages', { token: primary });
        assert.equal(contacts.find(s => s.id === owner.id).name, 'Synthetic Owner');
        await pool.query("UPDATE firm_users SET display_name='Preferred Owner' WHERE id=$1", [owner.id]);
        assert.equal((await request('/portal/firm-team', { token: primary })).find(s => s.id === owner.id).name, 'Preferred Owner');
        await pool.query("UPDATE firm_users SET display_name='' WHERE id=$1", [owner.id]);
        const delivery = (await pool.query(
          "INSERT INTO tax_deliveries(firm_id,title,tax_year,status,created_by) VALUES($1,'Synthetic mobile return','2025','sent',$2) RETURNING id",
          [firm.id, owner.id],
        )).rows[0];
        await pool.query(
          "INSERT INTO tax_delivery_signers(delivery_id,person_id,signer_role) VALUES($1,$2,'taxpayer')",
          [delivery.id, person.id],
        );
        const packet = await request('/portal/mobile/tax-deliveries/'+delivery.id,{token:primary});
        assert.equal(packet.delivery.firmName, (await prefs.getFirmPreferences(firm.id)).name);
        assert.equal(packet.delivery.preparer.name, 'Synthetic Owner');
        assert.ok(packet.consentLanguage.includes(packet.delivery.firmName));
        assert.ok(!packet.consentLanguage.includes('Example Legacy Firm'));
        const device = await request("/portal/mobile/devices", {
          token: spouse,
          body: {
            pushToken: "ExpoPushToken[synthetic-spouse]",
            platform: "ios",
          },
          status: 201,
        });
        const push = (
          await pool.query(
            "SELECT session_id,signer_role FROM portal_mobile_devices WHERE id=$1",
            [device.device.id],
          )
        ).rows[0];
        assert.equal(push.session_id, jwt.decode(spouse).sid);
        assert.equal(push.signer_role, "spouse");
        await request("/api/data", { token: primary, status: 401 });
        await pool.query(
          "UPDATE people SET spouse_portal_enabled=FALSE WHERE id=$1",
          [person.id],
        );
        assert.ok(
          (
            await pool.query(
              "SELECT disabled_at FROM portal_mobile_devices WHERE id=$1",
              [device.device.id],
            )
          ).rows[0].disabled_at,
        );
        await request("/portal/data", { token: spouse, status: 401 });
        await request("/portal/data", { token: primary });
        await pool.query(
          "UPDATE people SET portal_password_hash=$1 WHERE id=$2",
          ["synthetic-changed-hash", person.id],
        );
        await request("/portal/data", { token: primary, status: 401 });
        await pool.query("UPDATE firm_users SET password_hash=$1 WHERE id=$2", [
          "synthetic-changed-hash",
          owner.id,
        ]);
        await request("/api/data", { token, status: 401 });
      },
    );
    await t.test(
      "daily summaries survive duplicate enqueue and worker restart and recheck AI preference",
      async () => {
        const jobs = require("../../server/services/summaryJobs");
        const first = await jobs.enqueueSummary(firm.id, "2026-09-25");
        assert.equal(
          (await jobs.enqueueSummary(firm.id, "2026-09-25")).id,
          first.id,
        );
        await pool.query(
          "UPDATE summary_jobs SET status='running',leased_until=NOW()-INTERVAL '1 minute' WHERE id=$1",
          [first.id],
        );
        let calls = 0;
        await jobs.processSummaryJob(pool, async (id, date) => {
          assert.equal(id, firm.id);
          assert.equal(date, "2026-09-25");
          calls++;
        });
        assert.equal(calls, 1);
        assert.equal(
          (
            await pool.query("SELECT status FROM summary_jobs WHERE id=$1", [
              first.id,
            ])
          ).rows[0].status,
          "completed",
        );
        await prefs.updateFirmPreferences(firm.id, { aiEnabled: false });
        await assert.rejects(
          require("../../server/services/managedInference").completeText({
            firmId: firm.id,
            feature: "test",
            prompt: "Do not run",
          }),
          /disabled/,
        );
      },
    );
    await t.test(
      "direct website signup emails a single-use link and reaches checkout without LedgerHQ",
      async () => {
        const emailService = require("../../server/services/email");
        const original = emailService.sendEmail;
        const sent = [];
        emailService.sendEmail = async (message) => {
          sent.push(message);
          return { ok: true };
        };
        try {
          process.env.DARKLION_PUBLIC_ENROLLMENT = "false";
          await request("/enrollment/start", { body: { email: "direct-owner@example.invalid" }, status: 403 });
          process.env.DARKLION_PUBLIC_ENROLLMENT = "true";
          await request("/enrollment/start", { body: { email: "not-an-email" }, status: 400 });
          // Existing accounts get the same response and a sign-in email, never a new workspace link.
          assert.deepEqual(
            await request("/enrollment/start", { body: { email: "PUBLIC-OWNER@example.invalid" } }),
            { ok: true, email: "public-owner@example.invalid" },
          );
          assert.equal(sent.at(-1).subject, "You already have a DarkLion account");
          assert.doesNotMatch(sent.at(-1).html, /invitation=/);
          assert.deepEqual(
            await request("/enrollment/start", { body: { email: " Direct-Owner@example.invalid " } }),
            { ok: true, email: "direct-owner@example.invalid" },
          );
          assert.equal(sent.at(-1).to, "direct-owner@example.invalid");
          const link = sent.at(-1).html.match(/\/join\?invitation=([A-Za-z0-9_-]+)/)[1];
          assert.deepEqual(
            (
              await pool.query(
                "SELECT source, ledgerhq_firm_id, expires_at < NOW()+INTERVAL '49 hours' AS short FROM firm_enrollment_invitations WHERE token_hash=$1",
                [enrollment.hash(link)],
              )
            ).rows[0],
            { source: "direct", ledgerhq_firm_id: null, short: true },
          );
          assert.equal(
            (await request("/enrollment/invitation/" + link)).email,
            "direct-owner@example.invalid",
          );
          for (let i = 0; i < 3; i++)
            await enrollment.createInvitation({ email: "throttled@example.invalid", source: "direct" });
          const before = sent.length;
          await request("/enrollment/start", { body: { email: "throttled@example.invalid" } });
          assert.equal(sent.length, before, "repeated requests for one address stop sending");
          const direct = await enrollment.enroll({
            token: link,
            name: "Direct Signup Firm",
            ownerName: "Direct Owner",
            slug: "direct-signup",
            password,
            acceptTerms: true,
            termsVersion: "synthetic-v1",
          });
          await assert.rejects(enrollment.enroll({
            token: link, name: "Replay Firm", ownerName: "Replay", slug: "direct-replay",
            password, acceptTerms: true, termsVersion: "synthetic-v1",
          }), /expired or already used/);
          const stripe = {
            prices: {
              retrieve: async (id) => ({
                active: true,
                currency: "usd",
                unit_amount: id === process.env.DARKLION_STRIPE_BASE_PRICE_ID ? 1900 : 500,
                recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
              }),
            },
            customers: { create: async () => ({ id: "cus_synthetic_direct" }) },
            checkout: {
              sessions: {
                list: async () => ({ data: [] }),
                expire: async () => {},
                create: async (params) => {
                  assert.deepEqual(params.line_items.map((l) => l.quantity), [1, 1]);
                  return { url: "https://checkout.stripe.com/c/pay/synthetic-direct" };
                },
              },
            },
          };
          assert.equal(
            (await subscriptions.checkout(direct.firm.id, stripe)).url,
            "https://checkout.stripe.com/c/pay/synthetic-direct",
          );
          const login = await request("/firms/login", {
            body: { email: "direct-owner@example.invalid", password },
          });
          assert.equal(login.mfaSetupRequired, true);
          assert.equal(login.setupRequired, true, "unpaid owners land on workspace setup");
        } finally {
          emailService.sendEmail = original;
          process.env.DARKLION_PUBLIC_ENROLLMENT = "false";
        }
      },
    );

  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
}
module.exports = { verifyPublicOffer };
