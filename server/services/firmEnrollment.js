"use strict";
const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const { z } = require("zod");
const { pool } = require("../db");
const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const registration = z
  .object({
    token: z.string().min(32).max(256),
    name: z.string().trim().min(2).max(100),
    ownerName: z.string().trim().min(2).max(100),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,49}$/),
    password: z.string().min(12).max(128),
    acceptTerms: z.literal(true),
    termsVersion: z.string().min(1).max(100),
  })
  .strict();
async function createInvitation(
  { email, ledgerhqFirmId, days = 7, source = "ledgerhq" },
  db = pool,
) {
  const direct = source === "direct";
  if (
    !z.email().safeParse(email).success ||
    (!direct && !String(ledgerhqFirmId || "").trim()) ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > 30
  )
    throw Error(
      direct ? "A valid email is required" : "Verified email and LedgerHQ firm required",
    );
  const token = crypto.randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO firm_enrollment_invitations(token_hash,email,ledgerhq_firm_id,expires_at,source)
    VALUES($1,$2,$3,NOW()+$4*INTERVAL '1 day',$5)`,
    [
      hash(token),
      email.trim().toLowerCase(),
      direct ? null : String(ledgerhqFirmId),
      days,
      direct ? "direct" : "ledgerhq",
    ],
  );
  return token;
}
async function enroll(input, db = pool) {
  const data = registration.parse(input);
  if (
    !process.env.DARKLION_TERMS_VERSION ||
    data.termsVersion !== process.env.DARKLION_TERMS_VERSION
  )
    throw Error("Review the current terms before continuing");
  const passwordHash = await bcrypt.hash(data.password, 12),
    client = await db.connect();
  try {
    await client.query("BEGIN");
    const invitation = (
      await client.query(
        "SELECT * FROM firm_enrollment_invitations WHERE token_hash=$1 AND accepted_at IS NULL AND expires_at>NOW() FOR UPDATE",
        [hash(data.token)],
      )
    ).rows[0];
    if (!invitation) throw Error("Invitation expired or already used");
    const firm = (
      await client.query(
        "INSERT INTO firms(name,email,password_hash,slug,plan) VALUES($1,$2,$3,$4,'member') RETURNING id,name,slug",
        [data.name, invitation.email, passwordHash, data.slug],
      )
    ).rows[0];
    const user = (
      await client.query(
        "INSERT INTO firm_users(firm_id,name,email,password_hash,role,accepted_at) VALUES($1,$2,$3,$4,'owner',NOW()) RETURNING id",
        [firm.id, data.ownerName, invitation.email, passwordHash],
      )
    ).rows[0];
    await client.query(
      "INSERT INTO firm_preferences(firm_id,settings) VALUES($1,$2)",
      [
        firm.id,
        JSON.stringify({
          edition: "public",
          staffMfaRequired: true,
          ledgerhqFirmId: invitation.ledgerhq_firm_id,
          notificationFallback: "owners",
          aiEnabled: true,
          termsVersion: data.termsVersion,
          termsAcceptedAt: new Date().toISOString(),
        }),
      ],
    );
    await client.query(
      "INSERT INTO firm_feature_flags(firm_id,feature_key,enabled) VALUES($1,'embedded_chat',FALSE)",
      [firm.id],
    );
    await client.query(
      "UPDATE firm_enrollment_invitations SET accepted_at=NOW(),firm_id=$2 WHERE token_hash=$1",
      [hash(data.token), firm.id],
    );
    await client.query(
      "INSERT INTO audit_log(firm_id,action,detail) VALUES($1,$2,$3)",
      [
        firm.id,
        "firm_enrolled",
        JSON.stringify({ staffId: user.id, termsVersion: data.termsVersion }),
      ],
    );
    await client.query("COMMIT");
    return { firm, signInRequired: true };
  } catch (e) {
    await client.query("ROLLBACK");
    if (e.code === "23505")
      throw Error("That firm code or owner email is already registered");
    throw e;
  } finally {
    client.release();
  }
}
module.exports = { hash, registration, createInvitation, enroll };
