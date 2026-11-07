"use strict";
async function initializeAdmin(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      user_id INTEGER PRIMARY KEY REFERENCES firm_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS support_sessions (
      id UUID PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES firm_users(id),
      admin_session_id UUID NOT NULL REFERENCES account_sessions(id),
      admin_version INTEGER NOT NULL,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      target_user_id INTEGER NOT NULL REFERENCES firm_users(id),
      target_version INTEGER NOT NULL,
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 500),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '30 minutes',
      ended_at TIMESTAMPTZ,
      admin_name TEXT NOT NULL,
      target_name TEXT NOT NULL,
      firm_name TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS support_sessions_firm_created ON support_sessions(firm_id,created_at DESC);
    ALTER TABLE support_sessions ADD COLUMN IF NOT EXISTS ended_by INTEGER REFERENCES firm_users(id);
    -- Emailed-code unlock of the admin center. Each verified row is an admin
    -- session bound to the staff login it was started from.
    CREATE TABLE IF NOT EXISTS platform_admin_unlocks (
      id UUID PRIMARY KEY,
      admin_user_id INTEGER NOT NULL REFERENCES firm_users(id),
      admin_session_id UUID NOT NULL REFERENCES account_sessions(id),
      admin_version INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      sent_to TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      code_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '10 minutes',
      verified_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS platform_admin_unlocks_session ON platform_admin_unlocks(admin_session_id);
    -- Every request made with a support token, allowed or denied.
    CREATE TABLE IF NOT EXISTS support_session_events (
      id BIGSERIAL PRIMARY KEY,
      support_session_id UUID NOT NULL REFERENCES support_sessions(id),
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      allowed BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS support_session_events_session ON support_session_events(support_session_id,id);
  `);
}
module.exports = { initializeAdmin };
