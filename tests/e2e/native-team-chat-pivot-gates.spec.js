// tests/e2e/native-team-chat-pivot-gates.spec.js
// V1D pivot gates: Team Chat is native DarkLion staff/team chat.
// Telegram is allowed only as a separate personal assistant setup under Settings → Agents.

'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const { BASE_URL } = require('./helpers/config');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function compact(source) {
  return source.replace(/\s+/g, ' ');
}

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  expect(start, `missing start marker ${startNeedle}`).toBeGreaterThan(-1);
  const end = endNeedle ? source.indexOf(endNeedle, start + startNeedle.length) : source.length;
  expect(end, `missing end marker ${endNeedle}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

test.describe('Native Team Chat pivot gates — no Telegram backend dependency', () => {
  test('Team Chat mount and UI use only native /api/team-chat routes', () => {
    const index = compact(readRepoFile('server/index.js'));
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(index).toContain("app.use('/api/team-chat', requireFirm, teamChatLimiter, teamChatRouter)");
    expect(index).not.toContain("app.use('/api/team-chat/telegram'");
    expect(index).not.toContain('teamChatTelegramRouter');

    expect(view).toContain("apiJson('/api/team-chat/status'");
    expect(view).toContain("apiJson('/api/team-chat/conversations?limit=150'");
    expect(view).toContain("apiJson('/api/team-chat/messages?conversation_id='");
    expect(view).toContain("apiJson('/api/team-chat/messages/send'");
    expect(view).not.toContain('/api/team-chat/telegram');
    expect(view).not.toContain('Import Telegram');
    expect(view).not.toContain('Telegram dialogs');
    expect(view).not.toContain('https://t.me/');
  });

  test('DarkLion AI assistant is native to DarkLion and Team Chat has no Telegram assistant dependency', () => {
    const settings = compact(readRepoFile('server/views/settings.ejs'));
    const agentConnections = compact(readRepoFile('server/routes/agent-connections.js'));
    const teamRoute = compact(readRepoFile('server/routes/team-chat.js'));
    const teamView = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(settings).not.toContain('agent-telegram');
    expect(settings).not.toContain("apiFetch('/api/agent-connections/mine/telegram'");
    expect(agentConnections).not.toContain('telegram_user_chat');
    expect(agentConnections).not.toContain('/mine/telegram');
    expect(teamView).toContain("apiJson('/api/emma-chat/message'");
    expect(teamRoute).toContain('telegram_core_dependency: false');
    expect(teamRoute).not.toContain("require('../services/telegram");
    expect(teamRoute).not.toContain('team_chat_telegram');
  });

  test('Team Chat opens the last selected chat or falls back to a valid chat', () => {
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(view).toContain('var storedActive = localStorage.getItem(storageKeyActive)');
    expect(view).toContain('activeChat = visibleChats.find(function(c){ return chatKey(c) === storedActive; }) || null');
    expect(view).toContain('if (!activeChat && visibleChats.length) { activeChat = visibleChats[0]; }');
    expect(view).not.toContain('storedChat && Number(storedChat.unread_count || 0) <= 0');
  });

  test('Team Chat opens selected chats at the latest message unless unread positioning is needed', () => {
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(view).toContain('var hasUnreadOnOpen = Number(chat.unread_count || 0) > 0');
    expect(view).toContain('renderMessages(messageCache[key] || [], { forceFull:true, forceBottom:!hasUnreadOnOpen })');
    expect(view).toContain('refreshMessages(false, true, { syncLatest:false, chat:chat, seq:seq, forceBottom:!hasUnreadOnOpen })');
    expect(view).not.toContain('restoreScroll:Number(chat.unread_count || 0) <= 0');
  });

  test('Team Chat has chat-specific burst handling instead of relying on the global API limiter', () => {
    const index = compact(readRepoFile('server/index.js'));
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(index).toContain('const teamChatLimiter = rateLimit({');
    expect(index).toContain('max: 1800');
    expect(index).toContain("app.use('/api/team-chat', requireFirm, teamChatLimiter, teamChatRouter)");
    expect(index).not.toContain("app.use('/api/team-chat', requireFirm, apiLimiter, teamChatRouter)");

    expect(view).toContain('var messageRefreshTimers = {}');
    expect(view).toContain('function scheduleMessageRefresh(chat, opts, delayMs)');
    expect(view).toContain('function rememberTeamChatBackoff(ms)');
    expect(view).toContain('err.status === 429');
    expect(view).toContain('Team Chat is catching up; retrying conversation sync automatically');
  });

  test('Team Chat group creation uses a compact compose control', () => {
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(view).toContain('class="tc-search-row"');
    expect(view).toContain('class="tc-compose-btn" id="tc-new-group-btn"');
    expect(view).toContain('aria-label="Create team group"');
    expect(view).not.toContain('>New group</button>');
  });

  test('group chats show member names in the header and compact member avatars in the left nav', () => {
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(view).toContain('function otherMembersForChat(chat)');
    expect(view).toContain("return String(member?.id || '') !== mine");
    expect(view).toContain('function groupMemberAvatarsHtml(chat)');
    expect(view).toContain('aria-label="Group members:');
    expect(view).toContain('function renderConversationParticipants(chat)');
    expect(view).toContain('tc-convo-sub-label">Members');
    expect(view).toContain("type === 'group' ? groupMemberAvatarsHtml(chat) : avatarForChat(chat)");
    expect(view).toContain('renderConversationParticipants(chat)');
  });
});

test.describe('Native Team Chat pivot gates — staff and tenant isolation', () => {
  test('native APIs require staff JWT and reject API-token/non-staff auth', () => {
    const route = compact(readRepoFile('server/routes/team-chat.js'));

    expect(route).toContain('router.use(requireStaffJwt)');
    expect(route).toContain('!req.firm?.userId || req.firm?.isApiToken');
    expect(route).toContain('Native Team Chat requires staff user authentication.');
  });

  test('directory and conversation membership are firm-scoped accepted active staff only', () => {
    const route = compact(readRepoFile('server/routes/team-chat.js'));
    const assertMembers = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function assertMembersInFirm', 'async function requireConversationMember'));
    const requireMember = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function requireConversationMember', 'async function findDm'));
    const getConversation = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function getConversation', 'async function listConversations'));
    const listConversations = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function listConversations', 'async function listMessages'));
    const listConversationMemberIds = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function listConversationMemberIds', 'async function broadcastMessage'));
    const mobilePush = compact(readRepoFile('server/services/mobilePush.js'));

    expect(route).toContain('FROM firm_users WHERE firm_id = $1 AND accepted_at IS NOT NULL AND archived_at IS NULL');
    expect(assertMembers).toContain('WHERE firm_id = $1 AND id = ANY($2::int[]) AND accepted_at IS NOT NULL');
    expect(assertMembers).toContain('AND archived_at IS NULL');
    expect(assertMembers).toContain('Every Team Chat member must be an accepted staff/team user in this firm.');
    expect(requireMember).toContain('WHERE c.firm_id = $1 AND c.id = $2 AND m.staff_user_id = $3 AND m.left_at IS NULL');
    expect(requireMember).toContain('AND active_u.accepted_at IS NOT NULL AND active_u.archived_at IS NULL');
    expect(requireMember).toContain('AND active_members.active_member_count >= 2');
    expect(getConversation).toContain('AND u.accepted_at IS NOT NULL AND u.archived_at IS NULL');
    expect(getConversation).toContain('AND COALESCE(amc.active_member_count,0) >= 2');
    expect(listConversations).toContain('AND u.accepted_at IS NOT NULL AND u.archived_at IS NULL');
    expect(listConversations).toContain('AND COALESCE(amc.active_member_count,0) >= 2');
    expect(listConversationMemberIds).toContain('AND u.accepted_at IS NOT NULL AND u.archived_at IS NULL');
    expect(mobilePush).toContain('JOIN firm_users fu ON fu.id = d.staff_user_id AND fu.firm_id = d.firm_id AND fu.accepted_at IS NOT NULL AND fu.archived_at IS NULL');
  });

  test('native schema keys and queries preserve firm/staff isolation', () => {
    const db = compact(readRepoFile('server/db.js'));
    const route = compact(readRepoFile('server/routes/team-chat.js'));

    for (const table of [
      'native_team_chat_conversations',
      'native_team_chat_members',
      'native_team_chat_messages',
      'native_team_chat_attachments',
      'native_team_chat_read_state',
      'native_team_chat_user_state',
    ]) {
      expect(db).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }

    expect(db).toContain('UNIQUE(firm_id, conversation_id, staff_user_id)');
    expect(db).toContain('UNIQUE(firm_id, conversation_id, client_nonce)');
    expect(route).toContain('JOIN native_team_chat_members mine ON mine.conversation_id = c.id AND mine.firm_id = c.firm_id AND mine.staff_user_id = $2');
    expect(route).toContain('WHERE msg.firm_id = $1 AND msg.conversation_id = $3');
  });
});

test.describe('Native Team Chat pivot gates — archive and compliance retention', () => {
  test('archive/hide/pin are per-user state only and do not delete conversations or messages', () => {
    const route = compact(readRepoFile('server/routes/team-chat.js'));
    const setUserState = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function setUserState', 'async function markRead'));
    const listConversations = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function listConversations', 'async function listMessages'));

    expect(setUserState).toContain("new Set(['is_archived', 'is_hidden', 'is_pinned'])");
    expect(setUserState).toContain('INSERT INTO native_team_chat_user_state');
    expect(setUserState).toContain('ON CONFLICT (firm_id, conversation_id, staff_user_id) DO UPDATE SET');
    expect(listConversations).toContain('($3::boolean OR COALESCE(us.is_archived,FALSE) = FALSE)');
    expect(listConversations).toContain('($4::boolean OR COALESCE(us.is_hidden,FALSE) = FALSE)');

    expect(route).not.toContain("router.delete('/conversations");
    expect(route).not.toContain('DELETE FROM native_team_chat');
    expect(route).not.toContain('DROP TABLE native_team_chat');
    expect(route).not.toContain('TRUNCATE native_team_chat');
  });

  test('messages are retained with encrypted body, immutable hash, nonce, and retained_at', () => {
    const db = compact(readRepoFile('server/db.js'));
    const route = compact(readRepoFile('server/routes/team-chat.js'));
    const sendMessage = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function sendMessage', 'async function setUserState'));

    expect(db).toContain('body_encrypted TEXT');
    expect(db).toContain('immutable_sha256 TEXT NOT NULL');
    expect(db).toContain('client_nonce TEXT NOT NULL DEFAULT');
    expect(db).toContain('retained_at TIMESTAMPTZ DEFAULT NOW()');
    expect(sendMessage).toContain("crypto.createHash('sha256')");
    expect(sendMessage).toContain('body_encrypted');
    expect(sendMessage).toContain('encrypt(text)');
    expect(route).toContain('retained_at: row.retained_at');
    expect(route).toContain('immutable_sha256: row.immutable_sha256');
  });

  test('messages have a one-week visible/edit/remove window without hard deletes', () => {
    const db = compact(readRepoFile('server/db.js'));
    const route = compact(readRepoFile('server/routes/team-chat.js'));
    const listMessages = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function listMessages', 'async function listConversationMemberIds'));
    const loadEditableMessage = compact(between(readRepoFile('server/routes/team-chat.js'), 'async function loadEditableMessage', 'async function getMessageById'));
    const deleteRoute = compact(between(readRepoFile('server/routes/team-chat.js'), "router.delete('/messages/:id'", "router.get('/attachments/:id/download'"));

    expect(db).toContain('ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS visible_until TIMESTAMPTZ');
    expect(db).toContain("SET visible_until = created_at + INTERVAL '7 days'");
    expect(route).toContain('const TEAM_CHAT_VISIBLE_INTERVAL = "INTERVAL \'7 days\'"');
    expect(route).toContain('visible_until: row.visible_until');
    expect(route).toContain('can_edit: !!row.can_edit');
    expect(route).toContain('can_delete: !!row.can_delete');
    expect(listMessages).toContain('COALESCE(msg.visible_until, msg.created_at + ${TEAM_CHAT_VISIBLE_INTERVAL}) > NOW()');
    expect(loadEditableMessage).toContain('Only the sender can change this Team Chat message.');
    expect(loadEditableMessage).toContain('Team Chat messages can only be changed within 7 days.');
    expect(deleteRoute).toContain('removed_at = NOW(), removed_by_staff_user_id = $2');
    expect(route).not.toContain('DELETE FROM native_team_chat_messages');
  });

  test('messages can be edited through a sender-only PATCH endpoint and edit broadcasts', () => {
    const route = compact(readRepoFile('server/routes/team-chat.js'));
    const view = compact(readRepoFile('server/views/team-chat.ejs'));
    const patchRoute = compact(between(readRepoFile('server/routes/team-chat.js'), "router.patch('/messages/:id'", "router.delete('/messages/:id'"));

    expect(patchRoute).toContain('loadEditableMessage');
    expect(patchRoute).toContain('original_body_encrypted = COALESCE(original_body_encrypted, body_encrypted)');
    expect(patchRoute).toContain('edited_at = NOW()');
    expect(patchRoute).toContain('edit_count = COALESCE(edit_count,0) + 1');
    expect(route).toContain('team-chat-message-edited');
    expect(view).toContain('data-edit-message-id');
    expect(view).toContain("apiJson('/api/team-chat/messages/' + encodeURIComponent(editMessageId), { method:'PATCH'");
    expect(view).toContain('teamChatChannel.bind(\'team-chat-message-edited\'');
    expect(view).toContain("m.edited_at ? ' · edited' : ''");
  });

  test('Team Chat composer accepts PDFs and supported files, not just images', () => {
    const route = compact(readRepoFile('server/routes/team-chat.js'));
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(route).toContain('TEAM_CHAT_ALLOWED_EXTENSIONS');
    expect(route).toContain("'pdf'");
    expect(route).toContain("'docx'");
    expect(route).toContain("'xlsx'");
    expect(route).toContain("'zip'");
    expect(route).toContain('TEAM_CHAT_BLOCKED_EXTENSIONS');
    expect(route).toContain('validateTeamChatUpload(file)');
    expect(route).toContain('You can attach up to 3 files to one Team Chat message.');
    expect(view).toContain('accept=".png,.jpg,.jpeg,.gif,.webp,.heic,.heif,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip');
    expect(view).toContain('function isAllowedTeamChatFile(file)');
    expect(view).toContain('Team Chat supports images, PDFs, Office files, text/CSV, and ZIP attachments.');
    expect(view).toContain('Type a message or attach up to 3 files first.');
    expect(view).not.toContain('Choose up to 3 images');
  });

  test('attachment preview hydration retries failed image/PDF preview requests', () => {
    const view = readRepoFile('server/views/team-chat.ejs');
    const hydrate = compact(between(view, 'async function hydrateAttachmentPreviews', 'function isEmojiOnlyMessage'));

    expect(hydrate).toContain('[data-team-attachment-preview-id]:not([data-preview-loaded]):not([data-preview-loading])');
    expect(hydrate).toContain("node.dataset.previewLoading = '1'");
    expect(hydrate).toContain("node.dataset.previewLoaded = '1'");
    expect(hydrate).toContain('delete node.dataset.previewLoaded');
    expect(hydrate).toContain('node.dataset.previewRetryCount = String(retryCount)');
    expect(hydrate).toContain("hydrateAttachmentPreviews(node.closest('.tc-msg') || scope)");
    expect(hydrate).toContain('delete node.dataset.previewLoading');
  });

  test('image attachments open in a lightbox and keep download explicit', () => {
    const view = compact(readRepoFile('server/views/team-chat.ejs'));

    expect(view).toContain('id="tc-image-lightbox"');
    expect(view).toContain('data-image-preview-id');
    expect(view).toContain('data-download-attachment-id');
    expect(view).toContain('function openImageLightbox(button)');
    expect(view).toContain("if (e.key === 'Escape'");
    expect(view).toContain('function downloadTeamChatAttachment(attachmentId, statusNode)');
  });
});

test.describe('Native Team Chat pivot gates — deployed auth boundary', () => {
  test.use({ storageState: undefined });

  for (const endpoint of ['/status', '/users', '/chats', '/messages?conversation_id=1']) {
    test(`GET /api/team-chat${endpoint} rejects unauthenticated requests`, async ({ request }) => {
      const res = await request.get(`${BASE_URL}/api/team-chat${endpoint}`);
      expect([401, 403]).toContain(res.status());
    });
  }
});
