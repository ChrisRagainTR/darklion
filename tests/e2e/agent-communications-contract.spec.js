'use strict';

const { test, expect } = require('@playwright/test');
const express = require('express');
const {
  getConversationSummary,
  listConversationSummaries,
  replyToClientThread,
  sendClientMessage,
  summaryForStaff,
} = require('../../server/services/agentCommunications');
const { createAgentWorkCommunicationsRouter } = require('../../server/routes/agent-work-communications');

const summaryJson = {
  date: '2026-08-28',
  generated_at: '2026-08-29T01:00:00.000Z',
  by_staff: [
    { staff_user_id: 11, staff_name: 'Current User', threads: [{ thread_id: 1, client_name: 'Hidden Client', bullets: 'hidden' }] },
    { staff_user_id: 12, staff_name: 'Other User', threads: [{ thread_id: 2, client_name: 'Visible Client', staff_name: 'Other User', staff_user_id: 12, subject: 'Question', bullets: '• Follow up', message_count: 3, raw: 'omit' }] },
  ],
  team_chats: [
    { conversation_id: 3, title: 'My Chat', member_user_ids: [11, 12], member_names: ['Current User'], bullets: 'hidden', message_count: 1 },
    { conversation_id: 4, title: 'Other Chat', member_user_ids: [12, 13], member_names: ['Other User'], bullets: '• Decision', message_count: 4, ciphertext: 'omit' },
  ],
  unexpected: 'omit',
};

test.describe('Agent communications service', () => {
  test('allowlists and staff-filters conversation summary content', () => {
    const result = summaryForStaff(summaryJson, 11);
    expect(result.thread_count).toBe(2);
    expect(result.by_staff).toHaveLength(1);
    expect(result.by_staff[0].threads[0]).toMatchObject({ thread_id: 2, client_name: 'Visible Client' });
    expect(result.team_chats).toHaveLength(1);
    expect(result.team_chats[0]).toMatchObject({ conversation_id: 4, title: 'Other Chat' });
    expect(result).not.toHaveProperty('unexpected');
    expect(result.by_staff[0].threads[0]).not.toHaveProperty('raw');
    expect(result.team_chats[0]).not.toHaveProperty('ciphertext');
    expect(result.team_chats[0]).not.toHaveProperty('member_user_ids');
  });

  test('lists summaries for the authenticated firm and staff only', async () => {
    let captured;
    const db = { query: async (sql, params) => { if(sql.includes('firm_preferences'))return {rows:[{id:7,email:'synthetic@example.invalid',settings:{}}]}; captured = { sql, params }; return { rows: [{ date: '2026-08-28', viewed: false, summary_json: summaryJson }] }; } };
    const result = await listConversationSummaries({ firmId: 7, staffUserId: 11, month: '2026-08', db });
    expect(captured.sql).toContain('cs.firm_id = $1');
    expect(captured.sql).toContain('sv.firm_user_id = $2');
    expect(captured.params).toEqual([7, 11, '2026-08']);
    expect(result).toEqual({ month: '2026-08', summaries: [{ date: '2026-08-28', viewed: false, thread_count: 2 }] });
  });

  test('gets a filtered summary and marks it viewed only for the scoped staff user', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      if(sql.includes('firm_preferences'))return {rows:[{id:7,email:'synthetic@example.invalid',settings:{}}]};
      calls.push({ sql, params });
      if (sql.includes('FROM conversation_summaries')) return { rows: [{ date: '2026-08-28', generated_at: '2026-08-29T01:00:00.000Z', summary_json: summaryJson }] };
      return { rows: [] };
    } };
    const result = await getConversationSummary({ firmId: 7, staffUserId: 11, date: '2026-08-28', db });
    expect(calls[0].params).toEqual([7, '2026-08-28']);
    expect(calls[1].sql).toContain('INSERT INTO summary_views');
    expect(calls[1].params).toEqual([7, '2026-08-28', 11]);
    expect(result).toMatchObject({ date: '2026-08-28', viewed: true, thread_count: 2 });
  });

  test('sends a new client portal message as the authenticated staff identity with idempotency', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM firm_users')) return { rows: [{ id: 11, name: 'Advisor' }] };
      if (sql.includes('m.provider_message_id')) return { rows: [] };
      if (sql.includes('FROM people p JOIN firms')) return { rows: [{ id: 22, first_name: 'Jane', last_name: 'Client', email: 'jane@example.com', firm_name: 'Example Firm' }] };
      if (sql.includes('SELECT id FROM message_threads')) return { rows: [] };
      if (sql.includes('INSERT INTO message_threads')) return { rows: [{ id: 31 }] };
      if (sql.includes('INSERT INTO messages')) return { rows: [{ message_id: 41, thread_id: 31, created_at: '2026-08-29T00:00:00.000Z' }] };
      return { rows: [] };
    } };
    const archived = [];
    const notified = [];
    const result = await sendClientMessage({
      firmId: 7, staffUserId: 11, personId: 22, subject: 'Hello', body: 'Secure message', clientNonce: 'request-1234', db,
      archive: async input => archived.push(input),
      notify: async input => { notified.push(input); return { attempted: true, sent: true }; },
    });
    const insert = calls.find(call => call.sql.includes('INSERT INTO messages'));
    expect(insert.sql).toContain('ON CONFLICT DO NOTHING');
    expect(insert.params).toEqual([31, 11, 'Secure message', 'mcp:7:request-1234']);
    expect(archived[0]).toMatchObject({ firmId: 7, messageId: 41, requestedByStaffUserId: 11 });
    expect(notified[0]).toMatchObject({ firmId: 7, threadId: 31, messageId: 41, body: 'Secure message' });
    expect(result).toMatchObject({ ok: true, thread_id: 31, message_id: 41, deduplicated: false, notification: { sent: true } });
  });

  test('replies only to a firm-scoped thread visible to the authenticated staff member', async () => {
    const calls = [];
    const db = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM firm_users')) return { rows: [{ id: 11, name: 'Advisor' }] };
      if (sql.includes('m.provider_message_id')) return { rows: [] };
      if (sql.includes('FROM message_threads mt') && sql.includes('thread_participants')) return { rows: [{ id: 22, person_id: 22, first_name: 'Jane', last_name: 'Client', email: 'jane@example.com', firm_name: 'Example Firm' }] };
      if (sql.includes('INSERT INTO messages')) return { rows: [{ message_id: 42, thread_id: 32, created_at: '2026-08-29T00:00:00.000Z' }] };
      return { rows: [] };
    } };
    const result = await replyToClientThread({
      firmId: 7, staffUserId: 11, threadId: 32, body: 'Reply', clientNonce: 'reply-1234', db,
      archive: async () => {}, notify: async () => ({ attempted: true, sent: true }),
    });
    const visible = calls.find(call => call.sql.includes('thread_participants'));
    expect(visible.sql).toContain('mt.firm_id = $2');
    expect(visible.sql).toContain('mt.staff_user_id = $3');
    expect(visible.params).toEqual([32, 7, 11]);
    expect(result).toMatchObject({ thread_id: 32, message_id: 42, deduplicated: false });
  });

  test('does not resend or renotify an existing idempotent message', async () => {
    let notified = false;
    const db = { query: async sql => {
      if (sql.includes('FROM firm_users')) return { rows: [{ id: 11 }] };
      if (sql.includes('m.provider_message_id')) return { rows: [{ message_id: 41, thread_id: 31, sender_id: 11, person_id: 22, body: 'Secure message', created_at: '2026-08-29T00:00:00.000Z' }] };
      throw new Error('unexpected query');
    } };
    const result = await sendClientMessage({
      firmId: 7, staffUserId: 11, personId: 22, body: 'Secure message', clientNonce: 'request-1234', db,
      archive: async () => { throw new Error('must not archive twice'); },
      notify: async () => { notified = true; },
    });
    expect(result.deduplicated).toBe(true);
    expect(result.notification.reason).toBe('deduplicated');
    expect(notified).toBe(false);
  });

  test('rejects reuse of an idempotency key for different content', async () => {
    const db = { query: async sql => {
      if (sql.includes('FROM firm_users')) return { rows: [{ id: 11 }] };
      if (sql.includes('m.provider_message_id')) return { rows: [{ message_id: 41, thread_id: 31, sender_id: 11, person_id: 22, body: 'Original' }] };
      throw new Error('unexpected query');
    } };
    await expect(sendClientMessage({
      firmId: 7, staffUserId: 11, personId: 22, body: 'Changed', clientNonce: 'request-1234', db,
    })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });
});

