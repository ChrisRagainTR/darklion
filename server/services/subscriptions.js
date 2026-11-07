"use strict";
const { pool } = require("../db");
const { getFirmPreferences } = require("./firmPreferences");
const BASE_MONTHLY_CENTS = 1900,
  STAFF_MONTHLY_CENTS = 500;
function stripeClient() {
  if (!process.env.DARKLION_STRIPE_SECRET_KEY)
    throw Object.assign(Error("DarkLion subscriptions are not configured"), {
      status: 503,
    });
  return require("stripe")(process.env.DARKLION_STRIPE_SECRET_KEY, {
    timeout: 15000,
    maxNetworkRetries: 1,
  });
}
function appOrigin() {
  const url = new URL(
    process.env.PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:8080",
  );
  if (
    url.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw Error("Invalid application URL");
  return url.origin;
}
async function activeSeats(firmId, db = pool) {
  return Number(
    (
      await db.query(
        "SELECT COUNT(*)::int AS seats FROM firm_users WHERE firm_id=$1 AND archived_at IS NULL AND accepted_at IS NOT NULL AND role!='agent'",
        [firmId],
      )
    ).rows[0].seats,
  );
}
async function subscriptionStatus(firmId, db = pool) {
  const prefs = await getFirmPreferences(firmId, db),
    seats = await activeSeats(firmId, db);
  const sub = (
    await db.query(
      "SELECT status,seat_quantity,current_period_end,cancel_at_period_end FROM darklion_subscriptions WHERE firm_id=$1",
      [firmId],
    )
  ).rows[0];
  return {
    status: sub?.status || "unsubscribed",
    existingFirm: prefs.edition !== "public",
    seats,
    baseMonthlyCents: BASE_MONTHLY_CENTS,
    staffMonthlyCents: STAFF_MONTHLY_CENTS,
    monthlyCents: BASE_MONTHLY_CENTS + STAFF_MONTHLY_CENTS * seats,
    billedSeats: sub?.seat_quantity || 0,
    currentPeriodEnd: sub?.current_period_end || null,
    cancelAtPeriodEnd: sub?.cancel_at_period_end || false,
    configured: !!(
      process.env.DARKLION_STRIPE_SECRET_KEY &&
      process.env.DARKLION_STRIPE_BASE_PRICE_ID &&
      process.env.DARKLION_STRIPE_SEAT_PRICE_ID
    ),
  };
}
async function checkout(firmId, stripe = stripeClient()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const firm = (
      await client.query(
        "SELECT id,name,email FROM firms WHERE id=$1 FOR UPDATE",
        [firmId],
      )
    ).rows[0];
    if (!firm) throw Error("Firm not found");
    const prefs = await getFirmPreferences(firmId, client);
    if (prefs.edition !== "public")
      throw Object.assign(
        Error(
          "Existing firms are not automatically enrolled in paid subscriptions",
        ),
        { status: 409 },
      );
    const eligibility = (
      await client.query(
        "SELECT 1 FROM firm_enrollment_invitations WHERE firm_id=$1 AND accepted_at IS NOT NULL",
        [firmId],
      )
    ).rowCount;
    if (!eligibility)
      throw Object.assign(Error("LedgerHQ member eligibility required"), {
        status: 403,
      });
    let sub = (
      await client.query(
        "SELECT * FROM darklion_subscriptions WHERE firm_id=$1 FOR UPDATE",
        [firmId],
      )
    ).rows[0];
    if (
      sub?.subscription_id &&
      !["canceled", "incomplete_expired"].includes(sub.status)
    )
      throw Object.assign(
        Error("Manage your existing subscription from billing"),
        { status: 409 },
      );
    const priceIds = [
      process.env.DARKLION_STRIPE_BASE_PRICE_ID,
      process.env.DARKLION_STRIPE_SEAT_PRICE_ID,
    ];
    if (priceIds.some((id) => !id))
      throw Object.assign(Error("Subscription prices are not configured"), {
        status: 503,
      });
    const prices = await Promise.all(
      priceIds.map((id) => stripe.prices.retrieve(id)),
    );
    prices.forEach((p, i) => {
      if (
        !p.active ||
        p.currency !== "usd" ||
        p.unit_amount !== [1900, 500][i] ||
        p.recurring?.interval !== "month" ||
        p.recurring?.interval_count !== 1 ||
        p.recurring?.usage_type !== "licensed"
      )
        throw Error("Configured prices do not match the member offer");
    });
    if (!sub?.customer_id) {
      const customer = await stripe.customers.create(
        {
          email: firm.email,
          name: firm.name,
          metadata: { darklion_firm_id: String(firmId) },
        },
        { idempotencyKey: `darklion-firm-${firmId}` },
      );
      await client.query(
        "INSERT INTO darklion_subscriptions(firm_id,customer_id) VALUES($1,$2) ON CONFLICT(firm_id) DO UPDATE SET customer_id=EXCLUDED.customer_id",
        [firmId, customer.id],
      );
      sub = { ...sub, customer_id: customer.id };
    }
    const seats = await activeSeats(firmId, client);
    const open = await stripe.checkout.sessions.list({
      customer: sub.customer_id,
      status: "open",
      limit: 10,
    });
    let session;
    for (const candidate of open.data.filter(
      (s) =>
        s.mode === "subscription" &&
        s.metadata?.darklion_firm_id === String(firmId),
    )) {
      if (!session && candidate.metadata?.darklion_seats === String(seats))
        session = candidate;
      else await stripe.checkout.sessions.expire(candidate.id);
    }
    if (!session)
      session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: sub.customer_id,
        client_reference_id: String(firmId),
        metadata: {
          darklion_firm_id: String(firmId),
          darklion_seats: String(seats),
        },
        subscription_data: { metadata: { darklion_firm_id: String(firmId) } },
        line_items: [
          { price: priceIds[0], quantity: 1 },
          { price: priceIds[1], quantity: seats },
        ],
        success_url: appOrigin() + "/workspace-setup?billing=success",
        cancel_url: appOrigin() + "/workspace-setup?billing=cancelled",
      });
    await client.query("COMMIT");
    return { url: session.url };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
