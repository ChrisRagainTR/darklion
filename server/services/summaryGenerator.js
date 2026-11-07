'use strict';
const { completeText } = require('./managedInference');
const { getFirmPreferences } = require('./firmPreferences');
const { pool } = require('../db');
const { decrypt } = require('../utils/encryption');

async function generateDailySummary(firmId, date) {
  const prefs = await getFirmPreferences(firmId);
  if (!prefs.aiEnabled) throw new Error('AI summaries are disabled for this firm');
  // date is a Date object or 'YYYY-MM-DD' string
  const dateStr = typeof date === 'string' ? date : date.toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || Number.isNaN(Date.parse(dateStr))) throw new Error('Invalid summary date');

  // Get all threads with activity on this date (client messages only, non-system)
  const { rows: activeThreads } = await pool.query(`
    SELECT DISTINCT mt.id, mt.subject, mt.staff_user_id,
      ARRAY(SELECT tp.firm_user_id FROM thread_participants tp WHERE tp.thread_id=mt.id AND tp.firm_id=mt.firm_id AND tp.archived_at IS NULL) AS participants,
      p.first_name || ' ' || p.last_name as client_name,
      fu.name as staff_name
    FROM messages m
    JOIN message_threads mt ON mt.id = m.thread_id
    JOIN people p ON p.id = mt.person_id AND p.firm_id = mt.firm_id
    JOIN firm_users fu ON fu.id = mt.staff_user_id AND fu.firm_id = mt.firm_id
    WHERE mt.firm_id = $1
      AND m.sender_type = 'client'
      AND m.removed_at IS NULL
      AND m.is_system_message = false
      AND m.is_internal = false
      AND DATE(m.created_at AT TIME ZONE $3) = $2
  `, [firmId, dateStr, prefs.timezone]);

  // For each thread, get the day's messages
  const threadSummaries = [];

  for (const thread of activeThreads) {
    const { rows: msgs } = await pool.query(`
      SELECT m.body, m.sender_type, m.is_internal, m.created_at,
        COALESCE(fu.name, 'Client') as sender_name
      FROM messages m
      LEFT JOIN firm_users fu ON fu.id = m.sender_id AND m.sender_type = 'staff'
      WHERE m.thread_id = $1
        AND m.is_internal = false
        AND m.removed_at IS NULL
        AND m.is_system_message = false
        AND DATE(m.created_at AT TIME ZONE $3) = $2
      ORDER BY m.created_at ASC
    `, [thread.id, dateStr, prefs.timezone]);

    if (!msgs.length) continue;

    // Build conversation text for Claude
    const convoText = msgs.map(m => {
      const role = m.is_internal ? '[Internal Note]' : (m.sender_type === 'client' ? thread.client_name : m.sender_name);
      return `${role}: ${m.body}`;
    }).join('\n');

    // Ask Claude to summarize
    try {
      const text = await completeText({firmId,feature:'daily-summary',maxTokens:300,prompt: `Summarize this client conversation in 2-4 bullet points. Be concise. Focus on: what the client asked/discussed, any action items or follow-ups needed, and key outcomes. Do NOT include internal notes in the summary.

Client: ${thread.client_name}
Staff: ${thread.staff_name}

Conversation:
${convoText}

Reply with bullet points only, starting each with "•". No preamble.`
      });

      threadSummaries.push({
        thread_id: thread.id,
        client_name: thread.client_name,
        staff_name: thread.staff_name,
        staff_user_id: thread.staff_user_id,
        visible_staff_ids: [thread.staff_user_id,...thread.participants],
        subject: thread.subject,
        bullets: text.trim(),
        message_count: msgs.length,
      });
    } catch (e) {
      console.error(`[summaryGenerator] AI request failed for firm ${firmId}`);
      if (prefs.edition === 'public') throw new Error('Summary inference unavailable');
      // Fallback — include without AI summary
      threadSummaries.push({
        thread_id: thread.id,
        client_name: thread.client_name,
        staff_name: thread.staff_name,
        staff_user_id: thread.staff_user_id,
        visible_staff_ids: [thread.staff_user_id,...thread.participants],
        subject: thread.subject,
        bullets: `• ${msgs.length} message(s) exchanged`,
        message_count: msgs.length,
      });
    }
  }

  // Group by staff member
  const byStaff = {};
  for (const t of threadSummaries) {
    const key = t.staff_user_id;
    if (!byStaff[key]) byStaff[key] = { staff_name: t.staff_name, staff_user_id: t.staff_user_id, threads: [] };
    byStaff[key].threads.push(t);
  }

  const { rows: activeTeamChats } = await pool.query(`
    SELECT DISTINCT c.id, c.title, c.conversation_type,
      COALESCE(NULLIF(c.title, ''),
        CASE WHEN c.conversation_type = 'dm' THEN 'Direct message' ELSE 'Team conversation' END
      ) AS conversation_title,
      COALESCE(
        jsonb_agg(DISTINCT jsonb_build_object('id', fu.id, 'name', COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email)))
          FILTER (WHERE fu.id IS NOT NULL),
        '[]'::jsonb
      ) AS members,
      COALESCE(array_agg(DISTINCT m.staff_user_id) FILTER (WHERE m.staff_user_id IS NOT NULL), '{}') AS member_user_ids
    FROM native_team_chat_messages msg
    JOIN native_team_chat_conversations c ON c.id = msg.conversation_id AND c.firm_id = msg.firm_id
    LEFT JOIN native_team_chat_members m ON m.conversation_id = c.id AND m.firm_id = c.firm_id AND m.left_at IS NULL
    LEFT JOIN firm_users fu ON fu.id = m.staff_user_id AND fu.firm_id = c.firm_id
    WHERE msg.firm_id = $1
      AND msg.deleted_at IS NULL
      AND msg.message_kind <> 'system'
      AND DATE(msg.created_at AT TIME ZONE $3) = $2
    GROUP BY c.id, c.title, c.conversation_type
    ORDER BY c.id
  `, [firmId, dateStr, prefs.timezone]);

  const teamChatSummaries = [];
  for (const chat of activeTeamChats) {
    const { rows: msgs } = await pool.query(`
      SELECT msg.body_encrypted, msg.created_at,
        COALESCE(NULLIF(fu.display_name, ''), fu.name, fu.email, 'Unknown staff') AS sender_name,
        COALESCE(att.attachment_count, 0)::int AS attachment_count
      FROM native_team_chat_messages msg
      LEFT JOIN firm_users fu ON fu.id = msg.sender_staff_user_id AND fu.firm_id = msg.firm_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) AS attachment_count
        FROM native_team_chat_attachments a
        WHERE a.firm_id = msg.firm_id AND a.message_id = msg.id
      ) att ON TRUE
      WHERE msg.firm_id = $1
        AND msg.conversation_id = $2
        AND msg.deleted_at IS NULL
        AND msg.message_kind <> 'system'
        AND DATE(msg.created_at AT TIME ZONE $4) = $3
      ORDER BY msg.created_at ASC
    `, [firmId, chat.id, dateStr, prefs.timezone]);

    if (!msgs.length) continue;
    const memberNames = Array.isArray(chat.members) ? chat.members.map(m => m.name).filter(Boolean) : [];
    const title = chat.title || (chat.conversation_type === 'dm' && memberNames.length ? memberNames.join(' + ') : chat.conversation_title);
    const convoText = msgs.map(m => {
      const body = decrypt(m.body_encrypted) || (m.attachment_count ? `[${m.attachment_count} attachment${m.attachment_count === 1 ? '' : 's'}]` : '');
      return `${m.sender_name}: ${body}`;
    }).join('\n');

    try {
      const text = await completeText({firmId,feature:'daily-summary',maxTokens:300,prompt: `Summarize this internal Team Chat conversation in 2-4 bullet points. Be concise. Focus on decisions, context, blockers, action items, and outcomes.\n\nChat: ${title}\nMembers: ${memberNames.join(', ') || 'Unknown'}\n\nConversation:\n${convoText}\n\nReply with bullet points only, starting each with "•". No preamble.`
      });
      teamChatSummaries.push({
        conversation_id: chat.id,
        title,
        conversation_type: chat.conversation_type,
        member_user_ids: (chat.member_user_ids || []).map(Number).filter(Boolean),
        member_names: memberNames,
        bullets: text.trim(),
        message_count: msgs.length,
      });
    } catch (e) {
      console.error(`[summaryGenerator] AI request failed for firm ${firmId}`);
      if (prefs.edition === 'public') throw new Error('Summary inference unavailable');
      teamChatSummaries.push({
        conversation_id: chat.id,
        title,
        conversation_type: chat.conversation_type,
        member_user_ids: (chat.member_user_ids || []).map(Number).filter(Boolean),
        member_names: memberNames,
        bullets: `• ${msgs.length} team chat message(s) exchanged`,
        message_count: msgs.length,
      });
    }
  }

  const summaryJson = {
    date: dateStr,
    generated_at: new Date().toISOString(),
    by_staff: Object.values(byStaff),
    team_chats: teamChatSummaries,
    team_chat_count: teamChatSummaries.length,
    thread_count: threadSummaries.length + teamChatSummaries.length,
  };

  await pool.query(`
    INSERT INTO conversation_summaries (firm_id, summary_date, summary_json)
    VALUES ($1, $2, $3)
    ON CONFLICT (firm_id, summary_date) DO UPDATE SET summary_json = EXCLUDED.summary_json, generated_at = NOW()
  `, [firmId, dateStr, JSON.stringify(summaryJson)]);

  console.log(`[summaryGenerator] Generated summary for firm ${firmId} on ${dateStr}: ${threadSummaries.length} threads, ${teamChatSummaries.length} team chats`);
  return summaryJson;
}

module.exports = { generateDailySummary };
