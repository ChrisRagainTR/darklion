const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const sharp = require('sharp');
const { pool } = require('../db');
const { resolveLoginFirm } = require('../services/loginIdentity');
const { requireFirm } = require('../middleware/requireFirm');
const { auditLog } = require('../services/audit');
const { uploadFile, getSignedDownloadUrl } = require('../services/s3');
const { sendPasswordReset } = require('../services/email');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { cb(null, file.mimetype.startsWith('image/')); },
});

const router = Router();
router.use(async (req, res, next) => {
  const managed = /^\/(invite$|domains(?:\/|$)|api-tokens(?:\/|$)|branding(?:\/|$)|tax-season$|integrations$)/.test(req.path);
  const sensitiveRead = req.method === 'GET' && /^\/(domains|api-tokens)(?:\/|$)/.test(req.path);
  const profileEdit = /^\/team\/(\d+)\/(avatar|credentials|display-name)$/.exec(req.path);
  const mutation = ['POST','PUT','PATCH','DELETE'].includes(req.method);
  if (!sensitiveRead && !(mutation && (managed || profileEdit))) return next();
  return requireFirm(req, res, () => {
    const administrator = ['owner','admin'].includes(req.firm.role);
    if (administrator || (profileEdit && Number(profileEdit[1]) === req.firm.userId)) return next();
    return res.status(403).json({ error: 'Firm administrator required' });
  });
});

const BCRYPT_ROUNDS = 12;
const JWT_EXPIRES_IN = '30d';
const STAFF_INVITE_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days
const STAFF_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

function newStaffInviteExpiration() {
  return new Date(Date.now() + STAFF_INVITE_TTL_MS);
}

function isExpired(dateValue) {
  return dateValue && new Date(dateValue) < new Date();
}

// --- Rate limiters ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: false,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: false,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many registration attempts. Please try again later.' },
});

const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: false,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many password reset attempts. Please try again in 15 minutes.' },
});

// --- Input validation ---
function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}

function validateEmail(email) {
  if (!email || !email.includes('@') || !email.includes('.')) return 'Invalid email address';
  return null;
}

function requestBaseUrl(req) {
  return process.env.PUBLIC_APP_URL || APP_URL;
}


// --- Build JWT payload from firm_users row + firm row ---
async function buildToken(firmUser, firmName, proof, req) {
  return require('../services/accountSecurity').createSession(
    { firmId: firmUser.firm_id, kind: 'staff', accountId: firmUser.id },
    { firmId: firmUser.firm_id, userId: firmUser.id, role: firmUser.role, email: firmUser.email,
      name: firmUser.display_name || firmUser.name || '', firmName: firmName || '', type: 'staff' }, require('../services/accountSecurity').deviceLabelFromRequest(req), proof);
}

// --- POST /firms/register ---
router.post('/register', registerLimiter, async (req, res) => {
  // New firms must prove membership and ownership through enrollment. A typed
  // firm email address is not proof of ownership or integration access.
  return res.status(403).json({error:'Use your LedgerHQ invitation to create a workspace.'});
});

