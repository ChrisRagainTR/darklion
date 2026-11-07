"use strict";
const { pool } = require("../db");
const { z } = require("zod");

const preferencesSchema = z
  .object({
    timezone: z
      .string()
      .max(80)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid timezone")
      .optional(),
    staffContactOrder: z.array(z.number().int().positive()).max(100).optional(),
    staffMfaRequired: z.boolean().optional(),
    aiEnabled: z.boolean().optional(),
    aiDailyRequests: z.number().int().min(1).max(10000).optional(),
    retentionDays: z.number().int().min(365).max(36500).optional(),
    notificationFallback: z.enum(["owners", "configured"]).optional(),
  })
  .strict();

async function getFirmPreferences(firmId, db = pool) {
  const { rows } = await db.query(
    `SELECT f.id,f.name,f.slug,f.email,f.display_name,f.contact_email,f.logo_url,f.portal_icon_url,f.portal_logo_style,f.primary_color,
    COALESCE(p.settings,'{}'::jsonb) AS settings FROM firms f LEFT JOIN firm_preferences p ON p.firm_id=f.id WHERE f.id=$1`,
    [firmId],
  );
  if (!rows[0])
    throw Object.assign(new Error("Firm not found"), { status: 404 });
  const f = rows[0],
    s = f.settings;
  return {
    firmId: f.id,
    name: f.display_name || f.name,
    slug: f.slug,
    contactEmail: f.contact_email || "",
    primaryColor: /^#[0-9a-f]{6}$/i.test(f.primary_color || "")
      ? f.primary_color
      : "#C9A84C",
    // Self-hosted installs (the default) skip the hosted-subscription gates.
    edition: s.edition === "public" && process.env.DARKLION_SELF_HOSTED === "false" ? "public" : "existing",
    timezone: s.timezone || "America/New_York",
    staffContactOrder: s.staffContactOrder || [],
    legacyStaffNames: [],
    staffMfaRequired: s.staffMfaRequired === true,
    aiEnabled: s.aiEnabled !== false,
    aiDailyRequests:
      s.edition === "public"
        ? Math.min(s.aiDailyRequests || 200, 200)
        : s.aiDailyRequests || 10000,
    retentionDays: s.retentionDays || 2555,
    notificationFallback:
      s.notificationFallback ||
      (s.edition === "public" ? "owners" : "configured"),
    appName: process.env.DARKLION_APP_NAME || f.display_name || f.name || "DarkLion",
    appStoreUrl: process.env.DARKLION_APP_STORE_URL || "",
    ...require("./portalBranding").portalBranding(f, s),
    logoUrl: f.logo_url ? `/portal-auth/firm-logo/${f.id}` : "",
  };
}

async function updateFirmPreferences(firmId, input, db = pool) {
  const settings = preferencesSchema.parse(input);
  if (settings.staffContactOrder?.length) {
    if (
      new Set(settings.staffContactOrder).size !==
      settings.staffContactOrder.length
    )
      throw new Error("Duplicate staff member");
    const staff = await db.query(
      "SELECT id FROM firm_users WHERE firm_id=$1 AND id=ANY($2::int[]) AND archived_at IS NULL AND accepted_at IS NOT NULL",
      [firmId, settings.staffContactOrder],
    );
    if (staff.rowCount !== settings.staffContactOrder.length)
      throw new Error("Select active staff from this firm");
  }
  await db.query(
    `INSERT INTO firm_preferences(firm_id,settings) VALUES($1,$2) ON CONFLICT(firm_id)
    DO UPDATE SET settings=firm_preferences.settings || EXCLUDED.settings,updated_at=NOW()`,
    [firmId, JSON.stringify(settings)],
  );
  return getFirmPreferences(firmId, db);
}

module.exports = {
  preferencesSchema,
  getFirmPreferences,
  updateFirmPreferences,
};
