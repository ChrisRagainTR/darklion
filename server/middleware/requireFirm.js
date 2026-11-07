const jwt = require('jsonwebtoken');
const { pool } = require('../db');

function authError(message, code = 'INVALID_TOKEN') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function validateStaffTokenPurpose(payload) {
  if (payload.type === 'portal') {
    throw authError('Portal tokens cannot access staff resources', 'INVALID_TOKEN_TYPE');
  }
  if (payload.type && payload.type !== 'staff') {
    throw authError('Invalid staff token type', 'INVALID_TOKEN_TYPE');
  }
}

async function authenticateStaffToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);

  // Portal and other purpose-specific tokens share JWT_SECRET for legacy reasons,
  // so token purpose must be enforced before any staff identity is constructed.
  validateStaffTokenPurpose(payload);

  const firmId = Number(payload.firmId || payload.id);
  if (!Number.isInteger(firmId) || firmId < 1) {
    throw authError('Invalid firm identity');
  }

  const userId = Number(payload.userId);
  const hasUserId = Number.isInteger(userId) && userId > 0;
  let rows;

  if (hasUserId) {
    ({ rows } = await pool.query(
      `SELECT id, firm_id, role, email, COALESCE(NULLIF(display_name,''), NULLIF(name,''), email) AS name
       FROM firm_users
       WHERE id = $1
         AND firm_id = $2
         AND accepted_at IS NOT NULL
         AND archived_at IS NULL
       LIMIT 1`,
      [userId, firmId]
    ));
  } else if (!payload.type && payload.email) {
    // Compatibility for pre-userId staff JWTs. They remain safe because the
    // signed email must resolve to an active user in the signed firm.
    ({ rows } = await pool.query(
      `SELECT id, firm_id, role, email, COALESCE(NULLIF(display_name,''), NULLIF(name,''), email) AS name
       FROM firm_users
       WHERE firm_id = $1
         AND LOWER(email) = LOWER($2)
         AND accepted_at IS NOT NULL
         AND archived_at IS NULL
       LIMIT 1`,
      [firmId, String(payload.email)]
    ));
  } else {
    throw authError('Staff identity is missing');
  }

  if (!rows[0]) {
    throw authError('Staff account is inactive', 'INACTIVE_STAFF');
  }

  await require('../services/accountSecurity').validateSession({ firmId, kind: 'staff', accountId: rows[0].id }, payload);

  return {
    sessionId: payload.sid || null,
    id: firmId,
    userId: rows[0].id,
    role: rows[0].role,
    email: rows[0].email,
    name: rows[0].name,
  };
}

async function requireFirm(req, res, next) {
  if (req.firm?.supportSession) return next();
  // Already authenticated via API token middleware — skip JWT check
  if (req.firm && req.firm.isApiToken) return require('../services/subscriptions').requireSubscription(req,res,next);

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader.slice(7);
  try {
    req.firm = await authenticateStaffToken(token);
    // Enrollment and security remain reachable before the mandatory second
    // factor is enrolled. Every data route still requires an enrolled account.
    const allowed = /^\/(api\/account-security(?:\/|$)|firms\/(me|features)(?:\?|$))/.test(req.originalUrl || '');
    if (!allowed) {
      const prefs = await require('../services/firmPreferences').getFirmPreferences(req.firm.id);
      if (prefs.staffMfaRequired) {
        const state = await require('../services/accountSecurity').ensureAccount({ firmId:req.firm.id,kind:'staff',accountId:req.firm.userId });
        if (!state.mfa_enabled) return res.status(403).json({error:'Set up an authenticator to continue',code:'MFA_SETUP_REQUIRED'});
      }
    }
    return require('../services/subscriptions').requireSubscription(req,res,next);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired — please log in again', expired: true });
    }
    if (err.code === 'INACTIVE_STAFF') {
      return res.status(401).json({ error: 'Staff account is inactive — please log in again', inactive: true });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { requireFirm, authenticateStaffToken, validateStaffTokenPurpose };
