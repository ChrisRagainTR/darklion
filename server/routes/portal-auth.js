const { Router } = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { pool } = require('../db');
const { resolveLoginFirm } = require('../services/loginIdentity');
const { auditLog } = require('../services/audit');
const { requireFirm } = require('../middleware/requireFirm');
const { sendPasswordReset } = require('../services/email');
const { sendPortalInviteForPerson } = require('../services/portalAccess');

// PORTAL_URL is used for client-facing invite/reset links — can differ from APP_URL in dev
// Set PORTAL_URL when clients reach the portal at a different address than staff
const APP_URL = (process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');
const PORTAL_URL = (process.env.PORTAL_URL || process.env.APP_URL || 'http://localhost:8080').replace(/\/+$/, '');

const router = Router();

const BCRYPT_ROUNDS = 12;
const PORTAL_JWT_EXPIRES_IN = '7d';

// --- Rate limiter for portal login ---
const portalLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: false,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});
router.use(['/forgot-password','/reset-password','/invite'],rateLimit({windowMs:15*60*1000,limit:20,standardHeaders:false,legacyHeaders:false,validate:{trustProxy:false}}));

// --- Password validation ---
function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}

// --- Build portal JWT ---
async function buildPortalToken(person, firmId, signerRole = 'taxpayer', proof, req) {
  return require('../services/accountSecurity').createSession(
    { firmId, kind: 'portal', accountId: person.id, signerRole },
    { personId: person.id, firmId, type: 'portal', signerRole }, require('../services/accountSecurity').deviceLabelFromRequest(req), proof);
}

// Web sign-in (portal-login.html sends session:'cookie' from this same site): the session
// goes into the HttpOnly cookie and the token stays out of the response, so page scripts
// never see it. Everyone else (native app, phone web app) gets the token as before.
function portalSessionBody(req, res, token) {
  const portalSession = require('../services/portalSession');
  if (portalSession.wantsWebSession(req) && portalSession.setSessionCookie(req, res, token)) return { session: 'cookie' };
  return { token };
}

