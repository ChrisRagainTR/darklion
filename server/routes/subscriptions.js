"use strict";
const { Router } = require("express");
const service = require("../services/subscriptions");
const router = Router();
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  return req.firm.role === "owner" && !req.firm.isApiToken
    ? next()
    : res.status(403).json({ error: "Firm owner required" });
});
for (const [method, path, fn] of [
  ["get", "/", service.subscriptionStatus],
  ["post", "/checkout", service.checkout],
  ["post", "/portal", service.billingPortal],
  ["post", "/sync-seats", service.syncSeats],
]) {
  router[method](path, async (req, res) => {
    try {
      res.json(await fn(req.firm.id));
    } catch (e) {
      res
        .status(e.status || 503)
        .json({
          error: e.status
            ? e.message
            : "Billing request failed. Please try again.",
        });
    }
  });
}
async function webhook(req, res) {
  try {
    if (!process.env.DARKLION_STRIPE_WEBHOOK_SECRET)
      return res.status(503).json({ error: "Billing webhook unavailable" });
    const stripe = service.stripeClient();
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.get("stripe-signature"),
      process.env.DARKLION_STRIPE_WEBHOOK_SECRET,
    );
    await service.handleSubscriptionEvent(event, stripe);
    res.json({ received: true });
  } catch (e) {
    res
      .status(e.type === "StripeSignatureVerificationError" ? 400 : 503)
      .json({ error: "Webhook could not be processed" });
  }
}
module.exports = { router, webhook };
