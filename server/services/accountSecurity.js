"use strict";
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { pool } = require("../db");
const {
  encrypt,
  decrypt,
  encryptionAvailable,
} = require("../utils/encryption");

const columns = "firm_id=$1 AND kind=$2 AND account_id=$3 AND signer_role=$4";
function identity({ firmId, kind, accountId, signerRole = "taxpayer" }) {
  if (
    !Number.isSafeInteger(Number(firmId)) ||
    Number(firmId) < 1 ||
    !Number.isSafeInteger(Number(accountId)) ||
    Number(accountId) < 1 ||
    !["staff", "portal"].includes(kind) ||
    !["taxpayer", "spouse"].includes(signerRole)
  )
    throw new Error("Invalid account");
  return [
    Number(firmId),
    kind,
    Number(accountId),
    kind === "staff" ? "taxpayer" : signerRole,
  ];
}
function accountFromRequest(req) {
  return req.portal
    ? {
        firmId: req.portal.firmId,
        kind: "portal",
        accountId: req.portal.personId,
        signerRole: req.portal.signerRole,
      }
    : {
        firmId: req.firm.id,
        kind: "staff",
        accountId: req.firm.userId,
        signerRole: "taxpayer",
      };
}
function base32(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits -= 5)) & 31];
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
function decode32(value) {
  let bits = 0,
    n = 0;
  const bytes = [];
  for (const c of String(value).toUpperCase().replace(/=+$/, "")) {
    const v = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c);
    if (v < 0) throw new Error("Invalid secret");
    n = (n << 5) | v;
    bits += 5;
    if (bits >= 8) bytes.push((n >>> (bits -= 8)) & 255);
  }
  return Buffer.from(bytes);
}
function totp(secret, step = Math.floor(Date.now() / 30000), digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto
    .createHmac("sha1", decode32(secret))
    .update(counter)
    .digest();
  return String(
    (mac.readUInt32BE(mac[mac.length - 1] & 15) & 0x7fffffff) % 10 ** digits,
  ).padStart(digits, "0");
}
function validStep(secret, code, lastStep = -1, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ""))) return null;
  const current = Math.floor(now / 30000);
  for (const step of [current, current - 1, current + 1]) {
    if (
      step > Number(lastStep) &&
      crypto.timingSafeEqual(
        Buffer.from(totp(secret, step)),
        Buffer.from(String(code)),
      )
    )
      return step;
  }
  return null;
}
const recoveryHash = (code) =>
  crypto
    .createHash("sha256")
    .update(String(code).replace(/[\s-]/g, "").toLowerCase())
    .digest("hex");
