"use strict";

const { pool } = require("../db");
const { getFirmPreferences } = require("./firmPreferences");

// Public summaries grant no more access than the underlying conversation does
// today. Saved participant lists also prevent newly added members from gaining
// access to summaries generated before they joined.
async function summaryVisibility(firmId, staffUserId, db = pool) {
  const preferences = await getFirmPreferences(firmId, db);
  if (preferences.edition !== "public") return { publicFirm: false };
  const threads = await db.query(
    `SELECT t.id FROM message_threads t
    WHERE t.firm_id=$1 AND (t.staff_user_id=$2 OR EXISTS (
      SELECT 1 FROM thread_participants p WHERE p.thread_id=t.id
      AND p.firm_id=t.firm_id AND p.firm_user_id=$2 AND p.archived_at IS NULL))`,
    [firmId, staffUserId],
  );
  const chats = await db.query(
    `SELECT c.id FROM native_team_chat_conversations c
    JOIN native_team_chat_members m ON m.conversation_id=c.id AND m.firm_id=c.firm_id
    WHERE c.firm_id=$1 AND m.staff_user_id=$2 AND m.left_at IS NULL`,
    [firmId, staffUserId],
  );
  return {
    publicFirm: true,
    threads: new Set(threads.rows.map((r) => Number(r.id))),
    chats: new Set(chats.rows.map((r) => Number(r.id))),
  };
}

function filterSummary(
  summary,
  staffUserId,
  visibility = { publicFirm: false },
) {
  const staffId = Number(staffUserId);
  const byStaff = (Array.isArray(summary?.by_staff) ? summary.by_staff : [])
    .map((group) => ({
      ...group,
      threads: (Array.isArray(group.threads) ? group.threads : []).filter(
        (thread) =>
          visibility.publicFirm
            ? visibility.threads.has(Number(thread.thread_id)) &&
              (thread.visible_staff_ids || [thread.staff_user_id])
                .map(Number)
                .includes(staffId)
            : Number(group.staff_user_id) !== staffId,
      ),
    }))
    .filter((group) => group.threads.length);
  const teamChats = (
    Array.isArray(summary?.team_chats) ? summary.team_chats : []
  ).filter((chat) => {
    const member = (chat.member_user_ids || []).map(Number).includes(staffId);
    return visibility.publicFirm
      ? member && visibility.chats.has(Number(chat.conversation_id))
      : !member;
  });
  return {
    ...summary,
    by_staff: byStaff,
    team_chats: teamChats,
    team_chat_count: teamChats.length,
    thread_count:
      byStaff.reduce((n, group) => n + group.threads.length, 0) +
      teamChats.length,
  };
}

module.exports = { summaryVisibility, filterSummary };