// --- POST /firms/login ---
router.post('/login', loginLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const firmId = await resolveLoginFirm(email, pool);

    // Client and staff access may share an email, but must belong to one firm.
    const { rows } = await pool.query(
      `SELECT fu.id, fu.firm_id, fu.name, fu.email, fu.password_hash, fu.role, fu.accepted_at,
              f.name as firm_name, f.plan
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE LOWER(TRIM(fu.email)) = $1 AND fu.archived_at IS NULL
         AND fu.firm_id = $2 LIMIT 2`,
      [email, firmId]
    );

    const firmUser = rows.length === 1 ? rows[0] : null;

    // Timing-safe: always run bcrypt
    const dummyHash = '$2b$12$invalidhashfortiming0000000000000000000000000000000000000';
    const match = firmUser
      ? await bcrypt.compare(password, firmUser.password_hash || dummyHash)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!firmUser || !match || !firmUser.accepted_at) {
      await auditLog(firmUser?.firm_id || null, 'login_fail', `Failed login: ${email}`, ip);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const proof=await require('../services/accountSecurity').requireLoginMfa({ firmId: firmUser.firm_id, kind: 'staff', accountId: firmUser.id }, req.body.mfaCode, firmUser.password_hash);

    // Update last_login_at
    await pool.query('UPDATE firm_users SET last_login_at = NOW() WHERE id = $1', [firmUser.id]);

    const preferences = await require('../services/firmPreferences').getFirmPreferences(firmUser.firm_id);
    const accountState = await require('../services/accountSecurity').ensureAccount({ firmId:firmUser.firm_id,kind:'staff',accountId:firmUser.id });
    const token = await buildToken(firmUser, firmUser.firm_name, proof, req);
    await auditLog(firmUser.firm_id, 'login_success', `Login: ${email}`, ip);
    // New self-serve firms land on setup until their membership is active.
    let setupRequired = false;
    if (preferences?.edition === 'public' && firmUser.role === 'owner') {
      const { rows: subRows } = await pool.query('SELECT status FROM darklion_subscriptions WHERE firm_id = $1', [firmUser.firm_id]);
      setupRequired = !['active', 'trialing'].includes(subRows[0]?.status);
    }

    res.json({
      token,
      mfaSetupRequired: typeof preferences !== 'undefined' && preferences.staffMfaRequired && !accountState.mfa_enabled,
      setupRequired,
      firm: { id: firmUser.firm_id, name: firmUser.firm_name, email: firmUser.email, plan: firmUser.plan },
    });
  } catch (err) {
    if (err.code === 'MFA_REQUIRED') return res.status(401).json({ error: err.message, code: err.code });
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// --- POST /firms/forgot-password ---
router.post('/forgot-password', passwordResetLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();

    // Always return ok to prevent staff account enumeration.
    if (!email) return res.json({ ok: true });

    const { rows } = await pool.query(
      `SELECT fu.id, fu.firm_id, fu.name, fu.display_name, fu.email, f.name AS firm_name
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE LOWER(TRIM(fu.email)) = $1
         AND fu.firm_id = $2
         AND fu.archived_at IS NULL
         AND fu.accepted_at IS NOT NULL
       LIMIT 2`,
      [email, await resolveLoginFirm(email, pool)]
    );

    const firmUser = rows.length === 1 ? rows[0] : null;
    const resetBaseUrl = requestBaseUrl(req);
    // Respond before doing any per-account work so response time doesn't reveal whether the email exists.
    res.json({ ok: true });
    if (firmUser) setImmediate(async () => { try {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + STAFF_RESET_TTL_MS);
      await pool.query(
        `UPDATE firm_users
         SET invite_token = $1, invite_expires_at = $2
         WHERE id = $3`,
        [resetToken, expiresAt, firmUser.id]
      );

      await auditLog(firmUser.firm_id, 'staff_password_reset_requested', `Password reset requested: ${email}`, ip);

      try {
        await sendPasswordReset({
          to: firmUser.email,
          name: firmUser.display_name || firmUser.name || firmUser.email,
          firmName: firmUser.firm_name,
          firmId: firmUser.firm_id,
          resetUrl: `${resetBaseUrl}/login?reset=${resetToken}`,
        });
      } catch (emailErr) {
        await auditLog(firmUser.firm_id, 'staff_password_reset_email_failed', `Password reset email failed: ${email}`, ip);
        console.error('[staff-password-reset] email failed:', emailErr.message);
      }
    } catch (resetErr) {
      console.error('Forgot staff password background error:', resetErr);
    } });
  } catch (err) {
    console.error('Forgot staff password error:', err);
    res.status(500).json({ error: 'Request failed. Please try again.' });
  }
});

// --- POST /firms/reset-password/:token ---
router.post('/reset-password/:token', passwordResetLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    const { rows } = await pool.query(
      `SELECT fu.id, fu.firm_id, fu.name, fu.email, fu.role, fu.invite_expires_at,
              f.name AS firm_name, f.plan
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE fu.invite_token = $1
         AND fu.archived_at IS NULL
         AND fu.accepted_at IS NOT NULL`,
      [token]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid or expired reset link' });
    const firmUser = rows[0];
    if (isExpired(firmUser.invite_expires_at)) return res.status(410).json({ error: 'Reset link has expired' });

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const changed = await pool.query(
      `UPDATE firm_users
       SET password_hash = $1,
           invite_token = NULL,
           invite_expires_at = NULL,
           last_login_at = NOW()
       WHERE id = $2 AND invite_token=$3 AND invite_expires_at>NOW() AND archived_at IS NULL`,
      [passwordHash, firmUser.id, token]
    );
    if (!changed.rowCount) return res.status(409).json({error:'Reset link expired or already used'});

    await auditLog(firmUser.firm_id, 'staff_password_reset', `Password reset completed: ${firmUser.email}`, ip);

    const security = await require('../services/accountSecurity').ensureAccount({ firmId: firmUser.firm_id, kind: 'staff', accountId: firmUser.id });
    if (security.mfa_enabled) return res.json({ signInRequired: true, mfaRequired: true });
    const preferences = await require('../services/firmPreferences').getFirmPreferences(firmUser.firm_id);
    const jwtToken = await buildToken(firmUser, firmUser.firm_name, undefined, req);
    res.json({
      token: jwtToken,
      mfaSetupRequired: preferences.staffMfaRequired,
      firm: { id: firmUser.firm_id, name: firmUser.firm_name, email: firmUser.email, plan: firmUser.plan },
    });
  } catch (err) {
    console.error('Reset staff password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// Read-only rollout state for the authenticated firm, separate from billing or
// customer-editable preferences. Clients cannot select a different firm here.
router.get('/features', requireFirm, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { getFirmFeatures } = require('../services/firmFeatures');
    res.json({ features: await getFirmFeatures(req.firm.id) });
  } catch (_) {
    res.status(503).json({ error: 'Feature configuration unavailable' });
  }
});

// --- GET /firms/me ---
router.get('/me', requireFirm, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, plan, created_at FROM firms WHERE id = $1',
      [req.firm.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Firm not found' });
    res.json({ ...rows[0], userId: req.firm.userId, role: req.firm.role, userName: req.firm.name });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch firm info' });
  }
});