async function ensureAccount(account, db = pool) {
  const args = identity(account);
  await db.query(
    "INSERT INTO account_security(firm_id,kind,account_id,signer_role) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    args,
  );
  return (
    await db.query(`SELECT * FROM account_security WHERE ${columns}`, args)
  ).rows[0];
}
async function verifyPassword(account, password) {
  const args = identity(account);
  const query =
    account.kind === "staff"
      ? "SELECT password_hash AS hash FROM firm_users WHERE firm_id=$1 AND id=$2 AND archived_at IS NULL AND accepted_at IS NOT NULL"
      : `SELECT ${args[3] === "spouse" ? "spouse_" : ""}portal_password_hash AS hash FROM people WHERE firm_id=$1 AND id=$2 AND ${args[3] === "spouse" ? "spouse_" : ""}portal_enabled=TRUE`;
  const row = (await pool.query(query, [args[0], args[2]])).rows[0];
  return (
    !!row?.hash &&
    typeof password === "string" &&
    password.length <= 1024 &&
    (await bcrypt.compare(password, row.hash))
  );
}
async function consumeMfa(account, code, db = pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const args = identity(account);
    const row = (
      await client.query(
        `SELECT * FROM account_security WHERE ${columns} FOR UPDATE`,
        args,
      )
    ).rows[0];
    if (!row?.mfa_enabled) {
      await client.query("COMMIT");
      return true;
    }
    const step = validStep(decrypt(row.mfa_secret), code, row.last_totp_step);
    const hash = recoveryHash(code),
      hashes = row.recovery_hashes || [];
    if (step === null && !hashes.includes(hash)) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE account_security SET last_totp_step=$5,recovery_hashes=$6 WHERE ${columns}`,
      [
        ...args,
        step ?? row.last_totp_step,
        JSON.stringify(
          step === null ? hashes.filter((h) => h !== hash) : hashes,
        ),
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
async function requireLoginMfa(account, code, verifiedPasswordHash) {
  const row = await ensureAccount(account);
  if (verifiedPasswordHash !== undefined) {
    const args = identity(account);
    const query =
      account.kind === "staff"
        ? "SELECT password_hash AS hash FROM firm_users WHERE firm_id=$1 AND id=$2"
        : `SELECT ${args[3] === "spouse" ? "spouse_" : ""}portal_password_hash AS hash FROM people WHERE firm_id=$1 AND id=$2`;
    const current = (await pool.query(query, [args[0], args[2]])).rows[0];
    if (!current || current.hash !== verifiedPasswordHash)
      throw Object.assign(Error("Credentials changed. Sign in again."), {
        status: 401,
        code: "MFA_REQUIRED",
      });
  }
  if (row.mfa_enabled && !(await consumeMfa(account, code)))
    throw Object.assign(new Error("Enter an authenticator or recovery code"), {
      status: 401,
      code: "MFA_REQUIRED",
    });
  return { version: row.version, mfa: row.mfa_enabled };
}
// "Chrome on Mac" style label so people can recognize their own sessions.
function deviceLabelFromRequest(req) {
  const ua = String(req?.headers?.["user-agent"] || "");
  if (!ua) return "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /Expo|okhttp|CFNetwork|Darwin/.test(ua)
              ? "Mobile app"
              : "Browser";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  return os ? `${browser} on ${os}` : browser;
}
async function createSession(account, claims, deviceLabel = "", proof) {
  const row = await ensureAccount(account),
    sid = crypto.randomUUID();
  if (
    (proof && Number(proof.version) !== Number(row.version)) ||
    (row.mfa_enabled && !proof?.mfa)
  )
    throw Object.assign(Error("Sign in again with your authenticator"), {
      status: 401,
      code: "MFA_REQUIRED",
    });
  const days = account.kind === "staff" ? 30 : 7;
  await pool.query(
    `INSERT INTO account_sessions(id,firm_id,kind,account_id,signer_role,expires_at,device_label)
    VALUES($1,$2,$3,$4,$5,NOW()+$6*INTERVAL '1 day',$7)`,
    [sid, ...identity(account), days, String(deviceLabel).slice(0, 100)],
  );
  return jwt.sign({ ...claims, av: row.version, sid }, process.env.JWT_SECRET, {
    expiresIn: `${days}d`,
    algorithm: "HS256",
  });
}
async function validateSession(account, payload, db = pool) {
  const args = identity(account);
  const row = (
    await db.query(
      `SELECT version,mfa_enabled FROM account_security WHERE ${columns}`,
      args,
    )
  ).rows[0];
  if (Number(payload.av || 0) !== Number(row?.version || 0))
    throw new Error("Session revoked");
  if (row?.mfa_enabled && !payload.sid) throw new Error("New sign-in required");
  if (payload.sid) {
    const session = await db.query(
      `SELECT id FROM account_sessions WHERE id=$5 AND ${columns} AND revoked_at IS NULL AND expires_at>NOW()`,
      [...args, payload.sid],
    );
    if (!session.rowCount) throw new Error("Session revoked");
  }
}
async function revokeAll(account, db = pool) {
  await ensureAccount(account, db);
  const args = identity(account);
  await db.query(
    `UPDATE account_security SET version=version+1 WHERE ${columns}`,
    args,
  );
  await db.query(
    `UPDATE account_sessions SET revoked_at=NOW() WHERE ${columns} AND revoked_at IS NULL`,
    args,
  );
  await disablePush(account, db);
}
async function disablePush(account, db = pool) {
  const args = identity(account);
  if (account.kind === "staff")
    await db.query(
      "UPDATE staff_mobile_devices SET disabled_at=NOW() WHERE firm_id=$1 AND staff_user_id=$2",
      [args[0], args[2]],
    );
  else
    await db.query(
      "UPDATE portal_mobile_devices SET disabled_at=NOW() WHERE firm_id=$1 AND person_id=$2 AND signer_role=$3",
      [args[0], args[2], args[3]],
    );
}
async function beginMfa(account, password) {
  if (!encryptionAvailable())
    throw Object.assign(new Error("Account security is not configured"), {
      status: 503,
    });
  if (!(await verifyPassword(account, password)))
    throw Object.assign(new Error("Current password is incorrect"), {
      status: 401,
    });
  const row = await ensureAccount(account);
  if (row.mfa_enabled)
    throw Object.assign(new Error("MFA is already enabled"), { status: 409 });
  const secret = base32(crypto.randomBytes(20));
  await pool.query(
    `UPDATE account_security SET pending_secret=$5,pending_expires_at=NOW()+INTERVAL '10 minutes' WHERE ${columns}`,
    [...identity(account), encrypt(secret)],
  );
  // Clients see their firm's name in the authenticator app, not the vendor's or an internal ID.
  let issuer = "DarkLion",
    label = account.kind + "-" + account.accountId;
  if (account.kind === "portal") {
    const firm = (
      await pool.query(
        "SELECT COALESCE(NULLIF(display_name,''),name) AS name FROM firms WHERE id=$1",
        [account.firmId],
      )
    ).rows[0];
    issuer = firm?.name || "Client Portal";
    label = "Client Portal";
  }
  return {
    secret,
    uri: `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`,
  };
}
async function enableMfa(account, code) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const args = identity(account);
    const row = (
      await client.query(
        `SELECT * FROM account_security WHERE ${columns} FOR UPDATE`,
        args,
      )
    ).rows[0];
    if (
      !row?.pending_secret ||
      new Date(row.pending_expires_at) <= new Date() ||
      row.mfa_enabled
    )
      throw new Error("Authenticator setup expired");
    const step = validStep(decrypt(row.pending_secret), code);
    if (step === null) throw new Error("Invalid authenticator code");
    const recoveryCodes = Array.from({ length: 10 }, () =>
      crypto.randomBytes(10).toString("hex"),
    );
    await client.query(
      `UPDATE account_security SET mfa_secret=pending_secret,pending_secret=NULL,pending_expires_at=NULL,
      mfa_enabled=TRUE,last_totp_step=$5,recovery_hashes=$6,version=version+1 WHERE ${columns}`,
      [...args, step, JSON.stringify(recoveryCodes.map(recoveryHash))],
    );
    await client.query(
      `UPDATE account_sessions SET revoked_at=NOW() WHERE ${columns}`,
      args,
    );
    await disablePush(account, client);
    await client.query("COMMIT");
    return { recoveryCodes, signInAgain: true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
module.exports = {
  deviceLabelFromRequest,
  identity,
  columns,
  accountFromRequest,
  base32,
  totp,
  validStep,
  ensureAccount,
  verifyPassword,
  consumeMfa,
  requireLoginMfa,
  createSession,
  validateSession,
  revokeAll,
  disablePush,
  beginMfa,
  enableMfa,
};
