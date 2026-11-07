'use strict';

function apiScopeAllowed(req, scope, fallbackScope = 'general_api') {
  if (!req.firm?.isApiToken) return true;
  const scopes = req.firm.tokenScopes || {};
  if (scopes[scope] !== undefined) return scopes[scope] === true;
  return fallbackScope ? scopes[fallbackScope] !== false : false;
}

function requireApiScope(scope, fallbackScope = 'general_api') {
  return (req, res, next) => {
    if (apiScopeAllowed(req, scope, fallbackScope)) return next();
    return res.status(403).json({ error: `API token scope required: ${scope}` });
  };
}

module.exports = { apiScopeAllowed, requireApiScope };
