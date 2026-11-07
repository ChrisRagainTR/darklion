'use strict';

const { sendEmail } = require('./email');

// Same alert key won't re-fire within COOLDOWN_MS — protects inbox if a job
// fails on every cron tick or a tight error loop kicks off.
const ALERT_HISTORY = new Map();
const COOLDOWN_MS = 30 * 60 * 1000;

function getMonitorEmail() {
  return process.env.MONITOR_EMAIL || process.env.NOTIFY_EMAIL || null;
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendErrorAlert({ source, error, context, message } = {}) {
  const to = getMonitorEmail();
  if (!to) return;

  const errMsg = (error && error.message) || message || 'Unknown error';
  const key = `${source}::${errMsg}`;
  const now = Date.now();
  const last = ALERT_HISTORY.get(key);
  if (last && now - last < COOLDOWN_MS) return;
  ALERT_HISTORY.set(key, now);

  const env = process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'unknown';
  const stack = (error && error.stack) || '';
  const ctxBlock = context
    ? `<pre style="margin:0 0 12px;color:#c9a84c;font-size:12px;white-space:pre-wrap;">${esc(JSON.stringify(context, null, 2))}</pre>`
    : '';
  const stackBlock = stack
    ? `<pre style="margin:0;color:#8a8fa8;font-size:11px;white-space:pre-wrap;overflow:auto;">${esc(stack)}</pre>`
    : '';

  const html = `<div style="font-family:-apple-system,sans-serif;background:#0f1117;color:#e8e8e8;padding:24px;max-width:720px;">
  <h2 style="color:#ff6b6b;margin:0 0 8px;">DarkLion Production Alert</h2>
  <p style="color:#8a8fa8;margin:0 0 16px;font-size:13px;">Environment: <strong>${esc(env)}</strong> · Source: <strong>${esc(source || 'unknown')}</strong></p>
  <div style="background:#1a1d27;border:1px solid #2a2d3a;border-radius:8px;padding:16px;margin-bottom:16px;">
    <div style="font-weight:700;color:#ff6b6b;margin-bottom:8px;">${esc(errMsg)}</div>
    ${ctxBlock}
    ${stackBlock}
  </div>
  <p style="color:#4a4e62;font-size:11px;margin:0;">Identical alerts are suppressed for 30 minutes.</p>
</div>`;

  try {
    await sendEmail({
      to: to.split(',').map(s => s.trim()),
      subject: `[DarkLion ${env}] ${source || 'alert'}: ${errMsg.slice(0, 80)}`,
      html,
      fromName: 'DarkLion Alerts',
    });
  } catch (e) {
    console.error('[alerts] Failed to send error alert:', e.message);
  }
}

module.exports = { sendErrorAlert };
