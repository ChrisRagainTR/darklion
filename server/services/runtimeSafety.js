'use strict';

const path = require('node:path');
const { appendFile, mkdir } = require('node:fs/promises');
const { randomUUID, timingSafeEqual } = require('node:crypto');

function isolatedStaging(env = process.env) {
  return env.DARKLION_ISOLATED_STAGING === 'true';
}

function backgroundJobsEnabled(env = process.env) {
  return env.BACKGROUND_JOBS_ENABLED !== 'false';
}

// This validates application controls. Infrastructure credential scope and the
// absence of production data must also be verified by the staging operator.
function assertRuntimeSafety(env = process.env) {
  if (env.NODE_ENV === 'production' && (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || '') || (env.JWT_SECRET || '').length < 32)) {
    throw new Error('PRODUCTION_REQUIRES_STRONG_SECRETS');
  }
  if (env.DARKLION_ISOLATED_STAGING && !['true', 'false'].includes(env.DARKLION_ISOLATED_STAGING)) {
    throw new Error('INVALID_ISOLATED_STAGING_FLAG');
  }
  if (env.BACKGROUND_JOBS_ENABLED && !['true', 'false'].includes(env.BACKGROUND_JOBS_ENABLED)) {
    throw new Error('INVALID_BACKGROUND_JOBS_FLAG');
  }
  if (!isolatedStaging(env)) {
    if (env.RAILWAY_ENVIRONMENT_NAME === 'staging') throw new Error('STAGING_REQUIRES_ISOLATION_CONTROLS');
    if (env.OUTBOUND_DELIVERY_MODE && env.OUTBOUND_DELIVERY_MODE !== 'live') {
      throw new Error('CAPTURE_REQUIRES_ISOLATED_STAGING');
    }
    return;
  }
  if (!['staging', 'test'].includes(env.RAILWAY_ENVIRONMENT_NAME)) throw new Error('INVALID_STAGING_ENVIRONMENT');
  if (env.BACKGROUND_JOBS_ENABLED !== 'false') throw new Error('STAGING_REQUIRES_DISABLED_JOBS');
  if (env.OUTBOUND_DELIVERY_MODE !== 'capture') throw new Error('STAGING_REQUIRES_CAPTURE');
  if (!env.DARKLION_CAPTURE_DIR || !path.isAbsolute(env.DARKLION_CAPTURE_DIR)) throw new Error('STAGING_REQUIRES_CAPTURE_DIRECTORY');
  if ((env.DARKLION_STAGING_ACCESS_KEY || '').length < 32) throw new Error('STAGING_REQUIRES_ACCESS_KEY');
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || '') || (env.JWT_SECRET || '').length < 32) {
    throw new Error('STAGING_REQUIRES_STRONG_SECRETS');
  }
  for (const name of Object.keys(env)) {
    const stagingSecrets = ['JWT_SECRET', 'ENCRYPTION_KEY', 'DARKLION_STAGING_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'STAGING_STAFF_PASSWORD', 'STAGING_CLIENT_PASSWORD', 'COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY'];
    if (env[name] && /(?:API_KEY|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|AUTH_TOKEN|PRIVATE_KEY|PASSWORD|SECRET_ACCESS_KEY)$/.test(name) && !stagingSecrets.includes(name)) {
      throw new Error('STAGING_FORBIDS_PROVIDER_VARIABLE_' + name);
    }
    if (env[name] && /^(RESEND_API_KEY|TWILIO_.+|PUSHER_.+|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|QB_.+|GUSTO_.+|STRIPE_KEY_.+|STRIPE_SECRET_KEY|FINNHUB_API_KEY|GOOGLE_SERVICES?_ACCOUNT_JSON|TELEGRAM_.+|EMAIL_INBOUND_WEBHOOK_SECRET|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|COMPLIANCE_ARCHIVE_BUCKET)$/.test(name)) {
      throw new Error('STAGING_FORBIDS_PROVIDER_VARIABLE_' + name);
    }
  }
  if (env.DOCUMENT_STORAGE_READ_PROVIDER !== 'r2' || env.DOCUMENT_STORAGE_WRITE_PROVIDER !== 'r2') {
    throw new Error('STAGING_REQUIRES_R2_STORAGE');
  }
  for (const name of ['AWS_S3_BUCKET', 'R2_DOCUMENT_BUCKET', 'R2_HISTORY_BUCKET']) {
    if (!/^darklion-(staging|recovery)-[a-z0-9-]+$/.test(env[name] || '')) throw new Error('INVALID_STAGING_BUCKET_' + name);
  }
  if (env.R2_DOCUMENT_BUCKET === env.R2_HISTORY_BUCKET) throw new Error('STAGING_REQUIRES_SEPARATE_HISTORY');
  if (env.COMMUNICATION_ARCHIVE_FAIL_CLOSED === 'false' || env.COMMUNICATION_ARCHIVE_ALLOW_LOCAL_FALLBACK === 'true') {
    throw new Error('STAGING_MUST_PRESERVE_ARCHIVE_FAILURES');
  }
  const archiveVariables = ['COMMUNICATION_ARCHIVE_BUCKET', 'COMMUNICATION_ARCHIVE_ACCESS_KEY_ID',
    'COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY', 'COMMUNICATION_ARCHIVE_SESSION_TOKEN', 'COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER'];
  if (archiveVariables.some(name => env[name])) {
    if (!/^darklion-(staging|recovery)-communications-[a-z0-9-]+$/.test(env.COMMUNICATION_ARCHIVE_BUCKET || '')
        || !env.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID || !env.COMMUNICATION_ARCHIVE_SECRET_ACCESS_KEY) {
      throw new Error('STAGING_REQUIRES_DEDICATED_LOCKED_ARCHIVE');
    }
    if (env.COMMUNICATION_ARCHIVE_STORAGE_PROVIDER === 'r2') {
      require('./communicationArchiveR2').r2Configuration(env);
      if (env.COMMUNICATION_ARCHIVE_BUCKET === env.R2_DOCUMENT_BUCKET || env.COMMUNICATION_ARCHIVE_BUCKET === env.R2_HISTORY_BUCKET
          || env.COMMUNICATION_ARCHIVE_ACCESS_KEY_ID === env.R2_ACCESS_KEY_ID) {
        throw new Error('STAGING_REQUIRES_SEPARATE_ARCHIVE');
      }
    } else if (env.COMMUNICATION_ARCHIVE_STORAGE_PROVIDER !== 'aws'
        || !/^\d{12}$/.test(env.COMMUNICATION_ARCHIVE_EXPECTED_BUCKET_OWNER || '')
        || !env.COMMUNICATION_ARCHIVE_REGION || env.COMMUNICATION_ARCHIVE_OBJECT_LOCK_ENABLED !== 'true') {
      throw new Error('STAGING_REQUIRES_DEDICATED_LOCKED_ARCHIVE');
    }
  }
}

