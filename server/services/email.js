'use strict';

const { pool } = require('../db');
const { getSignedDownloadUrl } = require('./s3');
const { generalReplyAddress } = require('./emailReplyTokens');
const { captureNotification } = require('./runtimeSafety');

const DEFAULT_FROM_NAME = 'DarkLion Messages';
const FROM_ADDR = process.env.RESEND_FROM || process.env.EMAIL_FROM || 'messages@example.com';
const APP_STORE_BADGE_URL = 'https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83';

/**
 * Fetch a firm's logo URL from S3 (7-day signed URL, safe for email links).
 * Returns null if no logo is set.
 * @param {string} firmId
 * @returns {Promise<string|null>}
 */
async function getFirmLogoUrl(firmId) {
  if (!firmId) return null;
  // Use the stable redirect endpoint — clean URL, no presigned signature issues in emails
  const appUrl = process.env.APP_URL || process.env.PORTAL_URL || 'http://localhost:8080';
  try {
    // Verify the firm actually has a logo before returning the URL
    const { rows } = await pool.query('SELECT logo_url FROM firms WHERE id = $1', [firmId]);
    const logoKey = rows[0]?.logo_url;
    if (!logoKey) return null;
  } catch(err) {
    // If DB check fails, still return the URL and let the endpoint handle it
  }
  return `${appUrl}/portal-auth/firm-logo/${firmId}`;
}

/**
 * Send a transactional email via Resend.
 * @param {{ to: string, subject: string, html: string, replyTo?: string }}
 * @returns {{ ok: true } | { ok: true, skipped: true }}
 */
async function sendEmail({ to, subject, html, fromName, replyTo, attachments }) {
  const captured = await captureNotification('email', { to, subject, html, fromName, replyTo,
    attachments: attachments?.map(a => ({ filename: a.filename, contentType: a.content_type })) });
  if (captured) return { ok: true, ...captured };
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    console.warn('[email] RESEND_API_KEY not set — skipping email send to:', to);
    return { ok: true, skipped: true };
  }

  const senderName = fromName || DEFAULT_FROM_NAME;
  const from = `${senderName} <${FROM_ADDR}>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...((attachments && attachments.length) ? { attachments } : {}),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  return { ok: true };
}

// ── Shared template wrapper ─────────────────────────────────────────────────

function appStoreEmailBlock({ dark = false, app = null } = {}) {
  if(!app?.appStoreUrl)return '';
  const appUrl=esc(app.appStoreUrl), appName=esc(app.appName);
  if (dark) {
    return `
    <div class="divider"></div>
    <p style="margin-bottom:10px;">Prefer using your iPhone? Download the ${appName} app for secure messages, document uploads, requests, and notifications.</p>
    <a href="${appUrl}" target="_blank" rel="noopener" style="display:inline-block;margin:0 0 16px;">
      <img src="${APP_STORE_BADGE_URL}" alt="Download on the App Store" style="display:block;width:150px;max-width:100%;height:auto;border:0;" />
    </a>
    <p class="url-fallback">App Store link: ${appUrl}</p>`;
  }

  return `
      <div style="margin:22px 0 0;padding:16px 18px;border:1px solid #ece7d8;border-radius:10px;background:#fbfaf6;">
        <p style="margin:0 0 10px;font-size:13px;line-height:1.55;color:#374151;"><strong>Prefer using your iPhone?</strong><br />Download the ${appName} app for secure messages, document uploads, requests, and notifications.</p>
        <a href="${appUrl}" target="_blank" rel="noopener" style="display:inline-block;">
          <img src="${APP_STORE_BADGE_URL}" alt="Download on the App Store" style="display:block;width:150px;max-width:100%;height:auto;border:0;" />
        </a>
      </div>`;
}

/**
 * @param {string} content  - HTML body content
 * @param {{ firmName?: string, logoUrl?: string }} branding
 */
function baseTemplate(content, { firmName = 'DarkLion', logoUrl = null, replyAddress = null } = {}) {
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${esc(firmName)}" style="max-height:48px; max-width:200px; object-fit:contain; margin-bottom:28px; display:block;" />`
    : `<div class="logo-text">${esc(firmName)}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; padding: 0; background: #0f1117; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .wrapper { max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .card { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 12px; padding: 36px 32px; }
    .logo-text { font-size: 1.1rem; font-weight: 700; color: #c9a84c; letter-spacing: 0.04em; margin-bottom: 28px; }
    h1 { font-size: 1.3rem; font-weight: 700; color: #e8e8e8; margin: 0 0 12px; }
    p { font-size: 0.93rem; color: #8a8fa8; line-height: 1.65; margin: 0 0 16px; }
    .btn { display: inline-block; background: #c9a84c; color: #0f1117; font-weight: 700; font-size: 0.95rem; text-decoration: none; border-radius: 8px; padding: 12px 28px; margin: 8px 0 20px; }
    .divider { height: 1px; background: #2a2d3a; margin: 24px 0; }
    .footer { font-size: 0.78rem; color: #4a4e62; text-align: center; margin-top: 24px; line-height: 1.45; }
    .url-fallback { font-size: 0.78rem; color: #4a4e62; word-break: break-all; }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="card">
      ${logoHtml}
      ${content}
    </div>
    <div class="footer">This message was sent by ${esc(firmName)} through DarkLion.${replyAddress ? `<br />You can reply directly to this email; replies route to ${esc(firmName)} in DarkLion Messages.` : ''}</div>
  </div>
</body>
</html>`;
}

