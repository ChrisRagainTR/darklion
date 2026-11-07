'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const twilio = require('twilio');
// Keep archive side effects in the fixture too. The real archive module uses
// its own database pool, separate from the scripted pool passed below.
const archiveCalls = [];
const inboundModule = { exports: {} };
const inboundFilename = require.resolve('../../server/services/inboundSms');
vm.compileFunction(fs.readFileSync(inboundFilename, 'utf8'), ['require', 'module'], {
  filename: inboundFilename,
})(name => {
  if (name === './communicationArchive') return {
    archiveClientMessageCreatedFailClosed: async args => { archiveCalls.push(args); },
  };
  if (name === './mobilePush') return { sendStaffMobilePush: async () => {} };
  if (name === './emmaDraftJobs') return { enqueueEmmaDraftJob: async () => {} };
  throw new Error(`Unstubbed inbound SMS dependency: ${name}`);
}, inboundModule);
const {
  normalizeOptOutType,
  normalizePhone,
  phoneMatchKey,
  processInboundSms,
} = inboundModule.exports;
const {
  buildWebhookUrl,
  validateTwilioSignature,
} = require('../../server/routes/twilio-webhooks');

function request({ url, body, signature }) {
  return {
    protocol: 'https',
    originalUrl: url,
    body,
    get(name) {
      if (name === 'host') return 'darklion.ai';
      if (name === 'X-Twilio-Signature') return signature;
      return undefined;
    },
  };
}

function scriptedPool(handler) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      const text = String(sql);
      calls.push({ text, values });
      return handler(text, values, calls);
    },
    release() {
      calls.push({ text: 'RELEASE', values: [] });
    },
  };
  return {
    calls,
    pool: { async connect() { return client; } },
  };
}

test('normalizes common North American phone formats', () => {
  assert.equal(normalizePhone('(239) 555-1212'), '+12395551212');
  assert.equal(normalizePhone('+1 239 555 1212'), '+12395551212');
  assert.equal(phoneMatchKey('+1 239 555 1212'), '2395551212');
  assert.equal(normalizePhone(''), '');
});

test('recognizes Twilio opt-out commands and fallback keywords', () => {
  assert.equal(normalizeOptOutType('STOP', 'anything'), 'STOP');
  assert.equal(normalizeOptOutType('', ' quit '), 'STOP');
  assert.equal(normalizeOptOutType('', 'UNSTOP'), 'START');
  assert.equal(normalizeOptOutType('', 'help'), 'HELP');
  assert.equal(normalizeOptOutType('', 'Can we meet tomorrow?'), '');
});

test('builds the exact public webhook URL used for Twilio signatures', () => {
  const prior = process.env.TWILIO_WEBHOOK_BASE_URL;
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://darklion.ai/';
  try {
    assert.equal(
      buildWebhookUrl(request({ url: '/api/twilio/inbound?source=twilio', body: {} })),
      'https://darklion.ai/api/twilio/inbound?source=twilio'
    );
  } finally {
    if (prior === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
    else process.env.TWILIO_WEBHOOK_BASE_URL = prior;
  }
});

test('accepts a valid Twilio signature and rejects a modified payload', () => {
  const priorToken = process.env.TWILIO_AUTH_TOKEN;
  const priorBase = process.env.TWILIO_WEBHOOK_BASE_URL;
  const token = 'unit-test-auth-token';
  const url = 'https://darklion.ai/api/twilio/inbound';
  const body = {
    MessageSid: 'SM123',
    From: '+12395551212',
    To: '+12395550000',
    Body: 'Hello',
  };
  process.env.TWILIO_AUTH_TOKEN = token;
  process.env.TWILIO_WEBHOOK_BASE_URL = 'https://darklion.ai';
  try {
    const signature = twilio.getExpectedTwilioSignature(token, url, body);
    assert.equal(validateTwilioSignature(request({ url: '/api/twilio/inbound', body, signature })), true);
    assert.equal(validateTwilioSignature(request({
      url: '/api/twilio/inbound',
      body: { ...body, Body: 'Modified' },
      signature,
    })), false);
  } finally {
    if (priorToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = priorToken;
    if (priorBase === undefined) delete process.env.TWILIO_WEBHOOK_BASE_URL;
    else process.env.TWILIO_WEBHOOK_BASE_URL = priorBase;
  }
});

test('stores a matched inbound text in the existing SMS thread', async () => {
  archiveCalls.length = 0;
  const { pool, calls } = scriptedPool((sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
    if (sql.includes('SELECT DISTINCT firm_id AS id')) return { rows: [{ id: 7 }] };
    if (sql.includes('COALESCE(twilio_phone_number')) return { rows: [{ id: 7 }] };
    if (sql.includes('INSERT INTO twilio_inbound_sms_events')) return { rows: [{ id: 81 }] };
    if (sql.includes('FROM sms_thread_routes str')) {
      return { rows: [{
        thread_id: 23,
        person_id: 42,
        staff_user_id: 9,
        first_name: 'Test',
        last_name: 'Client',
        sms_opted_out: false,
      }] };
    }
    if (sql.includes('INSERT INTO messages')) return { rows: [{ id: 101 }] };
    if (sql.includes('UPDATE message_threads')
        || sql.includes('UPDATE twilio_inbound_sms_events')
        || sql.includes('INSERT INTO sms_thread_routes')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await processInboundSms({
    pool,
    payload: {
      MessageSid: 'SM_MATCHED',
      From: '(239) 555-1212',
      To: '+12395550000',
      Body: 'Can we meet tomorrow?',
    },
  });

  assert.deepEqual(result, {
    accepted: true,
    matchStatus: 'matched',
    firmId: 7,
    personId: 42,
    threadId: 23,
    staffUserId: 9,
    messageId: 101,
    body: 'Can we meet tomorrow?',
    optOutType: '',
  });
  const messageInsert = calls.find(call => call.text.includes('INSERT INTO messages'));
  assert.equal(messageInsert.values[2], 'Can we meet tomorrow?');
  assert.equal(messageInsert.values[3], 'SM_MATCHED');
  const routeUpdate = calls.find(call => call.text.includes('INSERT INTO sms_thread_routes'));
  assert.deepEqual(routeUpdate.values.slice(0, 5), [
    7, 42, 23, '+12395551212', '+12395550000',
  ]);
  assert.equal(calls.at(-1).text, 'RELEASE');
  assert.deepEqual(archiveCalls, [{ firmId: 7, messageId: 101 }]);
});

test('deduplicates a retried Twilio webhook before creating a message', async () => {
  archiveCalls.length = 0;
  const { pool, calls } = scriptedPool((sql) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('SELECT DISTINCT firm_id AS id')) return { rows: [{ id: 7 }] };
    if (sql.includes('COALESCE(twilio_phone_number')) return { rows: [{ id: 7 }] };
    if (sql.includes('INSERT INTO twilio_inbound_sms_events')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  });

  const result = await processInboundSms({
    pool,
    payload: {
      MessageSid: 'SM_DUPLICATE',
      From: '+12395551212',
      To: '+12395550000',
      Body: 'Hello again',
    },
  });

  assert.deepEqual(result, { duplicate: true });
  assert.equal(calls.some(call => call.text.includes('INSERT INTO messages')), false);
  assert.equal(calls.some(call => call.text === 'ROLLBACK'), true);
  assert.equal(calls.at(-1).text, 'RELEASE');
  assert.deepEqual(archiveCalls, []);
});