// --- POST /firms/invite ---
router.post('/invite', requireFirm, async (req, res) => {
  const ip = req.ip;
  try {
    const { email, name, role } = req.body;
    const firmId = req.firm.id;

    if (!email) return res.status(400).json({ error: 'Email is required' });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    if (!['owner', 'admin'].includes(req.firm.role)) return res.status(403).json({ error: 'Firm administrator required' });
    const validRole = ['admin', 'staff'].includes(role) ? role : 'staff';
    const inviteToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = newStaffInviteExpiration();

    // Insert or update pending invite (also unarchives if previously archived)
    const invitation = await pool.query(
      `INSERT INTO firm_users (firm_id, name, email, role, invite_token, invite_expires_at, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)
       ON CONFLICT (firm_id, email) DO UPDATE SET
         invite_token = EXCLUDED.invite_token,
         invite_expires_at = EXCLUDED.invite_expires_at,
         role = EXCLUDED.role,
         archived_at = NULL,
         accepted_at = NULL,
         password_hash = NULL,
         name = COALESCE(NULLIF(EXCLUDED.name,''), firm_users.name)
       WHERE firm_users.accepted_at IS NULL OR firm_users.archived_at IS NOT NULL
       RETURNING id`,
      [firmId, name || '', email.trim().toLowerCase(), validRole, inviteToken, expiresAt]
    );

    if (!invitation.rowCount) return res.status(409).json({ error: 'This staff member already has an active account' });

    await auditLog(firmId, 'invite_sent', `Invited ${email} as ${validRole}`, ip);

    const inviteUrl = `/invite/${inviteToken}`;
    res.json({ inviteUrl, token: inviteToken });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to send invite' });
  }
});