async function billingPortal(firmId, stripe = stripeClient()) {
  const sub = (
    await pool.query(
      "SELECT customer_id FROM darklion_subscriptions WHERE firm_id=$1",
      [firmId],
    )
  ).rows[0];
  if (!sub?.customer_id) throw Error("No subscription customer yet");
  return stripe.billingPortal.sessions.create({
    customer: sub.customer_id,
    return_url: appOrigin() + "/workspace-setup",
  });
}
async function syncSeats(firmId, stripe = stripeClient()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sub = (
      await client.query(
        "SELECT * FROM darklion_subscriptions WHERE firm_id=$1 FOR UPDATE",
        [firmId],
      )
    ).rows[0];
    if (!sub?.subscription_id || !["active", "trialing"].includes(sub.status)) {
      await client.query("COMMIT");
      return { skipped: true };
    }
    const current = await stripe.subscriptions.retrieve(sub.subscription_id);
    if (!["active", "trialing"].includes(current.status)) {
      await client.query("COMMIT");
      return { skipped: true };
    }
    const item = current.items.data.find(
      (i) => i.price.id === process.env.DARKLION_STRIPE_SEAT_PRICE_ID,
    );
    if (!item) throw Error("Subscription seat item missing");
    const seats = await activeSeats(firmId, client);
    if (item.quantity !== seats)
      await stripe.subscriptions.update(current.id, {
        items: [{ id: item.id, quantity: seats }],
        proration_behavior: "create_prorations",
      });
    await client.query(
      "UPDATE darklion_subscriptions SET seat_quantity=$2,updated_at=NOW() WHERE firm_id=$1",
      [firmId, seats],
    );
    await client.query("COMMIT");
    return { seats };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
async function processSeatChanges() {
  if (!process.env.DARKLION_STRIPE_SECRET_KEY) return;
  const rows = (
    await pool.query(
      "SELECT firm_id,revision FROM subscription_seat_sync WHERE next_attempt_at<=NOW() ORDER BY next_attempt_at LIMIT 20",
    )
  ).rows;
  for (const row of rows) {
    try {
      await syncSeats(row.firm_id);
      await pool.query(
        "DELETE FROM subscription_seat_sync WHERE firm_id=$1 AND revision=$2",
        [row.firm_id, row.revision],
      );
    } catch (_) {
      await pool.query(
        "UPDATE subscription_seat_sync SET attempts=attempts+1,next_attempt_at=NOW()+INTERVAL '5 minutes' WHERE firm_id=$1 AND revision=$2",
        [row.firm_id, row.revision],
      );
    }
  }
}
function startSeatWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processSeatChanges();
    } catch (_) {
      console.error("[subscriptions] seat reconciliation failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
async function handleSubscriptionEvent(
  event,
  stripe = stripeClient(),
  db = pool,
) {
  if (
    ![
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ].includes(event.type)
  )
    return { ignored: true };
  const object = event.data.object;
  const subscriptionId =
    event.type === "checkout.session.completed"
      ? object.subscription
      : object.id;
  if (
    !subscriptionId ||
    (event.type === "checkout.session.completed" &&
      object.mode !== "subscription")
  )
    return { ignored: true };
  // Read current provider state, so delayed events cannot restore old access.
  let subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const receipt = await client.query(
      "INSERT INTO subscription_events(id) VALUES($1) ON CONFLICT DO NOTHING RETURNING id",
      [event.id],
    );
    if (!receipt.rowCount) {
      await client.query("ROLLBACK");
      return { duplicate: true };
    }
    const row = (
      await client.query(
        "SELECT firm_id,subscription_id FROM darklion_subscriptions WHERE customer_id=$1 FOR UPDATE",
        [customerId],
      )
    ).rows[0];
    // Provider reads must occur after the local customer lock. Otherwise a
    // slower earlier webhook could commit stale access after a cancellation.
    subscription = await stripe.subscriptions.retrieve(subscriptionId);
    const latestCustomer =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    if (latestCustomer !== customerId)
      throw Error("Subscription customer changed");
    if (!row || String(row.firm_id) !== subscription.metadata?.darklion_firm_id)
      throw Error("Subscription customer ownership mismatch");
    if (row.subscription_id && row.subscription_id !== subscription.id) {
      const old = await stripe.subscriptions.retrieve(row.subscription_id);
      if (
        !["canceled", "incomplete_expired"].includes(old.status) ||
        ["canceled", "incomplete_expired"].includes(subscription.status)
      ) {
        await client.query("COMMIT");
        return { ignored: true };
      }
    }
    const seat = subscription.items.data.find(
      (i) => i.price.id === process.env.DARKLION_STRIPE_SEAT_PRICE_ID,
    );
    const base = subscription.items.data.find(
      (i) => i.price.id === process.env.DARKLION_STRIPE_BASE_PRICE_ID,
    );
    if (!seat || !base || base.quantity !== 1)
      throw Error("Subscription prices do not match configured offer");
    const period = subscription.current_period_end || seat.current_period_end;
    await client.query(
      `UPDATE darklion_subscriptions SET subscription_id=$2,status=$3,seat_quantity=$4,current_period_end=$5,cancel_at_period_end=$6,updated_at=NOW() WHERE firm_id=$1`,
      [
        row.firm_id,
        subscription.id,
        subscription.status,
        seat.quantity,
        period ? new Date(period * 1000) : null,
        !!subscription.cancel_at_period_end,
      ],
    );
    await client.query(
      "INSERT INTO subscription_seat_sync(firm_id) VALUES($1) ON CONFLICT(firm_id) DO UPDATE SET revision=subscription_seat_sync.revision+1,next_attempt_at=NOW()",
      [row.firm_id],
    );
    await client.query("COMMIT");
    return { ok: true, firmId: row.firm_id };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
async function requireSubscription(req, res, next) {
  try {
    const prefs = await getFirmPreferences(req.firm.id);
    if (
      prefs.edition !== "public" ||
      ["GET", "HEAD", "OPTIONS"].includes(req.method)
    )
      return next();
    const path = req.originalUrl || "";
    if (/^\/portal\/(account-security|mobile\/(devices|logout|notification-preferences))([/?]|$)/.test(path) || path === '/pusher/auth/portal') return next();
    if (
      /^\/api\/(account-security|firm-settings|subscription|onboarding)([/?]|$)/.test(
        path,
      ) ||
      /^\/firms\/(branding|integrations|invite|team)([/?]|$)/.test(path) ||
      /^\/api\/mobile\/(devices|logout|notification-preferences)([/?]|$)/.test(
        path,
      )
    )
      return next();
    const sub = (
      await pool.query(
        "SELECT status FROM darklion_subscriptions WHERE firm_id=$1",
        [req.firm.id],
      )
    ).rows[0];
    if (!["active", "trialing"].includes(sub?.status))
      return res
        .status(402)
        .json({
          error:
            "Activate your DarkLion subscription to make changes. Existing records remain available.",
          code: "SUBSCRIPTION_REQUIRED",
        });
    next();
  } catch (_) {
    res.status(503).json({ error: "Subscription access unavailable" });
  }
}
module.exports = {
  BASE_MONTHLY_CENTS,
  STAFF_MONTHLY_CENTS,
  stripeClient,
  activeSeats,
  subscriptionStatus,
  checkout,
  billingPortal,
  syncSeats,
  processSeatChanges,
  startSeatWorker,
  handleSubscriptionEvent,
  requireSubscription,
};