function emailMessageTemplate({ firmName = 'DarkLion', logoUrl = null, message = '', portalUrl = '', replyAddress = '', attachments = [], app = null } = {}) {
  const logoHtml = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="${esc(firmName)}" style="max-height:34px; max-width:180px; object-fit:contain; display:block;" />`
    : `<div style="font-size:16px;font-weight:700;color:#111827;letter-spacing:0.01em;">${esc(firmName)}</div>`;
  const messageHtml = esc(message || 'You have a new message from your advisor.').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br />');
  const portalLine = portalUrl
    ? `<p style="margin:22px 0 0;font-size:13px;line-height:1.55;color:#6b7280;">Open your secure portal here: <a href="${esc(portalUrl)}" style="color:#8a6a16;text-decoration:underline;">Open Portal</a>.</p>`
    : '';
  const attachmentLine = attachments && attachments.length
    ? `<p style="margin:0 0 18px;font-size:13px;line-height:1.55;color:#6b7280;">${attachments.length === 1 ? 'A document is attached to this email.' : `${attachments.length} documents are attached to this email.`}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f6f4ef;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#111827;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;">
    <div style="height:6px;background:#c9a84c;"></div>
    <div style="padding:24px 28px 14px;border-bottom:1px solid #ece7d8;">
      ${logoHtml}
    </div>
    <div style="padding:28px;">
      <div style="font-size:15px;line-height:1.65;color:#111827;margin:0 0 22px;">
        <p style="margin:0 0 14px;">${messageHtml}</p>
      </div>
      ${attachmentLine}
      <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#374151;">You can reply directly to this email. Your reply will go to our team in DarkLion Messages.</p>
      ${replyAddress ? `<p style="margin:0 0 18px;font-size:12px;line-height:1.5;color:#9ca3af;">Reply address: ${esc(replyAddress)}</p>` : ''}
      ${portalLine}
      ${appStoreEmailBlock({app})}
    </div>
    <div style="padding:18px 28px 26px;border-top:1px solid #ece7d8;font-size:12px;line-height:1.5;color:#9ca3af;">
      Sent by ${esc(firmName)} through DarkLion.
    </div>
  </div>
</body>
</html>`;
}

// ── Pre-built templates ──────────────────────────────────────────────────────

/**
 * Send a portal invite email.
 */
async function sendPortalInvite({ to, name, firmName, firmId, logoUrl, inviteUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null);
  const app=firmId?await require('./firmPreferences').getFirmPreferences(firmId):null;
  const username = to || 'the email address where you received this invite';
  const html = baseTemplate(`
    <h1>You're invited to ${esc(firmName)}'s Client Portal</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>${esc(firmName)} has set up your secure DarkLion workspace. Create your account below, then sign in to your secure portal for quick access.</p>
    <p><strong>Your username is your email address:</strong><br>${esc(username)}</p>
    <a class="btn" href="${esc(inviteUrl)}">Set Up My Account →</a>
    ${appStoreEmailBlock({ dark: true,app })}
    <div class="divider"></div>
    <p>This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.</p>
    <p class="url-fallback">Or copy this link: ${esc(inviteUrl)}</p>
  `, { firmName, logoUrl: resolvedLogo, replyAddress: generalReplyAddress() });

  return sendEmail({ to, subject: `You're invited to ${firmName}'s secure workspace`, html, fromName: firmName, replyTo: generalReplyAddress() });
}

/**
 * Send a portal notification email to a client.
 */
async function sendPortalNotification({ to, name, firmName, firmId, logoUrl, message, portalUrl, replyTo, replyAddress, attachments }) {
  const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null);
  const app=firmId?await require('./firmPreferences').getFirmPreferences(firmId):null;
  const html = emailMessageTemplate({ firmName, logoUrl: resolvedLogo, message, portalUrl, replyAddress, attachments,app });

  return sendEmail({ to, subject: `A message from ${firmName}`, html, fromName: firmName, replyTo: replyTo || replyAddress, attachments });
}

/**
 * Send a password reset email.
 */
async function sendPasswordReset({ to, name, firmName, firmId, logoUrl, resetUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null);
  const app=firmId?await require('./firmPreferences').getFirmPreferences(firmId):null;
  const html = baseTemplate(`
    <h1>Reset Your Password</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>We received a request to reset your password for your ${esc(firmName)} secure workspace. Click the button below to choose a new password.</p>
    <a class="btn" href="${esc(resetUrl)}">Reset My Password →</a>
    ${appStoreEmailBlock({ dark: true,app })}
    <div class="divider"></div>
    <p>This link expires in 1 hour. If you didn't request this email, you can safely ignore it — your password won't change.</p>
    <p class="url-fallback">Or copy this link: ${esc(resetUrl)}</p>
  `, { firmName, logoUrl: resolvedLogo });

  return sendEmail({ to, subject: `Reset your ${firmName} password`, html, fromName: firmName, replyTo: generalReplyAddress() });
}

// Simple HTML escaping for template values
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Send a bank statement upload reminder email to a portal client.
 */
async function sendStatementReminder({ to, name, firmName, firmId, logoUrl, companyName, accountName, month, portalUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null);
  const app=firmId?await require('./firmPreferences').getFirmPreferences(firmId):null;
  // Format month nicely: 2025-03 -> March 2025
  let monthLabel = month;
  try {
    const [y, m] = month.split('-');
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    monthLabel = `${months[parseInt(m) - 1]} ${y}`;
  } catch(e) { /* keep raw */ }

  const html = baseTemplate(`
    <h1>Bank Statement Reminder</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>We need your <strong>${esc(accountName)}</strong> statement for <strong>${esc(monthLabel)}</strong> for <strong>${esc(companyName)}</strong>.</p>
    <p>Please upload it through your secure portal so our team can keep your books current.</p>
    <a class="btn" href="${esc(portalUrl)}">Upload Statement →</a>
    ${appStoreEmailBlock({ dark: true,app })}
    <div class="divider"></div>
    <p style="font-size:0.83rem;">Once uploaded, our bookkeeping team will handle the rest. If you have any questions, reply directly to this email.</p>
  `, { firmName, logoUrl: resolvedLogo, replyAddress: generalReplyAddress() });

  return sendEmail({ to, subject: `Action needed: ${esc(accountName)} statement for ${esc(monthLabel)}`, html, fromName: firmName, replyTo: generalReplyAddress() });
}

async function sendBookkeepingQuestionsNotification({ to, name, firmName, firmId, logoUrl, count, portalUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null);
  const app=firmId?await require('./firmPreferences').getFirmPreferences(firmId):null;
  const txnWord = count === 1 ? 'transaction' : 'transactions';

  const html = baseTemplate(`
    <h1>We Need Your Help Categorizing ${count === 1 ? 'a Transaction' : 'Some Transactions'}</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>Your bookkeeper has flagged <strong>${count} ${txnWord}</strong> that we need your help identifying. These are expenses or income items we weren't able to categorize automatically.</p>
    <p>Please review these in your secure portal so the transaction details and category choices display correctly.</p>
    <a class="btn" href="${esc(portalUrl)}">Answer Questions →</a>
    ${appStoreEmailBlock({ dark: true,app })}
    <div class="divider"></div>
    <p style="font-size:0.83rem;">If you are not sure about an item, reply directly to this email with what you know.</p>
  `, { firmName, logoUrl: resolvedLogo, replyAddress: generalReplyAddress() });

  return sendEmail({
    to,
    subject: `Quick question about ${count} ${txnWord} in your books`,
    html,
    fromName: firmName,
    replyTo: generalReplyAddress(),
  });
}

async function sendBookkeepingQuestionsReminder({ to, name, firmName, firmId, logoUrl, count, portalUrl }) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const resolvedLogo = logoUrl || (firmId ? await getFirmLogoUrl(firmId) : null);
  const app=firmId?await require('./firmPreferences').getFirmPreferences(firmId):null;
  const txnWord = count === 1 ? 'transaction' : 'transactions';

  const html = baseTemplate(`
    <h1>Bookkeeping Question${count !== 1 ? 's' : ''} Need Your Input</h1>
    <p>Hi ${esc(firstName)},</p>
    <p>You have <strong>${count} ${txnWord}</strong> in your bookkeeping that need to be categorized. Our team needs your help identifying what these expenses are for so we can keep your books accurate.</p>
    <p>Please review these in your secure portal so the transaction details and category choices display correctly.</p>
    <a class="btn" href="${esc(portalUrl)}">Review Transactions →</a>
    ${appStoreEmailBlock({ dark: true,app })}
    <div class="divider"></div>
    <p style="font-size:0.83rem;">If you are not sure about an item, reply directly to this email with what you know.</p>
  `, { firmName, logoUrl: resolvedLogo, replyAddress: generalReplyAddress() });

  return sendEmail({
    to,
    subject: `Action needed: ${count} bookkeeping ${txnWord} need your review`,
    html,
    fromName: firmName,
    replyTo: generalReplyAddress(),
  });
}

module.exports = { sendEmail, sendPortalInvite, sendPortalNotification, sendPasswordReset, getFirmLogoUrl, sendStatementReminder, sendBookkeepingQuestionsReminder, sendBookkeepingQuestionsNotification };