test.describe('Agent Work communications router', () => {
  async function withServer(capabilities, service, audit, callback) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.agentFirmId = 7;
      req.agentStaffUserId = 11;
      req.agentConnection = { id: 2, capabilities };
      next();
    });
    app.use('/communications', createAgentWorkCommunicationsRouter({ service, audit }));
    const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
    try { await callback(`http://127.0.0.1:${listener.address().port}`); }
    finally { await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
  }

  test('passes authenticated scope to summary reads and never accepts arbitrary staff ids', async () => {
    let args;
    await withServer({ summaries_read: true }, {
      listConversationSummaries: async input => { args = input; return { month: '2026-08', summaries: [] }; },
    }, async () => {}, async base => {
      const response = await fetch(`${base}/communications/summaries?month=2026-08&staff_user_id=999`);
      expect(response.status).toBe(200);
      expect(args).toEqual({ firmId: 7, staffUserId: 11, month: '2026-08' });
    });
  });

  test('requires the separate messages_send capability and audits metadata without message body', async () => {
    await withServer({ summaries_read: true, messages_send: false }, {
      sendClientMessage: async () => { throw new Error('must not run'); },
    }, async () => {}, async base => {
      const denied = await fetch(`${base}/communications/client-messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ person_id: 22, body: 'secret body', client_nonce: 'request-1234' }),
      });
      expect(denied.status).toBe(403);
    });

    const audits = [];
    await withServer({ messages_send: true }, {
      sendClientMessage: async () => ({ ok: true, thread_id: 31, message_id: 41, deduplicated: false, notification: { sent: true } }),
    }, async (_req, event, metadata) => audits.push({ event, metadata }), async base => {
      const sent = await fetch(`${base}/communications/client-messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ person_id: 22, body: 'secret body', client_nonce: 'request-1234' }),
      });
      expect(sent.status).toBe(201);
      expect(audits[0]).toEqual({ event: 'client_message_sent', metadata: { thread_id: 31, message_id: 41, deduplicated: false, notification_sent: true } });
      expect(JSON.stringify(audits)).not.toContain('secret body');
    });
  });

  test('does not duplicate existing inbox list/detail routes or expose attachment upload', async () => {
    await withServer({ messages_send: true }, {}, async () => {}, async base => {
      expect((await fetch(`${base}/communications/client-messages`)).status).toBe(404);
      expect((await fetch(`${base}/communications/client-messages/31`)).status).toBe(404);
      expect((await fetch(`${base}/communications/client-messages/31/attachments`, { method: 'POST' })).status).toBe(404);
    });
  });
});