// --- GET /firms/team ---
router.get('/team', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const { rows: users } = await pool.query(
      `SELECT id, firm_id, name, display_name, email, role, credentials, accepted_at, created_at, last_login_at, invite_expires_at,
              avatar_url, archived_at,
              (invite_token IS NOT NULL AND accepted_at IS NULL AND archived_at IS NULL) as pending
       FROM firm_users
       WHERE firm_id = $1
         AND archived_at IS NULL
       ORDER BY created_at ASC`,
      [firmId]
    );

    // Fetch company access for each user
    const userIds = users.map(u => u.id);
    let companyMap = {};
    if (userIds.length > 0) {
      const { rows: access } = await pool.query(
        `SELECT firm_user_id, realm_id FROM firm_user_companies WHERE firm_user_id = ANY($1)`,
        [userIds]
      );
      for (const a of access) {
        if (!companyMap[a.firm_user_id]) companyMap[a.firm_user_id] = [];
        companyMap[a.firm_user_id].push(a.realm_id);
      }
    }

    const result = users.map(u => ({
      ...u,
      allowed_realm_ids: companyMap[u.id] || [], // empty = all access
    }));

    res.json(result);
  } catch (err) {
    console.error('Team fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// --- GET /firms/team/:userId/invite-link ---
router.get('/team/:userId/invite-link', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Owners only' });
    const { rows } = await pool.query(
      'SELECT invite_token, invite_expires_at, accepted_at FROM firm_users WHERE id = $1 AND firm_id = $2 AND archived_at IS NULL',
      [parseInt(req.params.userId), req.firm.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    if (u.accepted_at) return res.status(400).json({ error: 'User has already accepted their invite' });

    let inviteToken = u.invite_token;
    let expiresAt = u.invite_expires_at;
    let refreshed = false;

    if (!inviteToken || isExpired(expiresAt)) {
      inviteToken = crypto.randomBytes(32).toString('hex');
      expiresAt = newStaffInviteExpiration();
      await pool.query(
        `UPDATE firm_users
         SET invite_token = $1, invite_expires_at = $2, archived_at = NULL
         WHERE id = $3 AND firm_id = $4`,
        [inviteToken, expiresAt, parseInt(req.params.userId), req.firm.id]
      );
      refreshed = true;
      await auditLog(req.firm.id, 'invite_refreshed', `Refreshed invite for user ${req.params.userId}`, req.ip);
    }

    res.json({ inviteUrl: `/invite/${inviteToken}`, expires_at: expiresAt, refreshed });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- PUT /firms/team/:userId (edit name/email) ---
router.put('/team/:userId', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can edit team members' });
    const { name, email } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    const targetId = parseInt(req.params.userId);
    if (targetId === req.firm.userId) return res.status(400).json({ error: 'Cannot edit your own account this way' });
    // Check email not already taken by another user in this firm
    const existing = await pool.query(
      'SELECT id FROM firm_users WHERE firm_id = $1 AND email = $2 AND id != $3',
      [req.firm.id, email.toLowerCase().trim(), targetId]
    );
    if (existing.rows.length > 0) return res.status(400).json({ error: 'Email already in use by another team member' });
    await pool.query(
      'UPDATE firm_users SET name = $1, email = $2 WHERE id = $3 AND firm_id = $4',
      [name?.trim() || '', email.toLowerCase().trim(), targetId, req.firm.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- DELETE /firms/team/:userId ---
router.delete('/team/:userId', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can remove team members' });

    const targetUserId = parseInt(req.params.userId);
    if (targetUserId === req.firm.userId) return res.status(400).json({ error: 'Cannot remove yourself' });

    const { rowCount } = await pool.query(
      `UPDATE firm_users SET archived_at = NOW(), invite_token = NULL, invite_expires_at = NULL
       WHERE id = $1 AND firm_id = $2 AND id != $3`,
      [targetUserId, req.firm.id, req.firm.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'User not found or cannot archive yourself' });

    await auditLog(req.firm.id, 'team_archive', `Archived user ${targetUserId}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- POST /firms/team/:userId/set-password ---
router.post('/team/:userId/set-password', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can set passwords' });
    const targetUserId = parseInt(req.params.userId);
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Verify user belongs to this firm
    const { rows } = await pool.query(
      'SELECT id, email FROM firm_users WHERE id=$1 AND firm_id=$2 AND archived_at IS NULL',
      [targetUserId, req.firm.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `UPDATE firm_users SET password_hash=$1, accepted_at=COALESCE(accepted_at, NOW()),
       invite_token=NULL, invite_expires_at=NULL
       WHERE id=$2 AND firm_id=$3`,
      [hash, targetUserId, req.firm.id]
    );

    await auditLog(req.firm.id, 'team_set_password', `Set password for user ${targetUserId} (${rows[0].email})`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- PUT /firms/team/:userId/role ---
router.put('/team/:userId/role', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can change roles' });

    const targetUserId = parseInt(req.params.userId);
    const { role } = req.body;
    if (!['owner', 'admin', 'staff'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const { rowCount } = await pool.query(
      'UPDATE firm_users SET role = $1 WHERE id = $2 AND firm_id = $3',
      [role, targetUserId, req.firm.id]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'User not found' });

    await auditLog(req.firm.id, 'team_role_change', `User ${targetUserId} → ${role}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- PUT /firms/team/:userId/companies ---
router.put('/team/:userId/companies', requireFirm, async (req, res) => {
  try {
    if (req.firm.role !== 'owner') return res.status(403).json({ error: 'Only owners can manage company access' });

    const targetUserId = parseInt(req.params.userId);
    const realmIds = Array.isArray(req.body.realmIds) ? req.body.realmIds : [];

    // Verify user belongs to this firm
    const { rows } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, req.firm.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    if (realmIds.length) {
      const own = await pool.query('SELECT realm_id FROM companies WHERE firm_id=$1 AND realm_id=ANY($2::text[])', [req.firm.id, [...new Set(realmIds)]]);
      if (own.rowCount !== new Set(realmIds).size) return res.status(404).json({ error: 'Company not found' });
    }

    // Replace all access rows
    await pool.query('DELETE FROM firm_user_companies WHERE firm_user_id = $1', [targetUserId]);

    if (realmIds.length > 0) {
      const insertValues = realmIds.map((_, i) => `($1, $${i + 2})`).join(',');
      await pool.query(
        `INSERT INTO firm_user_companies (firm_user_id, realm_id) VALUES ${insertValues} ON CONFLICT DO NOTHING`,
        [targetUserId, ...realmIds]
      );
    }

    await auditLog(req.firm.id, 'team_company_access', `User ${targetUserId} companies: ${realmIds.length ? realmIds.join(',') : 'ALL'}`, req.ip);
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- GET /invite/:token (public) ---
router.get('/invite-lookup/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const { rows } = await pool.query(
      `SELECT fu.email, fu.name, f.name as firm_name, fu.invite_expires_at, fu.accepted_at
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE fu.invite_token = $1
         AND fu.archived_at IS NULL`,
      [token]
    );

    if (rows.length === 0) return res.json({ valid: false, firmName: '', email: '' });

    const inv = rows[0];
    const expired = isExpired(inv.invite_expires_at);
    const alreadyAccepted = !!inv.accepted_at;

    res.json({
      valid: !expired && !alreadyAccepted,
      firmName: inv.firm_name,
      email: inv.email,
      name: inv.name,
      expired,
      alreadyAccepted,
    });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- POST /invite/:token/accept (public) ---
router.post('/invite-lookup/:token/accept', async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { name, password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    const { rows } = await pool.query(
      `SELECT fu.*, f.name as firm_name, f.plan
       FROM firm_users fu
       JOIN firms f ON f.id = fu.firm_id
       WHERE fu.invite_token = $1
         AND fu.archived_at IS NULL`,
      [token]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
    const firmUser = rows[0];

    const expired = isExpired(firmUser.invite_expires_at);
    if (expired) return res.status(410).json({ error: 'Invite link has expired' });
    if (firmUser.accepted_at) return res.status(409).json({ error: 'Invite already accepted' });

    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const displayName = (name || '').trim() || firmUser.name || firmUser.email;

    const changed = await pool.query(
      `UPDATE firm_users SET name = $1, password_hash = $2, accepted_at = NOW(), invite_token = NULL, invite_expires_at = NULL, last_login_at = NOW()
       WHERE id = $3 AND invite_token=$4 AND accepted_at IS NULL AND archived_at IS NULL AND invite_expires_at>NOW()`,
      [displayName, password_hash, firmUser.id, token]
    );
    if (!changed.rowCount) return res.status(409).json({error:'Invitation expired or already accepted'});

    await auditLog(firmUser.firm_id, 'invite_accepted', `${firmUser.email} accepted invite`, ip);
    const state=await require('../services/accountSecurity').ensureAccount({firmId:firmUser.firm_id,kind:'staff',accountId:firmUser.id});
    if(state.mfa_enabled)return res.json({signInRequired:true,mfaRequired:true});
    const jwtToken = await buildToken({ ...firmUser, name: displayName }, firmUser.firm_name, undefined, req);

    res.json({
      mfaSetupRequired: (await require('../services/firmPreferences').getFirmPreferences(firmUser.firm_id)).staffMfaRequired,
      token: jwtToken,
      firm: { id: firmUser.firm_id, name: firmUser.firm_name, email: firmUser.email, plan: firmUser.plan },
    });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// --- POST /firms/team/:userId/avatar ---
router.post('/team/:userId/avatar', requireFirm, upload.single('avatar'), async (req, res) => {
  try {
    const firmId = req.firm.id;
    const targetUserId = parseInt(req.params.userId);

    // Verify user belongs to this firm
    const { rows } = await pool.query(
      'SELECT id FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
    const key = `avatars/${firmId}/${targetUserId}.webp`;
    const optimized = await sharp(req.file.buffer)
      .rotate()
      .resize(160, 160, { fit: 'cover', position: 'center' })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();

    await uploadFile({ firmId: firmId,
      buffer: optimized,
      key,
      mimeType: 'image/webp',
      bucket,
      cacheControl: 'public, max-age=31536000, immutable',
    });

    await pool.query(
      'UPDATE firm_users SET avatar_url = $1 WHERE id = $2 AND firm_id = $3',
      [key, targetUserId, firmId]
    );

    const signedUrl = await getSignedDownloadUrl({ key, bucket, expiresIn: 86400 });
    res.json({ ok: true, avatar_url: signedUrl });
  } catch (err) {
    console.error('Avatar upload error:', err);
    console.error('[avatar] upload failed:', err); res.status(500).json({ error: 'Avatar upload failed' });
  }
});

// --- PUT /firms/team/:userId/credentials ---
router.put('/team/:userId/credentials', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const userId = parseInt(req.params.userId);
    const { credentials } = req.body;
    await pool.query(
      'UPDATE firm_users SET credentials = $1 WHERE id = $2 AND firm_id = $3',
      [(credentials || '').slice(0, 100), userId, firmId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- PUT /firms/team/:userId/display-name ---
router.put('/team/:userId/display-name', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const userId = parseInt(req.params.userId);
    const { display_name } = req.body;
    await pool.query(
      'UPDATE firm_users SET display_name = $1 WHERE id = $2 AND firm_id = $3',
      [(display_name || '').slice(0, 120), userId, firmId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- GET /firms/team/:userId/avatar ---
router.get('/team/:userId/avatar', requireFirm, async (req, res) => {
  try {
    const firmId = req.firm.id;
    const targetUserId = parseInt(req.params.userId);

    const { rows } = await pool.query(
      'SELECT avatar_url FROM firm_users WHERE id = $1 AND firm_id = $2',
      [targetUserId, firmId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const key = rows[0].avatar_url;
    if (!key) return res.json({ url: null });

    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';
    const url = await getSignedDownloadUrl({ key, bucket, expiresIn: 86400 });
    res.json({ url });
  } catch (err) {
    console.error('Avatar fetch error:', err);
    console.error('[avatar] fetch failed:', err); res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// ===================== CUSTOM DOMAINS =====================
const { invalidateDomainCache } = require('../middleware/domainFirm');

// GET /firms/domains — list domains for current firm
router.get('/domains', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      'SELECT id, domain, verified_at, verification_token, created_at FROM firm_domains WHERE firm_id = $1 ORDER BY created_at DESC',
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[GET /firms/domains]', err);
    res.status(500).json({ error: 'Failed to fetch domains' });
  }
});

// POST /firms/domains — add a custom domain
router.post('/domains', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { domain } = req.body;
  if (!domain || !domain.trim()) return res.status(400).json({ error: 'Domain is required' });
  const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  let reservedAppHost = '';
  try { reservedAppHost = new URL(process.env.APP_URL || '').hostname; } catch (_) {}
  if ([reservedAppHost, process.env.ADMIN_HOSTNAME].filter(Boolean).includes(cleanDomain)) return res.status(400).json({ error: 'This domain is reserved for DarkLion' });
  const verificationToken = 'darklion-verify=' + crypto.randomBytes(16).toString('hex');
  try {
    const { rows } = await pool.query(
      `INSERT INTO firm_domains (firm_id, domain, verification_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (domain) DO NOTHING
       RETURNING *`,
      [firmId, cleanDomain, verificationToken]
    );
    if (!rows.length) return res.status(409).json({ error: 'Domain already registered' });
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[POST /firms/domains]', err);
    res.status(500).json({ error: 'Failed to add domain' });
  }
});

// POST /firms/domains/:id/verify — check DNS TXT record
router.post('/domains/:id/verify', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM firm_domains WHERE id = $1 AND firm_id = $2',
      [id, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Domain not found' });
    const dom = rows[0];

    // DNS lookup for TXT records — check _darklion.<subdomain> to avoid CNAME conflict
    const dns = require('dns').promises;
    let verified = false;
    try {
      // TXT record is at darklion.<basedomain> e.g. darklion.yourfirm.com
      const parts = dom.domain.split('.');
      const baseDomain = parts.length > 2 ? parts.slice(1).join('.') : dom.domain;
      const txtHost = `darklion.${baseDomain}`;
      const records = await dns.resolveTxt(txtHost);
      verified = records.flat().some(r => r === dom.verification_token);
    } catch (_) { /* DNS lookup failed or record not yet propagated */ }

    if (verified) {
      await pool.query(
        'UPDATE firm_domains SET verified_at = NOW() WHERE id = $1',
        [id]
      );
      invalidateDomainCache(dom.domain);
      res.json({ ok: true, verified: true, message: 'Domain verified!' });
    } else {
      res.json({ ok: false, verified: false, message: `DNS TXT record not found. Add TXT record: ${dom.verification_token}` });
    }
  } catch (err) {
    console.error('[POST /firms/domains/:id/verify]', err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// DELETE /firms/domains/:id — remove domain
router.delete('/domains/:id', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'DELETE FROM firm_domains WHERE id = $1 AND firm_id = $2 RETURNING domain',
      [id, firmId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Domain not found' });
    invalidateDomainCache(rows[0].domain);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete domain' });
  }
});

// ===================== API TOKENS =====================

// GET /firms/api-tokens — list tokens for current firm
router.get('/api-tokens', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT at.id, at.name, at.token_prefix, at.last_used_at, at.created_at, at.staff_user_id, at.scopes,
              COALESCE(NULLIF(fu.display_name,''), NULLIF(fu.name,''), fu.email) AS staff_name,
              fu.email AS staff_email
       FROM api_tokens at
       LEFT JOIN firm_users fu ON fu.id = at.staff_user_id AND fu.firm_id = at.firm_id
       WHERE at.firm_id = $1
       ORDER BY at.created_at DESC`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
});

// POST /firms/api-tokens — generate a new token
router.post('/api-tokens', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { name } = req.body;
  const staffUserId = req.body.staff_user_id || req.body.staffUserId || null;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Token name is required' });

  // Generate token: dlk_<32 random bytes hex>
  const rawToken = 'dlk_' + crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const prefix = rawToken.substring(0, 12) + '...';

  try {
    let scopedStaffId = null;
    if (staffUserId) {
      const { rows: staffRows } = await pool.query(
        'SELECT id FROM firm_users WHERE firm_id = $1 AND id = $2 AND accepted_at IS NOT NULL AND archived_at IS NULL LIMIT 1',
        [firmId, parseInt(staffUserId, 10)]
      );
      if (!staffRows[0]) return res.status(400).json({ error: 'Selected staff user is not valid' });
      scopedStaffId = staffRows[0].id;
    }
    const scopes = {
      agent_work: true,
      inbox_read: true,
      inbox_drafts: true,
      team_chat_read: true,
      team_chat_send: true,
      documents_read: true,
      documents_write: true,
      documents_delete: false,
      activity_log_read: true,
      transactions_read: true,
      transactions_write: true,
      revenue_read: true,
      general_api: true,
      summaries_read: true,
      crm_read: true,
      crm_write: true,
      pipelines_read: true,
      pipelines_write: true,
      staff_read: true,
      work_read: true,
      messages_send: true,
      bookkeeping_read: true,
      tax_deliveries_read: true,
      organizers_read: true,
      proposals_read: true,
      billing_read: true,
      investments_read: true,
      engagements_read: true,
    };
    const { rows } = await pool.query(
      `INSERT INTO api_tokens (firm_id, name, token_hash, token_prefix, staff_user_id, scopes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, token_prefix, staff_user_id, scopes, created_at`,
      [firmId, name.trim(), hash, prefix, scopedStaffId, JSON.stringify(scopes)]
    );
    // Return the raw token ONCE — it is never stored again
    res.status(201).json({ ...rows[0], token: rawToken });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create token' });
  }
});

// PATCH /firms/api-tokens/:id — assign/reassign staff scope for Agent Work
router.patch('/api-tokens/:id', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const tokenId = parseInt(req.params.id, 10);
  const staffUserId = req.body.staff_user_id || req.body.staffUserId || null;
  if (!Number.isInteger(tokenId)) return res.status(400).json({ error: 'Invalid token id' });

  try {
    let scopedStaffId = null;
    if (staffUserId) {
      const { rows: staffRows } = await pool.query(
        'SELECT id FROM firm_users WHERE firm_id = $1 AND id = $2 AND accepted_at IS NOT NULL AND archived_at IS NULL LIMIT 1',
        [firmId, parseInt(staffUserId, 10)]
      );
      if (!staffRows[0]) return res.status(400).json({ error: 'Selected staff user is not valid' });
      scopedStaffId = staffRows[0].id;
    }

    const { rows } = await pool.query(
      `UPDATE api_tokens SET staff_user_id = $3
       WHERE id = $1 AND firm_id = $2
       RETURNING id, name, token_prefix, staff_user_id, scopes, last_used_at, created_at`,
      [tokenId, firmId, scopedStaffId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Token not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update token' });
  }
});

// DELETE /firms/api-tokens/:id — revoke a token
router.delete('/api-tokens/:id', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      'DELETE FROM api_tokens WHERE id = $1 AND firm_id = $2 RETURNING id',
      [parseInt(id), firmId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Token not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

// ===================== STAFF LIST (for Emma) =====================

// GET /firms/staff — list all staff users for the firm
router.get('/staff', requireFirm, async (req, res) => {
  const firmId = req.firm.id;
  try {
    const { rows } = await pool.query(
      `SELECT id, name, display_name, email, role, last_login_at, created_at
       FROM firm_users
       WHERE firm_id = $1 AND accepted_at IS NOT NULL AND archived_at IS NULL
       ORDER BY name ASC`,
      [firmId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

// ── GET /firms/branding — get firm branding settings ─────────────────────────
router.get('/branding', requireFirm, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, email, name, slug, display_name, logo_url, portal_icon_url, portal_logo_style, primary_color, tagline,
              contact_email, phone, website, address
       FROM firms WHERE id = $1`,
      [req.firm.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Firm not found' });

    // Resolve logo URL to signed S3 URL if it's an S3 key
    const branding = rows[0];
    const preferences = await require('../services/firmPreferences').getFirmPreferences(req.firm.id);
    branding.portal_icon_preview_url = preferences.portalIconUrl;
    branding.portal_logo_style = preferences.portalLogoStyle;
    branding.client_login_url = `${requestBaseUrl(req).replace(/\/+$/, '')}/client-login${branding.slug ? `/${encodeURIComponent(branding.slug)}` : ''}`;
    if (branding.logo_url && !branding.logo_url.startsWith('http')) {
      try {
        const { getSignedDownloadUrl } = require('../services/s3');
        branding.logo_url = await getSignedDownloadUrl({
          key: branding.logo_url,
          bucket: process.env.AWS_S3_BUCKET || 'darklion-s3'
        });
      } catch (_) {}
    }

    res.json(branding);
  } catch (err) {
    console.error('GET /firms/branding error:', err);
    res.status(500).json({ error: 'Failed to fetch branding' });
  }
});

// ── PUT /firms/branding — update firm branding settings ──────────────────────
router.put('/branding', requireFirm, async (req, res) => {
  if(!['owner','admin'].includes(req.firm.role))return res.status(403).json({error:'Firm administrator required'});
  try {
    const firmId = req.firm.id;
    const { display_name, primary_color, tagline, contact_email, phone, website, address, portal_logo_style } = req.body;
    for(const [value,max] of [[display_name,100],[tagline,250],[contact_email,254],[phone,40],[website,2048],[address,500]]){
      if(value!==undefined&&(typeof value!=='string'||value.length>max||/[\r\n<>]/.test(value)))return res.status(400).json({error:'Invalid branding field'});
    }
    if(primary_color!==undefined&&!/^#[0-9a-f]{6}$/i.test(primary_color))return res.status(400).json({error:'Use a six-digit brand color'});
    if(contact_email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email))return res.status(400).json({error:'Invalid contact email'});
    if(website){try{if(new URL(website).protocol!=='https:')throw Error();}catch(_){return res.status(400).json({error:'Use an HTTPS website URL'});}}

    if (portal_logo_style !== undefined && !['icon', 'logo'].includes(portal_logo_style)) return res.status(400).json({ error: 'Choose a portal icon or firm logo' });
    const sets = [];
    const params = [];

    if (portal_logo_style !== undefined) { params.push(portal_logo_style); sets.push(`portal_logo_style = $${params.length}`); }
    if (display_name !== undefined)   { params.push(display_name);   sets.push(`display_name = $${params.length}`); }
    if (primary_color !== undefined)  { params.push(primary_color);  sets.push(`primary_color = $${params.length}`); }
    if (tagline !== undefined)        { params.push(tagline);        sets.push(`tagline = $${params.length}`); }
    if (contact_email !== undefined)  { params.push(contact_email);  sets.push(`contact_email = $${params.length}`); }
    if (phone !== undefined)          { params.push(phone);          sets.push(`phone = $${params.length}`); }
    if (website !== undefined)        { params.push(website);        sets.push(`website = $${params.length}`); }
    if (address !== undefined)        { params.push(address);        sets.push(`address = $${params.length}`); }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(firmId);
    const { rows } = await pool.query(
      `UPDATE firms SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING name, display_name, logo_url, primary_color, tagline,
                 contact_email, phone, website, address`,
      params
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /firms/branding error:', err);
    res.status(500).json({ error: 'Failed to update branding' });
  }
});

// ── POST /firms/branding/logo — upload firm logo ─────────────────────────────
router.post(['/branding/logo', '/branding/icon'], requireFirm, upload.single('logo'), async (req, res) => {
  if(!['owner','admin'].includes(req.firm.role))return res.status(403).json({error:'Firm administrator required'});
  try {
    const firmId = req.firm.id;
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });

    const mime = req.file.mimetype;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      return res.status(400).json({ error: 'Logo must be JPG, PNG, or WebP' });
    }

    const isIcon = req.path.endsWith('/icon');
    const extMap = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
    const ext = extMap[mime] || 'png';
    const key = `logos/${firmId}/${isIcon ? 'portal-icon' : 'logo'}.${ext}`;
    const bucket = process.env.AWS_S3_BUCKET || 'darklion-s3';

    const { uploadFile, getSignedDownloadUrl } = require('../services/s3');
    const clean=await sharp(req.file.buffer,{limitInputPixels:20000000}).rotate().resize(1200,1200,{fit:'inside',withoutEnlargement:true}).toFormat(ext==='jpg'?'jpeg':ext).toBuffer();
    await uploadFile({ firmId: firmId, buffer: clean, key, mimeType: mime, bucket });
    await pool.query(`UPDATE firms SET ${isIcon ? 'portal_icon_url' : 'logo_url'} = $1 WHERE id = $2`, [key, firmId]);

    const signedUrl = await getSignedDownloadUrl({ key, bucket });
    res.json({ ok: true, logo_url: signedUrl });
  } catch (err) {
    console.error('POST /firms/branding/logo error:', err);
    console.error('[logo] upload failed:', err); res.status(500).json({ error: 'Logo upload failed' });
  }
});

// ── GET /firms/tax-season — get active tax year ────────────────────────────
router.get('/tax-season', requireFirm, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT active_tax_year FROM firms WHERE id = $1',
      [req.firm.id]
    );
    res.json({ active_tax_year: rows[0]?.active_tax_year || '2025' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch tax season settings' });
  }
});

// ── PUT /firms/tax-season — update active tax year ────────────────────────────
router.put('/tax-season', requireFirm, async (req, res) => {
  try {
    const { active_tax_year } = req.body;
    if (!active_tax_year || !/^\d{4}$/.test(String(active_tax_year))) {
      return res.status(400).json({ error: 'active_tax_year must be a 4-digit year' });
    }
    const { rows } = await pool.query(
      'UPDATE firms SET active_tax_year = $1 WHERE id = $2 RETURNING active_tax_year',
      [String(active_tax_year), req.firm.id]
    );
    res.json({ active_tax_year: rows[0].active_tax_year });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update tax season settings' });
  }
});

// ── GET /firms/integrations — get integration settings ───────────────────────
router.get('/integrations', requireFirm, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT blueleaf_api_token FROM firms WHERE id = $1', [req.firm.id]);
    const token = rows[0]?.blueleaf_api_token || '';
    res.json({ blueleaf_api_token: token ? 'configured' : '' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch integration settings' });
  }
});

// ── PUT /firms/integrations — update integration settings ────────────────────
router.put('/integrations', requireFirm, async (req, res) => {
  try {
    const { blueleaf_api_token } = req.body;
    if (blueleaf_api_token === undefined) return res.status(400).json({ error: 'Nothing to update' });
    await pool.query(
      'UPDATE firms SET blueleaf_api_token = $1 WHERE id = $2',
      [blueleaf_api_token ? require('../utils/encryption').encrypt(blueleaf_api_token) : null, req.firm.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update integration settings' });
  }
});

module.exports = router;