// --- POST /portal-auth/login ---
router.post('/login', portalLoginLimiter, async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const firmId = await resolveLoginFirm(email, pool);
    const { rows } = await pool.query(`
      SELECT p.*, identity.signer_role, f.name AS firm_name
      FROM people p
      JOIN firms f ON f.id = p.firm_id
      CROSS JOIN LATERAL (
        SELECT 'taxpayer' AS signer_role
        WHERE LOWER(TRIM(p.email)) = $1 AND p.portal_enabled = true AND p.portal_password_hash IS NOT NULL
        UNION ALL
        SELECT 'spouse' AS signer_role
        WHERE LOWER(TRIM(p.spouse_email)) = $1 AND p.spouse_portal_enabled = true AND p.spouse_portal_password_hash IS NOT NULL
      ) identity
      WHERE p.firm_id = $2
      LIMIT 2
    `, [email, firmId]);
    const person = rows.length === 1 ? rows[0] : null;
    const signerRole = person?.signer_role || 'taxpayer';

    // Timing-safe: always run bcrypt
    const dummyHash = '$2b$12$invalidhashfortiming0000000000000000000000000000000000000';
    let hashToCheck = dummyHash;
    if (person) {
      hashToCheck = signerRole === 'spouse'
        ? (person.spouse_portal_password_hash || dummyHash)
        : (person.portal_password_hash || dummyHash);
    }
    const match = person
      ? await bcrypt.compare(password, hashToCheck)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!person || !match) {
      await auditLog(person?.firm_id || null, 'portal_login_fail', `Failed portal login: ${email}`, ip);
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const proof=await require('../services/accountSecurity').requireLoginMfa({ firmId: person.firm_id, kind: 'portal', accountId: person.id, signerRole }, req.body.mfaCode, signerRole==='spouse'?person.spouse_portal_password_hash:person.portal_password_hash);

    // Update last login timestamp for the appropriate login type
    if (signerRole === 'spouse') {
      await pool.query('UPDATE people SET spouse_portal_last_login_at = NOW() WHERE id = $1', [person.id]);
    } else {
      await pool.query('UPDATE people SET portal_last_login_at = NOW() WHERE id = $1', [person.id]);
    }
    await auditLog(person.firm_id, 'portal_login_success', `Portal login (${signerRole}): ${email}`, ip);

    const token = await buildPortalToken(person, person.firm_id, signerRole, proof, req);

    res.json({
      ...portalSessionBody(req, res, token),
      person: {
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        firmName: person.firm_name,
        signerRole,
      },
    });
  } catch (err) {
    if (err.code === 'MFA_REQUIRED') return res.status(401).json({ error: err.message, code: err.code });
    console.error('Portal login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// --- GET /portal-auth/invite/:token ---
router.get('/invite/:token', async (req, res) => {
  try {
    const { token } = req.params;
    // Check primary invite token first, then spouse invite token
    const { rows } = await pool.query(
      `SELECT p.email, p.first_name, p.last_name, p.portal_enabled,
              p.portal_invite_expires_at, f.name as firm_name,
              p.spouse_name, p.spouse_email, p.spouse_portal_enabled,
              p.spouse_portal_invite_expires_at,
              CASE WHEN p.portal_invite_token = $1 THEN 'taxpayer' ELSE 'spouse' END as invite_type
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.portal_invite_token = $1 OR p.spouse_portal_invite_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      return res.json({ valid: false, expired: false, alreadyAccepted: false });
    }

    const inv = rows[0];
    const isSpouse = inv.invite_type === 'spouse';
    const expired = isSpouse
      ? (inv.spouse_portal_invite_expires_at && new Date(inv.spouse_portal_invite_expires_at) < new Date())
      : (inv.portal_invite_expires_at && new Date(inv.portal_invite_expires_at) < new Date());
    const alreadyAccepted = isSpouse ? !!inv.spouse_portal_enabled : !!inv.portal_enabled;
    const displayEmail = isSpouse ? inv.spouse_email : inv.email;
    const displayName = isSpouse ? (inv.spouse_name || 'Spouse') : `${inv.first_name} ${inv.last_name}`.trim();

    res.json({
      valid: !expired && !alreadyAccepted,
      email: displayEmail,
      firstName: displayName.split(' ')[0] || inv.first_name,
      lastName: displayName.split(' ').slice(1).join(' ') || inv.last_name,
      firmName: inv.firm_name,
      expired: !!expired,
      alreadyAccepted,
    });
  } catch (err) {
    console.error('Invite lookup error:', err);
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

// --- POST /portal-auth/invite/:token/accept ---
router.post('/invite/:token/accept', async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    // Check primary portal_invite_token first, then spouse_portal_invite_token
    let { rows } = await pool.query(
      `SELECT p.*, f.name as firm_name, 'taxpayer' as signer_role
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.portal_invite_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      // Try spouse token
      const spouseResult = await pool.query(
        `SELECT p.*, f.name as firm_name, 'spouse' as signer_role
         FROM people p
         JOIN firms f ON f.id = p.firm_id
         WHERE p.spouse_portal_invite_token = $1`,
        [token]
      );
      rows = spouseResult.rows;
    }

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
    const person = rows[0];
    const signerRole = person.signer_role;

    if (signerRole === 'spouse') {
      const expired = person.spouse_portal_invite_expires_at && new Date(person.spouse_portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Invite link has expired' });
      if (person.spouse_portal_enabled && person.spouse_portal_password_hash) return res.status(409).json({ error: 'Invite already accepted' });

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const changed=await pool.query(
        `UPDATE people SET
           spouse_portal_enabled = true,
           spouse_portal_password_hash = $1,
           spouse_portal_invite_token = NULL,
           spouse_portal_invite_expires_at = NULL,
           spouse_portal_last_login_at = NOW()
         WHERE id = $2 AND spouse_portal_invite_token=$3 AND spouse_portal_invite_expires_at>NOW()`,
        [passwordHash, person.id, token]
      );
      if(!changed.rowCount)return res.status(409).json({error:'Link expired or already used'});
      await auditLog(person.firm_id, 'portal_invite_accepted', `${person.spouse_email} accepted spouse portal invite`, ip);
    } else {
      const expired = person.portal_invite_expires_at && new Date(person.portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Invite link has expired' });
      if (person.portal_enabled) return res.status(409).json({ error: 'Invite already accepted' });

      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const changed=await pool.query(
        `UPDATE people SET
           portal_enabled = true,
           portal_password_hash = $1,
           portal_invite_token = NULL,
           portal_invite_expires_at = NULL,
           portal_last_login_at = NOW()
         WHERE id = $2 AND portal_invite_token=$3 AND portal_invite_expires_at>NOW()`,
        [passwordHash, person.id, token]
      );
      if(!changed.rowCount)return res.status(409).json({error:'Link expired or already used'});
      await auditLog(person.firm_id, 'portal_invite_accepted', `${person.email} accepted portal invite`, ip);
    }

    const security = await require('../services/accountSecurity').ensureAccount({ firmId: person.firm_id, kind: 'portal', accountId: person.id, signerRole });
    if (security.mfa_enabled) return res.json({ signInRequired: true, mfaRequired: true });
    const jwtToken = await buildPortalToken(person, person.firm_id, signerRole, undefined, req);

    res.json({
      ...portalSessionBody(req, res, jwtToken),
      person: {
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        firmName: person.firm_name,
        signerRole,
      },
    });
  } catch (err) {
    console.error('Invite accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// --- POST /portal-auth/forgot-password ---
router.post('/forgot-password', async (req, res) => {
  const ip = req.ip;
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    // Always return ok to prevent email enumeration
    if (!email) return res.json({ ok: true });
    const firmId = await resolveLoginFirm(email, pool);

    const { rows } = await pool.query(`
      SELECT p.*, f.name AS firm_name, f.slug AS firm_slug, identity.signer_role
      FROM people p
      JOIN firms f ON f.id = p.firm_id
      CROSS JOIN LATERAL (
        SELECT 'taxpayer' AS signer_role
        WHERE LOWER(TRIM(p.email)) = $1 AND (
          p.portal_enabled = true OR (
            p.portal_invite_token IS NOT NULL AND (
              p.portal_password_hash IS NOT NULL OR
              p.portal_invite_expires_at IS NULL OR p.portal_invite_expires_at > NOW()
            )
          )
        )
        UNION ALL
        SELECT 'spouse' AS signer_role
        WHERE LOWER(TRIM(p.spouse_email)) = $1 AND (
          p.spouse_portal_enabled = true OR (
            p.spouse_portal_invite_token IS NOT NULL AND (
              p.spouse_portal_password_hash IS NOT NULL OR
              p.spouse_portal_invite_expires_at IS NULL OR p.spouse_portal_invite_expires_at > NOW()
            )
          )
        )
      ) identity
      WHERE p.firm_id = $2
      LIMIT 2
    `, [email, firmId]);

    // Respond before doing any per-account work so response time doesn't reveal whether the email exists.
    res.json({ ok: true });
    if (rows.length === 1) setImmediate(async () => { try {
      const person = rows[0];
      const signerRole = person.signer_role;
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      if (signerRole === 'spouse') {
        await pool.query(
          `UPDATE people SET spouse_portal_invite_token = $1, spouse_portal_invite_expires_at = $2 WHERE id = $3`,
          [resetToken, expiresAt, person.id]
        );
      } else {
        await pool.query(
          `UPDATE people SET portal_invite_token = $1, portal_invite_expires_at = $2 WHERE id = $3`,
          [resetToken, expiresAt, person.id]
        );
      }

      await auditLog(person.firm_id, 'portal_password_reset_requested', `Password reset requested: ${email} (${signerRole})`, ip);

      // Send reset email (graceful — don't fail if email service is down)
      try {
        const firmName = person.firm_name || 'Your Advisory Firm';
        const resetUrl = `${PORTAL_URL}/client-login${person.firm_slug ? `/${encodeURIComponent(person.firm_slug)}` : ''}?reset=${resetToken}`;
        const toEmail = signerRole === 'spouse' ? person.spouse_email : person.email;
        const toName = signerRole === 'spouse'
          ? (person.spouse_name || 'Spouse')
          : `${person.first_name} ${person.last_name}`.trim();
        await sendPasswordReset({
          to: toEmail,
          name: toName,
          firmName,
          firmId: person.firm_id,
          resetUrl,
        });
      } catch (emailErr) {
        await auditLog(person.firm_id, 'portal_password_reset_email_failed', `Password reset email failed: ${email} (${signerRole})`, ip);
        console.error('Password reset email failed (non-fatal):', emailErr.message);
      }
    } catch (resetErr) {
      console.error('Forgot password background error:', resetErr);
    } });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Request failed. Please try again.' });
  }
});

// --- POST /portal-auth/reset-password/:token ---
router.post('/reset-password/:token', async (req, res) => {
  const ip = req.ip;
  try {
    const { token } = req.params;
    const { password } = req.body;

    if (!password) return res.status(400).json({ error: 'Password is required' });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });

    // Check primary token first, then spouse token
    let { rows } = await pool.query(
      `SELECT p.*, f.name as firm_name, 'taxpayer' as signer_role
       FROM people p
       JOIN firms f ON f.id = p.firm_id
       WHERE p.portal_invite_token = $1`,
      [token]
    );

    if (rows.length === 0) {
      const spouseResult = await pool.query(
        `SELECT p.*, f.name as firm_name, 'spouse' as signer_role
         FROM people p
         JOIN firms f ON f.id = p.firm_id
         WHERE p.spouse_portal_invite_token = $1`,
        [token]
      );
      rows = spouseResult.rows;
    }

    if (rows.length === 0) return res.status(404).json({ error: 'Invalid or expired reset link' });
    const person = rows[0];
    const signerRole = person.signer_role;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    if (signerRole === 'spouse') {
      const expired = person.spouse_portal_invite_expires_at && new Date(person.spouse_portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Reset link has expired' });

      const changed=await pool.query(
        `UPDATE people SET
           spouse_portal_enabled = true,
           spouse_portal_password_hash = $1,
           spouse_portal_invite_token = NULL,
           spouse_portal_invite_expires_at = NULL,
           spouse_portal_last_login_at = NOW()
         WHERE id = $2 AND spouse_portal_invite_token=$3 AND spouse_portal_invite_expires_at>NOW()`,
        [passwordHash, person.id, token]
      );
      if(!changed.rowCount)return res.status(409).json({error:'Link expired or already used'});
      await auditLog(person.firm_id, 'portal_password_reset', `Spouse password reset completed: ${person.spouse_email}`, ip);
    } else {
      const expired = person.portal_invite_expires_at && new Date(person.portal_invite_expires_at) < new Date();
      if (expired) return res.status(410).json({ error: 'Reset link has expired' });

      const changed=await pool.query(
        `UPDATE people SET
           portal_enabled = true,
           portal_password_hash = $1,
           portal_invite_token = NULL,
           portal_invite_expires_at = NULL,
           portal_last_login_at = NOW()
         WHERE id = $2 AND portal_invite_token=$3 AND portal_invite_expires_at>NOW()`,
        [passwordHash, person.id, token]
      );
      if(!changed.rowCount)return res.status(409).json({error:'Link expired or already used'});
      await auditLog(person.firm_id, 'portal_password_reset', `Password reset completed: ${person.email}`, ip);
    }

    const security = await require('../services/accountSecurity').ensureAccount({ firmId: person.firm_id, kind: 'portal', accountId: person.id, signerRole });
    if (security.mfa_enabled) return res.json({ signInRequired: true, mfaRequired: true });
    const jwtToken = await buildPortalToken(person, person.firm_id, signerRole, undefined, req);

    res.json({
      ...portalSessionBody(req, res, jwtToken),
      person: {
        firstName: person.first_name,
        lastName: person.last_name,
        email: person.email,
        firmName: person.firm_name,
        signerRole,
      },
    });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// --- Web session cookie (S3c) ---
const portalSessionLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: false, legacyHeaders: false, validate: { trustProxy: false } });

// POST /portal-auth/session/adopt — moves a token the page already holds (a session saved in
// browser storage before the cookie existed, or an advisor preview link) into the HttpOnly
// cookie, so later page loads need no token in page scripts. Validated exactly like a portal
// request; preview tokens stay read-only because requirePortal enforces that per request.
router.post('/session/adopt', portalSessionLimiter, async (req, res) => {
  const portalSession = require('../services/portalSession');
  if (!portalSession.sameOriginRequest(req)) return res.status(403).json({ error: 'Cross-site request blocked' });
  const token = portalSession.bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const { verifyPortalToken, portalAuthError } = require('../middleware/requirePortal');
  let portal;
  try { portal = await verifyPortalToken(token); }
  catch (err) { return portalAuthError(res, err); }
  if (!portalSession.setSessionCookie(req, res, token)) return res.status(401).json({ error: 'Token expired — please log in again', expired: true });
  res.json({ ok: true, preview: portal.preview });
});

// POST /portal-auth/session/logout — ends the web session on the server (same as
// /portal/account-security/sessions/current/revoke) and clears the cookie. Works even when
// the session is already expired or revoked, so signing out always clears the browser.
router.post('/session/logout', portalSessionLimiter, async (req, res) => {
  const portalSession = require('../services/portalSession');
  const fromCookie = portalSession.cookieToken(req);
  const fromBearer = portalSession.bearerToken(req);
  if (fromCookie && !portalSession.sameOriginRequest(req)) return res.status(403).json({ error: 'Cross-site request blocked' });
  const security = require('../services/accountSecurity');
  for (const token of new Set([fromCookie, fromBearer].filter(Boolean))) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      // Advisor preview tokens carry the advisor's staff session; never revoke that here.
      if (payload.type !== 'portal' || payload.ghostedBy || !payload.sid) continue;
      const account = { firmId: payload.firmId, kind: 'portal', accountId: payload.personId, signerRole: payload.signerRole || 'taxpayer' };
      await pool.query(
        `UPDATE account_sessions SET revoked_at=NOW() WHERE ${security.columns} AND id=$5 AND revoked_at IS NULL`,
        [...security.identity(account), payload.sid],
      );
    } catch (_) { /* expired or invalid: nothing to revoke */ }
  }
  portalSession.clearSessionCookie(req, res);
  res.json({ ok: true });
});

// --- GET /portal-auth/firm-info ---
router.get('/firm-info', async (req, res) => {
  try {
    const slug = String(req.domainFirm?.slug || req.query.slug || '').trim().toLowerCase();

    let query;
    let params;

    if (slug) {
      query = 'SELECT id, name, slug FROM firms WHERE slug = $1 LIMIT 1';
      params = [slug];
    } else {
      query = "SELECT id, name, slug FROM firms WHERE (SELECT COUNT(*) FROM firms)=1 LIMIT 1";
      params = [];
    }

    const { rows } = await pool.query(query, params);

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Firm not found' });
    }

    const firm = rows[0];
    const preferences=await require('../services/firmPreferences').getFirmPreferences(firm.id);
    // Public endpoint: return branding only, never staff, security or AI settings.
    res.json({
      firmName: preferences.name,
      primaryColor: preferences.primaryColor,
      logoUrl: preferences.logoUrl,
      portalLogoUrl: preferences.portalLogoUrl,
      portalLogoStyle: preferences.portalLogoStyle,
      portalIconUrl: preferences.portalIconUrl,
      appName: preferences.appName,
      appStoreUrl: preferences.appStoreUrl,
    });
  } catch (err) {
    console.error('Firm info error:', err);
    res.status(500).json({ error: 'Failed to fetch firm info' });
  }
});

// --- POST /portal-auth/send-invite (staff only — requires firm JWT) ---
router.post('/send-invite', requireFirm, async (req, res) => {
  const ip = req.ip;
  try {
    const { personId, spouse = false } = req.body;
    if (!personId) return res.status(400).json({ error: 'personId is required' });

    const firmId = req.firm.id;

    const invite = await sendPortalInviteForPerson({
      personId,
      firmId,
      spouse,
      ip,
      sendEmail: true,
      reusePending: false,
    });

    res.json({ ok: true, inviteUrl: invite.inviteUrl, inviteExpiresAt: invite.inviteExpiresAt, emailSent: invite.emailSent });
  } catch (err) {
    console.error('Send invite error:', err);
    res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to send invite' });
  }
});

// --- GET /portal-auth/firm-logo/:firmId --- (public, no auth — stable URL for emails)
router.get(['/firm-logo/:firmId', '/firm-icon/:firmId'], async (req, res) => {
  try {
    const { pool } = require('../db');
    const { downloadFile } = require('../services/s3');
    const column = req.path.startsWith('/firm-icon/') ? 'portal_icon_url' : 'logo_url';
    const { rows } = await pool.query(`SELECT ${column} AS image_url FROM firms WHERE id = $1`, [req.params.firmId]);
    const logoKey = rows[0]?.image_url;
    if (!logoKey) return res.status(404).send('Not found');
    // Allow email clients (cross-origin) to load this image
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // If already a full URL, redirect directly
    if (logoKey.startsWith('http')) return res.redirect(logoKey);
    // Stream the image instead of redirecting, so storage bucket and credentials never reach the browser.
    const image = await downloadFile({
      key: logoKey,
      bucket: process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || 'darklion-docs',
    });
    res.type(path.extname(logoKey) || 'png').send(image);
  } catch(err) {
    res.status(404).send('Not found');
  }
});

module.exports = router;
