'use strict';

const { isAllowedMcpOrigin } = require('./origin');

function mcpCors(req, res, next) {
  if (req.path !== '/mcp' && req.path !== '/mcp/') return next();
  const origin = req.headers.origin;
  if (origin && !isAllowedMcpOrigin(origin)) {
    return res.status(403).json({ error: 'origin_not_allowed' });
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

module.exports = { mcpCors };
