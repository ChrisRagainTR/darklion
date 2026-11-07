'use strict';

const { Router } = require('express');

// Only deployment identity is public. Never include arbitrary environment
// variables, database addresses, or dependency error messages in these probes.
function releaseIdentity(env) {
  const commit = env.RAILWAY_GIT_COMMIT_SHA || '';
  const environment = env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'local';
  return Object.freeze({
    commit: /^[a-f0-9]{40}$/i.test(commit) ? commit.toLowerCase() : null,
    environment: /^[a-z0-9_-]{1,64}$/i.test(environment) ? environment : null,
  });
}

function createReleaseHealth({ checkDatabase, env = process.env, timeoutMs = 2000 }) {
  const router = Router();
  const release = releaseIdentity(env);
  let phase = 'starting';
  let pendingProbe = null;

  // Retain the underlying probe until it settles, even after an HTTP timeout.
  // Repeated requests during an outage must not fill the database pool.
  function probeDatabase() {
    if (!pendingProbe) {
      pendingProbe = Promise.resolve().then(checkDatabase).then(
        () => true,
        () => false,
      ).finally(() => { pendingProbe = null; });
    }
    return pendingProbe;
  }

  function reply(res, statusCode, status) {
    res.set('Cache-Control', 'no-store');
    if (statusCode === 503) res.set('Retry-After', '2');
    return res.status(statusCode).json({ status, release });
  }

  // Liveness remains independent of database availability for existing callers.
  router.get('/health', (_req, res) => reply(res, 200, 'ok'));
  router.get('/ready', async (_req, res) => {
    if (phase !== 'ready') return reply(res, 503, phase);
    let timer;
    try {
      const available = await Promise.race([
        probeDatabase(),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
      // A startup failure must win over a probe that was already in flight.
      return available && phase === 'ready'
        ? reply(res, 200, 'ok')
        : reply(res, 503, 'unavailable');
    } finally {
      clearTimeout(timer);
    }
  });

  return {
    router,
    markReady() { if (phase === 'starting') phase = 'ready'; },
    markFailed() { phase = 'unavailable'; },
  };
}

module.exports = { createReleaseHealth, releaseIdentity };
