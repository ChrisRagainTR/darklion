'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test.describe('SMS uses the normal client conversation', () => {
  test('My Inbox sends once and pins the active thread', () => {
    const view = read('server/views/messages.ejs');
    const sendSms = view.slice(
      view.indexOf('async function sendReplyAsSms()'),
      view.indexOf('let _justSent', view.indexOf('async function sendReplyAsSms()'))
    );

    expect(sendSms).toContain('thread_id: activeThreadId');
    expect(sendSms).not.toContain(`/reply`);
    expect(sendSms).not.toContain('[Sent as text]');
  });

  test('outbound and inbound messages share an explicit route', () => {
    const db = read('server/db.js');
    const messages = read('server/routes/messages.js');
    const inbound = read('server/services/inboundSms.js');

    expect(db).toContain('CREATE TABLE IF NOT EXISTS sms_thread_routes');
    expect(db).toContain('UNIQUE(firm_id, client_phone, twilio_phone)');
    expect(messages).toContain('saveActiveRoute(pool');
    expect(inbound).toContain('FROM sms_thread_routes str');
    expect(inbound).toContain('thread_id = EXCLUDED.thread_id');
  });

  test('delivery failures and unmatched inbound texts stay visible', () => {
    const messages = read('server/routes/messages.js');
    const webhooks = read('server/routes/twilio-webhooks.js');
    const view = read('server/views/messages.ejs');

    expect(messages).toContain("provider_status = 'failed'");
    expect(webhooks).toContain("router.post('/status'");
    expect(messages).toContain("router.get('/sms-exceptions'");
    expect(view).toContain('smsExceptionBanner');
    expect(view).toContain("channel === 'sms'");
  });

  test('a normal staff reply inherits the latest client channel', () => {
    const messages = read('server/routes/messages.js');
    const inbox = read('server/views/messages.ejs');
    const person = read('server/views/crm-person.ejs');

    expect(messages).toContain("m.sender_type === 'client' && !m.is_internal");
    expect(messages).toContain("latestClientMessage?.channel === 'sms' ? 'sms' : 'portal'");
    expect(messages).toContain('preferredReplyChannel,');
    expect(inbox).toContain("activeReplyChannel = data.preferredReplyChannel === 'sms' ? 'sms' : 'portal'");
    expect(inbox).toContain("replyChannel === 'sms'");
    expect(inbox).toContain("sendReply({ forceChannel: 'portal' })");
    expect(person).toContain("commPreferredReplyChannel = data.preferredReplyChannel === 'sms' ? 'sms' : 'portal'");
  });
});
