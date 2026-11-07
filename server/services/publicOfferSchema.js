"use strict";

// Additive only. Existing firms keep their behavior until their owner changes it.
async function initializePublicOffer(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS firm_preferences (
      firm_id INTEGER PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
      settings JSONB NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS firm_integration_secrets (
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      account_name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      secret_encrypted TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(firm_id,provider,account_name)
    );
    CREATE TABLE IF NOT EXISTS summary_jobs (
      id UUID PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      summary_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      leased_until TIMESTAMPTZ,
      lease_id UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(firm_id,summary_date)
    );
    CREATE TABLE IF NOT EXISTS account_security (
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('staff','portal')),
      account_id INTEGER NOT NULL,
      signer_role TEXT NOT NULL DEFAULT 'taxpayer',
      version INTEGER NOT NULL DEFAULT 0,
      mfa_secret TEXT,
      pending_secret TEXT,
      pending_expires_at TIMESTAMPTZ,
      mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      last_totp_step BIGINT NOT NULL DEFAULT -1,
      recovery_hashes JSONB NOT NULL DEFAULT '[]',
      PRIMARY KEY(firm_id,kind,account_id,signer_role)
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      id UUID PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      account_id INTEGER NOT NULL,
      signer_role TEXT NOT NULL DEFAULT 'taxpayer',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      device_label TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS account_sessions_owner ON account_sessions(firm_id,kind,account_id,signer_role);
    ALTER TABLE portal_mobile_devices ADD COLUMN IF NOT EXISTS session_id UUID;
    ALTER TABLE portal_mobile_devices ADD COLUMN IF NOT EXISTS signer_role TEXT NOT NULL DEFAULT 'taxpayer';
    ALTER TABLE staff_mobile_devices ADD COLUMN IF NOT EXISTS session_id UUID;
    CREATE TABLE IF NOT EXISTS darklion_subscriptions (
      firm_id INTEGER PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
      customer_id TEXT UNIQUE,
      subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'unsubscribed',
      seat_quantity INTEGER NOT NULL DEFAULT 0,
      current_period_end TIMESTAMPTZ,
      cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscription_events (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS subscription_seat_sync (
      firm_id INTEGER PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE subscription_seat_sync ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
    CREATE OR REPLACE FUNCTION enqueue_subscription_seats() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (OLD.firm_id,OLD.role,OLD.accepted_at,OLD.archived_at)
        IS NOT DISTINCT FROM (NEW.firm_id,NEW.role,NEW.accepted_at,NEW.archived_at) THEN RETURN NULL; END IF;
      -- Selecting the parent also avoids re-creating a queue entry during a
      -- cascading firm deletion. A generation counter preserves concurrent edits.
      INSERT INTO subscription_seat_sync(firm_id)
        SELECT id FROM firms WHERE id=COALESCE(NEW.firm_id,OLD.firm_id)
      ON CONFLICT(firm_id) DO UPDATE SET requested_at=clock_timestamp(),next_attempt_at=NOW(),attempts=0,revision=subscription_seat_sync.revision+1;
      IF TG_OP='UPDATE' AND OLD.firm_id IS DISTINCT FROM NEW.firm_id THEN
        INSERT INTO subscription_seat_sync(firm_id) SELECT id FROM firms WHERE id=OLD.firm_id
        ON CONFLICT(firm_id) DO UPDATE SET next_attempt_at=NOW(),revision=subscription_seat_sync.revision+1;
      END IF;
      RETURN NULL;
    END $$;
    DROP TRIGGER IF EXISTS queue_subscription_seats ON firm_users;
    CREATE TRIGGER queue_subscription_seats AFTER INSERT OR UPDATE OR DELETE ON firm_users
      FOR EACH ROW EXECUTE FUNCTION enqueue_subscription_seats();
    CREATE TABLE IF NOT EXISTS firm_enrollment_invitations (
      token_hash TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      ledgerhq_firm_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_at TIMESTAMPTZ,
      firm_id INTEGER REFERENCES firms(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS enrolled_ledgerhq_firm ON firm_enrollment_invitations(ledgerhq_firm_id) WHERE accepted_at IS NOT NULL;
    -- Direct website signups verify email ownership without a LedgerHQ firm.
    ALTER TABLE firm_enrollment_invitations ALTER COLUMN ledgerhq_firm_id DROP NOT NULL;
    ALTER TABLE firm_enrollment_invitations ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ledgerhq';
    CREATE INDEX IF NOT EXISTS firm_enrollment_invitations_email_recent ON firm_enrollment_invitations(email,created_at);
    CREATE TABLE IF NOT EXISTS firm_imports (
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      result JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(firm_id,idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS customer_data_requests (
      id UUID PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('export','deletion')),
      account_kind TEXT NOT NULL CHECK(account_kind IN ('staff','portal')),
      account_id INTEGER NOT NULL,
      signer_role TEXT NOT NULL DEFAULT 'taxpayer',
      status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','reviewing','retained','completed','cancelled')),
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ai_usage (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      feature TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS ai_usage_firm_period ON ai_usage(firm_id,created_at);
    CREATE OR REPLACE FUNCTION revoke_changed_account_sessions() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME='firm_users' THEN
        IF (OLD.password_hash,OLD.email,OLD.archived_at,OLD.role,OLD.accepted_at,OLD.firm_id)
          IS DISTINCT FROM (NEW.password_hash,NEW.email,NEW.archived_at,NEW.role,NEW.accepted_at,NEW.firm_id) THEN
          INSERT INTO account_security(firm_id,kind,account_id,signer_role,version)
          VALUES(OLD.firm_id,'staff',OLD.id,'taxpayer',1)
          ON CONFLICT(firm_id,kind,account_id,signer_role) DO UPDATE SET version=account_security.version+1;
          UPDATE staff_mobile_devices SET disabled_at=NOW() WHERE firm_id=OLD.firm_id AND staff_user_id=OLD.id;
        END IF;
      ELSE
        IF (OLD.portal_password_hash,OLD.portal_enabled,OLD.email,OLD.firm_id)
          IS DISTINCT FROM (NEW.portal_password_hash,NEW.portal_enabled,NEW.email,NEW.firm_id) THEN
          INSERT INTO account_security(firm_id,kind,account_id,signer_role,version)
          VALUES(OLD.firm_id,'portal',OLD.id,'taxpayer',1)
          ON CONFLICT(firm_id,kind,account_id,signer_role) DO UPDATE SET version=account_security.version+1;
          UPDATE portal_mobile_devices SET disabled_at=NOW() WHERE firm_id=OLD.firm_id AND person_id=OLD.id AND signer_role='taxpayer';
        END IF;
        IF (OLD.spouse_portal_password_hash,OLD.spouse_portal_enabled,OLD.spouse_email,OLD.firm_id)
          IS DISTINCT FROM (NEW.spouse_portal_password_hash,NEW.spouse_portal_enabled,NEW.spouse_email,NEW.firm_id) THEN
          INSERT INTO account_security(firm_id,kind,account_id,signer_role,version)
          VALUES(OLD.firm_id,'portal',OLD.id,'spouse',1)
          ON CONFLICT(firm_id,kind,account_id,signer_role) DO UPDATE SET version=account_security.version+1;
          UPDATE portal_mobile_devices SET disabled_at=NOW() WHERE firm_id=OLD.firm_id AND person_id=OLD.id AND signer_role='spouse';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS revoke_staff_sessions ON firm_users;
    CREATE TRIGGER revoke_staff_sessions AFTER UPDATE ON firm_users FOR EACH ROW EXECUTE FUNCTION revoke_changed_account_sessions();
    DROP TRIGGER IF EXISTS revoke_portal_sessions ON people;
    CREATE TRIGGER revoke_portal_sessions AFTER UPDATE ON people FOR EACH ROW WHEN (OLD.firm_id IS NOT NULL) EXECUTE FUNCTION revoke_changed_account_sessions();
  `);
}

module.exports = { initializePublicOffer };
