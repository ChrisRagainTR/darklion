"use strict";

function offerReadiness(env = process.env) {
  const https = (value) => {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  };
  const checks = {
    enrollment: env.DARKLION_PUBLIC_ENROLLMENT === "true",
    membership: (env.LEDGERHQ_ENROLLMENT_SECRET || "").length >= 32,
    billing: !!(
      env.DARKLION_STRIPE_SECRET_KEY &&
      env.DARKLION_STRIPE_WEBHOOK_SECRET &&
      env.DARKLION_STRIPE_BASE_PRICE_ID &&
      env.DARKLION_STRIPE_SEAT_PRICE_ID
    ),
    inference: !!(
      env.DARKLION_INFERENCE_URL &&
      (env.DARKLION_INFERENCE_TOKEN || "").length >= 32
    ),
    legal: !!(
      env.DARKLION_TERMS_VERSION &&
      https(env.DARKLION_TERMS_URL) &&
      https(env.DARKLION_PRIVACY_URL)
    ),
    mobile: https(env.DARKLION_APP_STORE_URL),
    uploads: !!env.CLAMAV_HOST,
    encryption:
      /^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || "") &&
      (env.JWT_SECRET || "").length >= 32,
  };
  return { configurationOnly: true, checks };
}

module.exports = { offerReadiness };
