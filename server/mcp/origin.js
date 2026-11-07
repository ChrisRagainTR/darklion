'use strict';

function publicMcpUrl() {
  return new URL('/mcp', process.env.PUBLIC_APP_URL || process.env.APP_URL || 'http://localhost:8080');
}

function allowedOriginHosts() {
  const configured = String(process.env.MCP_ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => {
      try { return new URL(value).hostname; } catch { return value; }
    });
  const local = process.env.NODE_ENV === 'production' ? [] : ['localhost', '127.0.0.1', '[::1]'];
  return [...new Set([publicMcpUrl().hostname, ...local, ...configured])];
}

function isAllowedMcpOrigin(value) {
  try { return allowedOriginHosts().includes(new URL(value).hostname); } catch { return false; }
}

module.exports = { allowedOriginHosts, isAllowedMcpOrigin, publicMcpUrl };
