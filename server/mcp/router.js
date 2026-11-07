'use strict';

const { Router } = require('express');
const { McpServer, OAuthError, OAuthErrorCode } = require('@modelcontextprotocol/server');
const { NodeStreamableHTTPServerTransport } = require('@modelcontextprotocol/node');
const { originValidation, requireBearerAuth } = require('@modelcontextprotocol/express');
const { authenticateMcpAccessToken } = require('../services/mcpOAuth');
const { registerDarkLionTools, requiredScopeForTool } = require('./tools');
const { allowedOriginHosts, publicMcpUrl } = require('./origin');

function requiredScopesForBody(body) {
  const requests = Array.isArray(body) ? body : [body];
  const scopes = new Set(['darklion:read']);
  for (const message of requests) {
    if (message?.method === 'tools/call') scopes.add(requiredScopeForTool(message?.params?.name));
  }
  return [...scopes];
}

function requiredScopeForBody(body) {
  const scopes = requiredScopesForBody(body);
  return scopes.find(scope => scope !== 'darklion:read') || 'darklion:read';
}

const verifier = {
  async verifyAccessToken(token) {
    try {
      const principal = await authenticateMcpAccessToken(token);
      if (principal.resource !== publicMcpUrl().href) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'Access token was issued for a different resource');
      }
      return {
        token,
        clientId: principal.clientId,
        scopes: principal.scopes,
        expiresAt: principal.expiresAt,
        ...(principal.resource ? { resource: new URL(principal.resource) } : {}),
        darklion: principal,
      };
    } catch (error) {
      if (error instanceof OAuthError) throw error;
      const code = error.code === 'insufficient_scope' || error.status === 403
        ? OAuthErrorCode.InsufficientScope
        : OAuthErrorCode.InvalidToken;
      throw new OAuthError(code, error.message || 'Invalid access token');
    }
  },
};

function createDarkLionMcpRouter() {
  const router = Router();
  const resourceMetadataUrl = new URL('/.well-known/oauth-protected-resource/mcp', publicMcpUrl()).href;
  router.use(originValidation(allowedOriginHosts()));
  router.use(requireBearerAuth({
    verifier,
    requiredScopes: ['darklion:read'],
    resourceMetadataUrl,
  }));

  router.use((req, res, next) => {
    const missingScopes = requiredScopesForBody(req.body).filter(scope => !req.auth?.scopes?.includes(scope));
    if (!missingScopes.length) return next();
    const required = missingScopes.join(' ');
    res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${required}", resource_metadata="${resourceMetadataUrl}"`);
    return res.status(403).json({ error: 'insufficient_scope', error_description: `This tool requires ${required}.`, scope: required });
  });

  router.post('/', async (req, res) => {
    const principal = req.auth?.darklion;
    if (!principal) return res.status(401).json({ error: 'invalid_token', error_description: 'Missing OAuth principal' });

    const server = new McpServer({ name: 'darklion', version: '1.0.0' });
    registerDarkLionTools(server, principal);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal MCP error' }, id: null });
    }
  });

  router.all('/', (req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'method_not_allowed' });
  });
  return router;
}

module.exports = { createDarkLionMcpRouter, requiredScopeForBody, requiredScopesForBody, verifier };
