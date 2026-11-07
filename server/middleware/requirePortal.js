const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const portalSession = require('../services/portalSession');

// Verifies a portal token (client session or advisor preview) and returns the request's
// portal identity. Throws on any problem; callers turn that into a 401.
async function verifyPortalToken(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);

  if (payload.type !== 'portal') {
    throw Object.assign(new Error('Invalid token type'), { code: 'INVALID_TOKEN_TYPE' });
  }

  const firmId = Number(payload.firmId), personId = Number(payload.personId);
  const signerRole = payload.signerRole || 'taxpayer';
  if (!Number.isSafeInteger(firmId) || firmId < 1 || !Number.isSafeInteger(personId) || personId < 1 || !['taxpayer','spouse'].includes(signerRole)) throw new Error('Invalid account');
  const { rows } = await pool.query(`SELECT id,firm_id,relationship_id,email,first_name,last_name,spouse_name,spouse_email,
    portal_enabled,spouse_portal_enabled FROM people WHERE id=$1 AND firm_id=$2`, [personId, firmId]);
  const person = rows[0];
  if(!person)throw new Error('Portal account unavailable');
  if(payload.ghostedBy){
    const staff=(await pool.query('SELECT id FROM firm_users WHERE id=$1 AND firm_id=$2 AND accepted_at IS NOT NULL AND archived_at IS NULL',[payload.ghostedBy,firmId])).rows[0];
    if(!staff||!payload.previewStaff)throw new Error('Preview expired');
    await require('../services/accountSecurity').validateSession({firmId,kind:'staff',accountId:staff.id},payload.previewStaff);
  }else{
    if(!(signerRole === 'spouse' ? person.spouse_portal_enabled : person.portal_enabled))throw new Error('Portal access removed');
    await require('../services/accountSecurity').validateSession({ firmId, kind: 'portal', accountId: personId, signerRole }, payload);
  }

  return {
    personId, firmId, relationshipId: person.relationship_id,
    email: signerRole === 'spouse' ? person.spouse_email : person.email,
    name: signerRole === 'spouse' ? person.spouse_name : `${person.first_name} ${person.last_name}`.trim(),
    signerRole, sessionId: payload.sid || null, preview: !!payload.ghostedBy,
    previewByName: payload.ghostedBy ? String(payload.ghostedByName || 'Your advisor') : null,
  };
}

function portalAuthError(res, err) {
  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({ error: 'Token expired — please log in again', expired: true });
  }
  if (err.code === 'INVALID_TOKEN_TYPE') return res.status(401).json({ error: 'Invalid token type' });
  return res.status(401).json({ error: 'Invalid token' });
}

// Accepts "Authorization: Bearer <token>" (native app, phone web app, migration, preview)
// or the HttpOnly portal_session cookie (web portal). Cookie-authenticated writes must come
// from a page on this same host (CSRF guard); Bearer requests are not affected by that check.
async function requirePortal(req, res, next) {
  const { token, source } = portalSession.portalCredential(req);
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (source === 'cookie' && !portalSession.isSafeMethod(req.method) && !portalSession.sameOriginRequest(req)) {
    return res.status(403).json({ error: 'Cross-site request blocked' });
  }

  let portal;
  try {
    portal = await verifyPortalToken(token);
  } catch (err) {
    return portalAuthError(res, err);
  }
  if (portal.preview && !['GET','HEAD'].includes(req.method)) return res.status(403).json({error:'Advisor preview is read-only'});

  req.portal = portal;
  req.portalAuthSource = source;
  return require('../services/subscriptions').requireSubscription({
    firm:{id:portal.firmId},method:req.method,originalUrl:req.originalUrl
  },res,next);
}

module.exports = { requirePortal, verifyPortalToken, portalAuthError };
