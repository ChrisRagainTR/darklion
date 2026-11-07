'use strict';

const { Router } = require('express');
const {
  createOAuthStart,
  exchangeOAuthCode,
  disconnectFirm,
  getStatus,
  listLedgerHqCompanies,
  getCompanyLink,
  saveCompanyLink,
  clearCompanyLink,
} = require('../services/ledgerhq');
const { pool } = require('../db');

const router = Router();
const publicRouter = Router();
router.use((req,res,next)=>{
  if(['/connect/start','/disconnect'].includes(req.path) && !['owner','admin'].includes(req.firm.role)) return res.status(403).json({error:'Firm administrator required'});
  next();
});

function appOrigin(req) {
  return new URL(process.env.PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:8080').origin;
}

router.get('/status', async (req, res) => {
  try {
    res.json(await getStatus(req.firm.id));
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/connect/start', async (req, res) => {
  try {
    const redirectUri = `${appOrigin(req)}/ledgerhq/oauth/callback`;
    const authorizationUrl = await createOAuthStart({
      firmId: req.firm.id,
      staffUserId: req.firm.userId,
      redirectUri,
      returnTo: typeof req.body?.returnTo==='string' && /^\/(?:settings|workspace-setup)(?:\?|$)/.test(req.body.returnTo) ? req.body.returnTo : '/settings?tab=integrations',
    });
    res.json({ authorizationUrl });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

router.post('/disconnect', async (req, res) => {
  try {
    await disconnectFirm(req.firm.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

router.get('/companies', async (req, res) => {
  try {
    const companies = await listLedgerHqCompanies(req.firm.id);
    res.json({ companies });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

router.get('/company-links/:companyId([0-9]+)', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const { rows } = await pool.query(
      `SELECT id FROM companies WHERE id = $1 AND firm_id = $2 LIMIT 1`,
      [companyId, req.firm.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json({ link: await getCompanyLink(companyId, req.firm.id) });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

router.put('/company-links/:companyId([0-9]+)', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const { providerCompanyId, providerCompanyName } = req.body || {};
    const { rows } = await pool.query(
      `SELECT id FROM companies WHERE id = $1 AND firm_id = $2 LIMIT 1`,
      [companyId, req.firm.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    const link = await saveCompanyLink({
      firmId: req.firm.id,
      companyId,
      providerCompanyId,
      providerCompanyName,
    });
    res.json({ ok: true, link });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

router.delete('/company-links/:companyId([0-9]+)', async (req, res) => {
  try {
    const companyId = parseInt(req.params.companyId, 10);
    const { rows } = await pool.query('SELECT id FROM companies WHERE id = $1 AND firm_id = $2', [companyId, req.firm.id]);
    if (!rows.length) return res.status(404).json({ error: 'Company not found' });
    await clearCompanyLink({ firmId: req.firm.id, companyId });
    res.json({ ok: true });
  } catch (err) {
    console.error('[request] failed:', err); res.status(500).json({ error: 'Request failed' });
  }
});

publicRouter.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;
    if (error) {
      return res.redirect(`/settings?tab=integrations&ledgerhq=error&message=${encodeURIComponent(error_description || error)}`);
    }
    if (!code || !state) {
      return res.redirect('/settings?tab=integrations&ledgerhq=error&message=Missing%20LedgerHQ%20OAuth%20code');
    }
    const result = await exchangeOAuthCode({ code: String(code), state: String(state) });
    const returnTo = result.returnTo || '/settings?tab=integrations';
    const separator = returnTo.includes('?') ? '&' : '?';
    res.redirect(`${returnTo}${separator}ledgerhq=connected`);
  } catch (err) {
    console.error('[ledgerhq] callback failed:', err); res.redirect('/settings?tab=integrations&ledgerhq=error');
  }
});

module.exports = { router, publicRouter };
