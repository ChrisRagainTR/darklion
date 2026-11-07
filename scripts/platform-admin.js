"use strict";
// Operator-only provisioning. Uses the explicitly supplied DATABASE_URL; never
// loads a repository .env or grants by email, domain, firm role or signup input.
const { pool } = require("../server/db");
async function main() {
  const [action, id, expectedEmail] = process.argv.slice(2);
  if (!process.env.DATABASE_URL)
    throw Error("An explicit DATABASE_URL is required");
  if (
    !["inspect", "prepare", "grant", "revoke"].includes(action) ||
    !/^[1-9]\d*$/.test(id || "")
  )
    throw Error(
      "Usage: node scripts/platform-admin.js inspect|grant|revoke STAFF_USER_ID; prepare STAFF_USER_ID EXPECTED_EMAIL",
    );
  if (action === "prepare") {
    if (!expectedEmail) throw Error("Preparation requires the verified account email");
    // Only additive admin tables, without running general startup/backfills.
    await require("../server/services/adminSchema").initializeAdmin(pool);
  }
  const user = (
    await pool.query(
      `SELECT u.id,u.firm_id,u.name,u.email,u.role,u.accepted_at,u.archived_at,s.mfa_enabled,
    (a.user_id IS NOT NULL AND a.revoked_at IS NULL) AS platform_admin
    FROM firm_users u LEFT JOIN account_security s ON s.firm_id=u.firm_id AND s.account_id=u.id AND s.kind='staff' AND s.signer_role='taxpayer'
    LEFT JOIN platform_admins a ON a.user_id=u.id WHERE u.id=$1`,
      [id],
    )
  ).rows[0];
  if (!user) throw Error("Staff account not found");
  if (action === "inspect") {
    console.log(JSON.stringify(user, null, 2));
    return;
  }
  if (action === "prepare") {
    if (!expectedEmail || user.email.trim().toLowerCase() !== expectedEmail.trim().toLowerCase())
      throw Error("Preparation requires the verified account email to match");
    if (!user.accepted_at || user.archived_at || user.role === "agent")
      throw Error("Preparation requires an active human staff account");
    // Access still requires a valid signed-in account and an active grant.
    // Never reactivate revoked access through the preparation path.
    await pool.query(
      "INSERT INTO platform_admins(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING",
      [id],
    );
    console.log(`Administrator enrollment prepared for staff user ${id}; access requires a current sign-in. Existing revocations are preserved.`);
    return;
  }
  if (action === "grant") {
    if (
      !user.accepted_at ||
      user.archived_at ||
      user.role === "agent"
    )
      throw Error(
        "Grant requires an active human staff account",
      );
    await pool.query(
      "INSERT INTO platform_admins(user_id) VALUES($1) ON CONFLICT(user_id) DO UPDATE SET revoked_at=NULL,created_at=NOW()",
      [id],
    );
  } else {
    await pool.query(
      "UPDATE platform_admins SET revoked_at=NOW() WHERE user_id=$1",
      [id],
    );
    await pool.query(
      "UPDATE platform_admin_unlocks SET revoked_at=NOW() WHERE admin_user_id=$1 AND revoked_at IS NULL",
      [id],
    );
    await pool.query(
      "UPDATE support_sessions SET ended_at=COALESCE(ended_at,NOW()) WHERE admin_user_id=$1",
      [id],
    );
  }
  console.log(
    `Platform access ${action === "grant" ? "granted" : "revoked"} for staff user ${id}.`,
  );
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