// Health probes remain public. The rest of staging requires a separate operator
// credential, independent of staff/client bearer tokens and registration rules.
function stagingAccess(env = process.env) {
  if (!isolatedStaging(env)) return (_req, _res, next) => next();
  assertRuntimeSafety(env);
  const expected = Buffer.from(env.DARKLION_STAGING_ACCESS_KEY);
  const matches = value => {
    const actual = Buffer.from(String(value || ''));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  return (req, res, next) => {
    let supplied = req.get('X-DarkLion-Staging-Key');
    const basic = /^Basic (\S+)$/i.exec(req.get('Authorization') || '');
    if (!supplied && basic) {
      const decoded = Buffer.from(basic[1], 'base64').toString();
      if (decoded.startsWith('staging:')) supplied = decoded.slice(8);
    }
    const cookie = (req.get('Cookie') || '').split(';').map(v => v.trim()).find(v => v.startsWith('dl_staging_access='));
    if (matches(supplied)) {
      res.cookie('dl_staging_access', env.DARKLION_STAGING_ACCESS_KEY, {
        httpOnly: true, secure: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000, path: '/',
      });
      return next();
    }
    if (matches(cookie?.slice('dl_staging_access='.length))) return next();
    res.set('Cache-Control', 'no-store');
    res.set('WWW-Authenticate', 'Basic realm="DarkLion staging"');
    return res.status(401).json({ error: 'Staging access required' });
  };
}

async function captureNotification(channel, payload, env = process.env) {
  if (!isolatedStaging(env)) {
    if (env.OUTBOUND_DELIVERY_MODE && env.OUTBOUND_DELIVERY_MODE !== 'live') throw new Error('INVALID_OUTBOUND_MODE');
    return null;
  }
  assertRuntimeSafety(env);
  const id = 'capture-' + randomUUID();
  await mkdir(env.DARKLION_CAPTURE_DIR, { recursive: true, mode: 0o700 });
  await appendFile(path.join(env.DARKLION_CAPTURE_DIR, 'notifications.jsonl'),
    JSON.stringify({ id, channel, capturedAt: new Date().toISOString(), payload }) + '\n',
    { mode: 0o600 });
  return { id, captured: true };
}

function realtimeConfiguration(env = process.env) {
  if (isolatedStaging(env) || !env.PUSHER_KEY || !env.PUSHER_CLUSTER) return { enabled: false };
  return { enabled: true, key: env.PUSHER_KEY, cluster: env.PUSHER_CLUSTER };
}

module.exports = { isolatedStaging, backgroundJobsEnabled, assertRuntimeSafety, captureNotification, realtimeConfiguration, stagingAccess };
