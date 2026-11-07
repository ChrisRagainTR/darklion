"use strict";
const { pool } = require("../db");
const {
  encrypt,
  decrypt,
  encryptionAvailable,
} = require("../utils/encryption");
// Firms allowed to use the server-level integration keys from the environment
// (TWILIO_*, GOOGLE_SERVICE_ACCOUNT_JSON, STRIPE_SECRET_KEY, NOTIFY_EMAIL).
// Self-hosters usually run a single firm, so this defaults to firm 1.
function envIntegrationFirmIds() {
  return String(process.env.ENV_INTEGRATIONS_FIRM_IDS ?? "1")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}
async function legacyIntegrationOwner(firmId) {
  return envIntegrationFirmIds().includes(Number(firmId));
}
async function stripeAccounts(firmId, db = pool) {
  if (!Number.isSafeInteger(Number(firmId)) || Number(firmId) < 1)
    throw Error("Firm required for Stripe access");
  const rows = (
    await db.query(
      "SELECT account_name,display_name,secret_encrypted FROM firm_integration_secrets WHERE firm_id=$1 AND provider='stripe'",
      [firmId],
    )
  ).rows;
  if (rows.length)
    return rows
      .map((r) => ({
        name: r.account_name,
        label: r.display_name,
        key: decrypt(r.secret_encrypted),
      }))
      .filter((a) => a.key);
  if (!(await legacyIntegrationOwner(firmId, db))) return [];
  return [["default", process.env.STRIPE_ACCOUNT_LABEL || "Stripe", "STRIPE_SECRET_KEY"]]
    .map(([name, label, variable]) => ({
      name,
      label,
      key: process.env[variable],
    }))
    .filter((a) => a.key);
}
async function saveStripeAccount(firmId, { name, label, key }) {
  if (!encryptionAvailable()) throw Error("Integration encryption unavailable");
  if (
    !/^[a-z][a-z0-9_-]{1,40}$/.test(name || "") ||
    typeof label !== "string" ||
    !label.trim() ||
    label.length > 80 ||
    !/^rk_(live|test)_[a-zA-Z0-9]{12,}$/.test(key || "")
  )
    throw Error("Use a named Stripe restricted API key");
  // Confirm the firm key can read the resources used by its billing view.
  const stripe = require("stripe")(key);
  await stripe.subscriptions.list({ limit: 1 });
  await stripe.invoices.list({ limit: 1 });
  await stripe.customers.list({ limit: 1 });
  await pool.query(
    `INSERT INTO firm_integration_secrets(firm_id,provider,account_name,display_name,secret_encrypted)
    VALUES($1,'stripe',$2,$3,$4) ON CONFLICT(firm_id,provider,account_name)
    DO UPDATE SET display_name=EXCLUDED.display_name,secret_encrypted=EXCLUDED.secret_encrypted,updated_at=NOW()`,
    [firmId, name, label, encrypt(key)],
  );
}
module.exports = { legacyIntegrationOwner, stripeAccounts, saveStripeAccount };
