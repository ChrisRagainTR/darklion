'use strict';

const jwt = require('jsonwebtoken');

const DEFAULT_TIMEOUT_MS = 10_000;

class AgentWorkApiError extends Error {
  constructor(message, { status = 500, code = 'agent_work_error', details = null } = {}) {
    super(message);
    this.name = 'AgentWorkApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function loopbackBaseUrl() {
  return String(process.env.DARKLION_MCP_LOOPBACK_URL || `http://127.0.0.1:${process.env.PORT || 8080}`)
    .replace(/\/$/, '');
}

function internalToken(principal) {
  if (!process.env.JWT_SECRET) throw new AgentWorkApiError('MCP internal authentication is not configured');
  return jwt.sign({
    firm_id: principal.firmId,
    staff_user_id: principal.staffUserId,
    scopes: principal.scopes || [],
    client_id: principal.clientId,
  }, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: 30,
    issuer: 'darklion-mcp',
    audience: 'darklion-agent-work',
    subject: String(principal.staffUserId),
  });
}

async function callAgentWork(principal, path, { method = 'GET', query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(`/api/agent-work${path}`, loopbackBaseUrl());
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${internalToken(principal)}`,
        'X-DarkLion-Internal-MCP': '1',
        ...(process.env.DARKLION_ISOLATED_STAGING === 'true' && process.env.DARKLION_STAGING_ACCESS_KEY
          ? { 'X-DarkLion-Staging-Key': process.env.DARKLION_STAGING_ACCESS_KEY } : {}),
        'X-Forwarded-Proto': 'https',
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { error: (raw || response.statusText).slice(0, 1000) }; }
    if (!response.ok) {
      throw new AgentWorkApiError(payload.error || `Agent Work API returned ${response.status}`, {
        status: response.status,
        code: payload.code || `agent_work_${response.status}`,
        details: response.status < 500 ? payload : null,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof AgentWorkApiError) throw error;
    if (error.name === 'AbortError') {
      throw new AgentWorkApiError(`Agent Work API timed out after ${timeoutMs}ms`, { status: 504, code: 'agent_work_timeout' });
    }
    throw new AgentWorkApiError('Agent Work API is unavailable', {
      status: 503,
      code: 'agent_work_unavailable',
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { AgentWorkApiError, callAgentWork, internalToken };
