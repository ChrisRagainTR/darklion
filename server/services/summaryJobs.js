"use strict";
const crypto = require("node:crypto");
const { pool } = require("../db");
async function enqueueSummary(firmId, date, db = pool) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
    throw Error("Invalid summary date");
  return (
    await db.query(
      `INSERT INTO summary_jobs(id,firm_id,summary_date) VALUES($1,$2,$3)
    ON CONFLICT(firm_id,summary_date) DO UPDATE SET
      status=CASE WHEN summary_jobs.status IN ('completed','failed') THEN 'queued' ELSE summary_jobs.status END,
      attempts=CASE WHEN summary_jobs.status IN ('completed','failed') THEN 0 ELSE summary_jobs.attempts END,
      available_at=NOW(),updated_at=NOW() RETURNING id,status`,
      [crypto.randomUUID(), firmId, date],
    )
  ).rows[0];
}
async function enqueueDueSummaries(db = pool, now = new Date()) {
  // Evaluate local time in Postgres so DST and half-hour zones work. Catch up
  // after a restart through the following day; never reset completed jobs.
  const due = await db.query(
    `SELECT f.id,
    CASE WHEN local.time::time >= TIME '22:00' THEN local.time::date
      ELSE local.time::date-1 END::text AS date
    FROM firms f LEFT JOIN firm_preferences p ON p.firm_id=f.id
    CROSS JOIN LATERAL (SELECT $1::timestamptz AT TIME ZONE
      COALESCE(p.settings->>'timezone','America/New_York') AS time) local
    WHERE COALESCE((p.settings->>'aiEnabled')::boolean,TRUE)
      AND (COALESCE(p.settings->>'edition','existing') <> 'public' OR EXISTS(
        SELECT 1 FROM darklion_subscriptions s WHERE s.firm_id=f.id AND s.status IN ('active','trialing')))`,
    [now],
  );
  for (const firm of due.rows)
    await db.query(
      `INSERT INTO summary_jobs(id,firm_id,summary_date)
    VALUES($1,$2,$3) ON CONFLICT(firm_id,summary_date) DO NOTHING`,
      [crypto.randomUUID(), firm.id, firm.date],
    );
  return due.rowCount;
}
async function processSummaryJob(
  db = pool,
  generate = require("./summaryGenerator").generateDailySummary,
) {
  const lease = crypto.randomUUID();
  const row = (
    await db.query(
      `UPDATE summary_jobs SET status='running',attempts=attempts+1,
    lease_id=$1,leased_until=NOW()+INTERVAL '5 minutes',updated_at=NOW() WHERE id=(
      SELECT id FROM summary_jobs WHERE (status='queued' AND available_at<=NOW())
        OR (status='running' AND leased_until<NOW()) ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING id,firm_id,summary_date::text,attempts`,
      [lease],
    )
  ).rows[0];
  if (!row) return false;
  const heartbeat = setInterval(() => {
    db.query(
      "UPDATE summary_jobs SET leased_until=NOW()+INTERVAL '5 minutes' WHERE id=$1 AND lease_id=$2",
      [row.id, lease],
    ).catch(() => {});
  }, 60000);
  heartbeat.unref();
  try {
    await generate(row.firm_id, row.summary_date);
    await db.query(
      "UPDATE summary_jobs SET status='completed',leased_until=NULL,lease_id=NULL,updated_at=NOW() WHERE id=$1 AND lease_id=$2",
      [row.id, lease],
    );
  } catch (_) {
    await db.query(
      "UPDATE summary_jobs SET status=$3,available_at=NOW()+INTERVAL '5 minutes',leased_until=NULL,lease_id=NULL,updated_at=NOW() WHERE id=$1 AND lease_id=$2",
      [row.id, lease, row.attempts >= 3 ? "failed" : "queued"],
    );
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
function startSummaryWorker() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await processSummaryJob();
    } catch (_) {
      console.error("[summary-jobs] worker unavailable");
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(tick, 15000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
module.exports = {
  enqueueSummary,
  enqueueDueSummaries,
  processSummaryJob,
  startSummaryWorker,
};
