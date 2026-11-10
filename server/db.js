const { Pool } = require('pg');

// Enable SSL for any cloud Postgres (Neon, Supabase, Railway, Render, etc.)
// Disable only for local dev (localhost/127.0.0.1) or when explicitly set
const dbUrl = process.env.DATABASE_URL || '';
const parsedUrl = dbUrl ? new URL(dbUrl) : null;
const isLocal = ['localhost','127.0.0.1','[::1]'].includes(parsedUrl?.hostname);
const privateRailway = parsedUrl?.hostname.endsWith('.railway.internal');
const sslOff = process.env.DB_SSL === 'false';
// URL sslmode can override pg's TLS object, so use explicit verification for
// public database endpoints. Railway's private Postgres uses a self-signed cert.
if (parsedUrl && !isLocal && !sslOff && !privateRailway) {
  for (const key of ['sslmode','ssl','sslcert','sslkey','sslrootcert']) parsedUrl.searchParams.delete(key);
}

const pool = new Pool({
  connectionString: parsedUrl?.href || dbUrl,
  ssl: (isLocal || sslOff) ? false : { rejectUnauthorized: !privateRailway },
  connectionTimeoutMillis: 10000,
});

require('./services/supportReadOnly').protectPool(pool);

// Initialize tables
async function initDB() {
  await pool.query(`
    -- ===================== FIRMS (multi-tenant) =====================
    CREATE TABLE IF NOT EXISTS firms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      plan TEXT DEFAULT 'trial'
    );

    -- Branding is also required on newly initialized firm databases. Existing
    -- production values must survive this idempotent initialization.
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS logo_url TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS portal_icon_url TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS portal_logo_style TEXT
      CHECK (portal_logo_style IN ('icon', 'logo'));
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS primary_color TEXT DEFAULT '#C9A84C';
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS tagline TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS contact_email TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS website TEXT;
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS address TEXT;

    -- Operator-controlled product rollouts. Missing overrides preserve existing
    -- behavior; authorization boundaries are never controlled by these flags.
    CREATE TABLE IF NOT EXISTS firm_feature_flags (
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL,
      enabled BOOLEAN NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (firm_id, feature_key)
    );

    -- ===================== COMPANIES =====================
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      realm_id TEXT UNIQUE NOT NULL,
      company_name TEXT DEFAULT '',
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      token_expires_at BIGINT NOT NULL,
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      last_sync_at TIMESTAMPTZ,
      firm_id INTEGER REFERENCES firms(id)
    );

    -- Add firm_id to companies if it doesn't exist yet (migration)
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS firm_id INTEGER REFERENCES firms(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== AUDIT LOG =====================
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      qb_id TEXT NOT NULL,
      txn_type TEXT NOT NULL DEFAULT 'Purchase',
      date TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT DEFAULT '',
      vendor_name TEXT DEFAULT '',
      original_account TEXT DEFAULT '',
      ai_category TEXT,
      ai_confidence REAL,
      ai_memo TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','categorized','reviewed','written_back','skipped')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(realm_id, qb_id),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      qb_vendor_id TEXT,
      business_category TEXT,
      description TEXT,
      location TEXT,
      researched_at TIMESTAMPTZ,
      UNIQUE(realm_id, vendor_name),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS category_rules (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(realm_id, vendor_name),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      items_processed INTEGER DEFAULT 0,
      items_total INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS scan_results (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      scan_type TEXT NOT NULL,
      period TEXT NOT NULL DEFAULT '',
      scanned_at TIMESTAMPTZ DEFAULT NOW(),
      result_data JSONB NOT NULL DEFAULT '{}',
      flag_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'new' CHECK(status IN ('new','reviewed','resolved')),
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS close_packages (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      period TEXT NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      report_data JSONB NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','reviewed','finalized')),
      reviewer_notes TEXT DEFAULT '',
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    CREATE TABLE IF NOT EXISTS ledgerhq_close_packages (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      darklion_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      ledgerhq_company_id TEXT NOT NULL,
      period TEXT NOT NULL,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      report_data JSONB NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','reviewed','finalized')),
      reviewer_notes TEXT DEFAULT '',
      UNIQUE(darklion_company_id, ledgerhq_company_id, period)
    );
    CREATE INDEX IF NOT EXISTS idx_ledgerhq_close_packages_company
      ON ledgerhq_close_packages(darklion_company_id, generated_at DESC);

    CREATE TABLE IF NOT EXISTS bookkeeping_connections (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected','disconnected','error')),
      access_token TEXT DEFAULT '',
      refresh_token TEXT DEFAULT '',
      token_expires_at BIGINT DEFAULT 0,
      provider_firm_id TEXT DEFAULT '',
      metadata_json JSONB NOT NULL DEFAULT '{}',
      last_error TEXT DEFAULT '',
      connected_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_bookkeeping_connections_firm_provider
      ON bookkeeping_connections(firm_id, provider, status);

    CREATE TABLE IF NOT EXISTS company_bookkeeping_links (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      darklion_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      provider_company_id TEXT NOT NULL,
      provider_company_name TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(darklion_company_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_company_bookkeeping_links_firm_provider
      ON company_bookkeeping_links(firm_id, provider, active);

    CREATE TABLE IF NOT EXISTS ledgerhq_oauth_states (
      id SERIAL PRIMARY KEY,
      state TEXT UNIQUE NOT NULL,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      return_to TEXT DEFAULT '/settings?tab=integrations',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledgerhq_oauth_states_expiry
      ON ledgerhq_oauth_states(expires_at);

    CREATE TABLE IF NOT EXISTS statement_schedules (
      id SERIAL PRIMARY KEY,
      realm_id TEXT NOT NULL,
      client_name TEXT NOT NULL DEFAULT '',
      account_name TEXT NOT NULL DEFAULT '',
      institution TEXT DEFAULT '',
      access_method TEXT DEFAULT 'portal',
      statement_day INTEGER DEFAULT 1,
      reminder_cadence TEXT DEFAULT '1,5,10',
      contact_email TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      last_reminded_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ,
      current_month TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      FOREIGN KEY (realm_id) REFERENCES companies(realm_id)
    );

    -- Add UNIQUE constraint on statement_schedules (realm_id, account_name) if not exists
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD CONSTRAINT statement_schedules_realm_account_unique UNIQUE (realm_id, account_name);
    EXCEPTION WHEN duplicate_table THEN NULL;
    WHEN duplicate_object THEN NULL;
    END $$;

    -- Add qb_account_id column if not exists
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD COLUMN qb_account_id TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    -- Add last_retrieved_month column if not exists
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD COLUMN last_retrieved_month TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    -- Add start_month column (client_upload accounts only: first month client needs to upload)
    DO $$ BEGIN
      ALTER TABLE statement_schedules ADD COLUMN start_month TEXT DEFAULT '';
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS statement_monthly_status (
      id SERIAL PRIMARY KEY,
      schedule_id INTEGER NOT NULL REFERENCES statement_schedules(id) ON DELETE CASCADE,
      realm_id TEXT NOT NULL,
      month TEXT NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','requested','received','uploaded')),
      received_at TIMESTAMPTZ,
      notes TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(schedule_id, month)
    );

    -- ===================== FIRM USERS (multi-user per firm) =====================
    CREATE TABLE IF NOT EXISTS firm_users (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'admin' CHECK(role IN ('owner','admin')),
      invite_token TEXT UNIQUE,
      invite_expires_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_login_at TIMESTAMPTZ,
      UNIQUE(firm_id, email)
    );

    CREATE TABLE IF NOT EXISTS firm_user_companies (
      id SERIAL PRIMARY KEY,
      firm_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      realm_id TEXT NOT NULL,
      UNIQUE(firm_user_id, realm_id)
    );

    -- Migrate existing firm owners into firm_users (idempotent)
    INSERT INTO firm_users (firm_id, name, email, password_hash, role, accepted_at)
    SELECT id, name, email, password_hash, 'owner', NOW()
    FROM firms
    ON CONFLICT (firm_id, email) DO NOTHING;

    -- ===================== FIRM USERS: display_name + expanded roles =====================
    ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS display_name TEXT DEFAULT '';

    -- ===================== FIRM USERS: avatar_url =====================
    DO $$ BEGIN
      ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS avatar_url TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE firm_users DROP CONSTRAINT IF EXISTS firm_users_role_check;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE firm_users ADD CONSTRAINT firm_users_role_check CHECK (role IN ('owner','admin','staff','agent'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- ===================== MCP OAUTH 2.1 =====================
    CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT NOT NULL DEFAULT 'MCP client',
      redirect_uris JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
      code_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
      redirect_uri TEXT NOT NULL,
      resource TEXT NOT NULL,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      scopes TEXT[] NOT NULL,
      code_challenge TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_expiry ON mcp_oauth_codes(expires_at);

    CREATE TABLE IF NOT EXISTS mcp_oauth_access_tokens (
      token_hash TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
      resource TEXT NOT NULL,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      scopes TEXT[] NOT NULL,
      refresh_family_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_access_expiry ON mcp_oauth_access_tokens(expires_at);

    CREATE TABLE IF NOT EXISTS mcp_oauth_refresh_tokens (
      token_hash TEXT PRIMARY KEY,
      refresh_family_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
      resource TEXT NOT NULL,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      scopes TEXT[] NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_oauth_refresh_family ON mcp_oauth_refresh_tokens(refresh_family_id);

    -- ===================== RELATIONSHIPS =====================
    CREATE TABLE IF NOT EXISTS relationships (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      name TEXT NOT NULL DEFAULT '',
      service_tier TEXT DEFAULT 'standard',
      stripe_customer_id TEXT DEFAULT '',
      stripe_subscription_id TEXT DEFAULT '',
      billing_status TEXT DEFAULT 'active',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== COMPANIES: new columns =====================
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS relationship_id INTEGER REFERENCES relationships(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT 'other';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS ein_encrypted TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_year_end TEXT DEFAULT '12/31';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS stanford_tax_url TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== PEOPLE =====================
    CREATE TABLE IF NOT EXISTS people (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      relationship_id INTEGER REFERENCES relationships(id),
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      date_of_birth_encrypted TEXT DEFAULT '',
      ssn_last4 TEXT DEFAULT '',
      ssn_encrypted TEXT DEFAULT '',
      filing_status TEXT DEFAULT '',
      portal_enabled BOOLEAN DEFAULT FALSE,
      portal_password_hash TEXT,
      portal_invite_token TEXT UNIQUE,
      portal_invite_expires_at TIMESTAMPTZ,
      portal_last_login_at TIMESTAMPTZ,
      spouse_name TEXT DEFAULT '',
      spouse_email TEXT DEFAULT '',
      spouse_portal_enabled BOOLEAN DEFAULT FALSE,
      spouse_portal_password_hash TEXT,
      spouse_portal_invite_token TEXT,
      spouse_portal_invite_expires_at TIMESTAMPTZ,
      spouse_portal_last_login_at TIMESTAMPTZ,
      stanford_tax_url TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE people ADD COLUMN IF NOT EXISTS profile_revision BIGINT NOT NULL DEFAULT 0;

    -- ===================== PERSON_COMPANY_ACCESS =====================
    CREATE TABLE IF NOT EXISTS person_company_access (
      id SERIAL PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      access_level TEXT NOT NULL DEFAULT 'full',
      ownership_pct NUMERIC(5,2),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id, company_id)
    );

    -- ===================== FIRMS: slug column =====================
    DO $$ BEGIN
      ALTER TABLE firms ADD COLUMN IF NOT EXISTS slug TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE UNIQUE INDEX IF NOT EXISTS firms_slug_unique ON firms(slug) WHERE slug != '';

    -- ===================== BACKFILL: set slug for firms that don't have one =====================
    DO $$ BEGIN
      UPDATE firms
      SET slug = LOWER(REGEXP_REPLACE(REGEXP_REPLACE(name, '[^a-zA-Z0-9 ]', '', 'g'), '\s+', '', 'g'))
      WHERE slug IS NULL OR slug = '';
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    -- ===================== BACKFILL: create relationships for existing companies =====================
    DO $$ BEGIN
      INSERT INTO relationships (firm_id, name, created_at, updated_at)
      SELECT DISTINCT c.firm_id, c.company_name, NOW(), NOW()
      FROM companies c
      WHERE c.relationship_id IS NULL AND c.company_name IS NOT NULL AND c.company_name != ''
      ON CONFLICT DO NOTHING;

      UPDATE companies c
      SET relationship_id = r.id
      FROM relationships r
      WHERE c.relationship_id IS NULL
        AND r.firm_id = c.firm_id
        AND r.name = c.company_name;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    -- Add notes to companies (idempotent)
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Add bookkeeper_id and bookkeeping_service to companies (idempotent)
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS bookkeeper_id INTEGER;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS bookkeeping_service TEXT DEFAULT 'none';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS bookkeeping_provider TEXT NOT NULL DEFAULT 'ledgerhq'
        CHECK (bookkeeping_provider IN ('ledgerhq', 'qbo'));
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Add folder_section and folder_category to documents (idempotent)
    DO $$ BEGIN
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_section TEXT DEFAULT 'firm_uploaded';
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_category TEXT DEFAULT 'other';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Add last_notification_sent_at to people (for smart message notifications)
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS last_notification_sent_at TIMESTAMPTZ;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== DOCUMENTS =====================
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      owner_type TEXT NOT NULL DEFAULT 'company',
      owner_id INTEGER NOT NULL,
      year TEXT DEFAULT '',
      doc_type TEXT DEFAULT 'other',
      display_name TEXT DEFAULT '',
      s3_bucket TEXT DEFAULT '',
      s3_key TEXT DEFAULT '',
      mime_type TEXT DEFAULT '',
      size_bytes INTEGER DEFAULT 0,
      uploaded_by_type TEXT DEFAULT 'staff',
      uploaded_by_id INTEGER,
      folder_section TEXT DEFAULT 'firm_uploaded',
      folder_category TEXT DEFAULT 'other',
      is_delivered BOOLEAN DEFAULT FALSE,
      delivered_at TIMESTAMPTZ,
      viewed_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      deleted_by INTEGER,
      delete_reason TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- The referenced table must exist before a fresh database adds this link.
    ALTER TABLE statement_monthly_status ADD COLUMN IF NOT EXISTS document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL;

    -- Documents trash / soft delete metadata (idempotent)
    DO $$ BEGIN
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS deleted_by INTEGER;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS delete_reason TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_documents_firm_owner_deleted
      ON documents(firm_id, owner_type, owner_id, deleted_at);

    -- ===================== CUSTOM DOCUMENT FOLDERS =====================
    -- Additive metadata only: the existing section -> year -> category layout
    -- remains the source of truth, with one optional staff-defined folder level.
    CREATE TABLE IF NOT EXISTS document_folders (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'client',
      applies_to TEXT NOT NULL DEFAULT 'all',
      owner_type TEXT,
      owner_id INTEGER,
      folder_section TEXT NOT NULL DEFAULT 'firm_uploaded',
      folder_category TEXT NOT NULL DEFAULT 'other',
      name TEXT NOT NULL,
      created_by INTEGER,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    DO $$ BEGIN
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_folder_id INTEGER REFERENCES document_folders(id) ON DELETE SET NULL;
      ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder_subcategory TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_document_folders_firm_active
      ON document_folders(firm_id, folder_section, folder_category, archived_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_folders_unique_firm
      ON document_folders(firm_id, applies_to, folder_section, folder_category, LOWER(name))
      WHERE scope = 'firm' AND archived_at IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_folders_unique_client
      ON document_folders(firm_id, owner_type, owner_id, folder_section, folder_category, LOWER(name))
      WHERE scope = 'client' AND archived_at IS NULL;

    -- ===================== AGENT ACTIVITY LOG =====================
    CREATE TABLE IF NOT EXISTS activity_events (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      event_date DATE NOT NULL DEFAULT ((NOW() AT TIME ZONE 'America/New_York')::date),
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
      relationship_id INTEGER REFERENCES relationships(id) ON DELETE SET NULL,
      tax_year TEXT DEFAULT '',
      entity_type TEXT DEFAULT '',
      entity_id INTEGER,
      source_table TEXT DEFAULT '',
      source_id TEXT DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      dedupe_key TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS activity_events_firm_date_recent
      ON activity_events(firm_id, event_date, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS activity_events_firm_type_recent
      ON activity_events(firm_id, event_type, occurred_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS activity_events_firm_dedupe_key
      ON activity_events(firm_id, dedupe_key)
      WHERE dedupe_key IS NOT NULL;

    -- ===================== DOCUMENT UPLOAD NOTIFICATIONS =====================
    CREATE TABLE IF NOT EXISTS document_notification_routes (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      folder_category TEXT NOT NULL CHECK(folder_category IN ('tax','bookkeeping','other')),
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(firm_id, folder_category, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_notification_routes_lookup
      ON document_notification_routes(firm_id, folder_category, staff_user_id);


    CREATE TABLE IF NOT EXISTS document_upload_notifications (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      uploader_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('person','company')),
      owner_id INTEGER NOT NULL,
      folder_category TEXT NOT NULL CHECK(folder_category IN ('tax','bookkeeping','other')),
      document_folder_id INTEGER REFERENCES document_folders(id) ON DELETE SET NULL,
      folder_subcategory TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      file_count INTEGER NOT NULL DEFAULT 1 CHECK(file_count > 0),
      summary TEXT NOT NULL DEFAULT '',
      grouping_key TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_document_upload_notifications_grouping
      ON document_upload_notifications(firm_id, grouping_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS document_upload_notification_documents (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      notification_id BIGINT NOT NULL REFERENCES document_upload_notifications(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(notification_id, document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_upload_notification_documents_firm
      ON document_upload_notification_documents(firm_id, notification_id, document_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_document_upload_notification_documents_unique
      ON document_upload_notification_documents(firm_id, document_id);

    CREATE TABLE IF NOT EXISTS document_upload_notification_recipients (
      id BIGSERIAL PRIMARY KEY,
      notification_id BIGINT NOT NULL REFERENCES document_upload_notifications(id) ON DELETE CASCADE,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(notification_id, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_upload_recipients_inbox
      ON document_upload_notification_recipients(firm_id, staff_user_id, archived_at, read_at, notification_id);

    -- Durable handoff from document creation to notification processing. The
    -- trigger runs in the same transaction as the document INSERT, closing the
    -- crash window between a successful upload record and async processing.
    CREATE TABLE IF NOT EXISTS document_upload_notification_outbox (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      uploader_person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      owner_type TEXT NOT NULL CHECK(owner_type IN ('person','company')),
      owner_id INTEGER NOT NULL,
      folder_category TEXT NOT NULL,
      document_folder_id INTEGER,
      folder_subcategory TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL DEFAULT 'Document',
      uploaded_by_type TEXT NOT NULL,
      folder_section TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(firm_id, document_id)
    );
    CREATE INDEX IF NOT EXISTS idx_document_upload_notification_outbox_pending
      ON document_upload_notification_outbox(status, next_attempt_at, id);

    CREATE OR REPLACE FUNCTION enqueue_document_upload_notification()
    RETURNS TRIGGER AS $document_notification_outbox$
    BEGIN
      IF NEW.uploaded_by_type = 'client'
         AND NEW.folder_section = 'client_uploaded'
         AND NEW.folder_category <> 'message_docs'
         AND NEW.uploaded_by_id IS NOT NULL THEN
        INSERT INTO document_upload_notification_outbox
          (firm_id, document_id, uploader_person_id, owner_type, owner_id,
           folder_category, document_folder_id, folder_subcategory, year,
           display_name, uploaded_by_type, folder_section)
        VALUES (NEW.firm_id, NEW.id, NEW.uploaded_by_id, NEW.owner_type, NEW.owner_id,
                NEW.folder_category, NEW.document_folder_id, COALESCE(NEW.folder_subcategory, ''),
                COALESCE(NEW.year, ''), COALESCE(NEW.display_name, 'Document'),
                NEW.uploaded_by_type, NEW.folder_section)
        ON CONFLICT (firm_id, document_id) DO NOTHING;
      END IF;
      RETURN NEW;
    END;
    $document_notification_outbox$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS documents_notification_outbox_trigger ON documents;
    CREATE TRIGGER documents_notification_outbox_trigger
      AFTER INSERT ON documents
      FOR EACH ROW EXECUTE FUNCTION enqueue_document_upload_notification();

    -- ===================== SECURE MESSAGING =====================
    CREATE TABLE IF NOT EXISTS message_threads (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      subject TEXT DEFAULT '',
      status TEXT DEFAULT 'open' CHECK(status IN ('open','waiting','resolved')),
      category TEXT DEFAULT 'general',
      assigned_to INTEGER REFERENCES firm_users(id),
      last_message_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS thread_companies (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      ai_confidence REAL DEFAULT 1.0,
      added_by TEXT DEFAULT 'ai',
      UNIQUE(thread_id, company_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL CHECK(sender_type IN ('staff','client','agent')),
      sender_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      is_internal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS message_attachments (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== BULK SENDS =====================
    CREATE TABLE IF NOT EXISTS bulk_sends (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      subject TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      filter_criteria JSONB NOT NULL DEFAULT '{}',
      recipient_count INTEGER NOT NULL DEFAULT 0 CHECK(recipient_count >= 0),
      sent_by INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bulk_sends_firm_sent
      ON bulk_sends(firm_id, sent_at DESC);

    CREATE TABLE IF NOT EXISTS bulk_send_recipients (
      id SERIAL PRIMARY KEY,
      bulk_send_id INTEGER NOT NULL REFERENCES bulk_sends(id) ON DELETE CASCADE,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      thread_id INTEGER REFERENCES message_threads(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(bulk_send_id, person_id)
    );

    -- Older environments may already have this table from the initial bulk-send
    -- rollout without the timestamp column. Keep startup migrations idempotent.
    ALTER TABLE bulk_send_recipients
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    CREATE INDEX IF NOT EXISTS idx_bulk_send_recipients_person
      ON bulk_send_recipients(person_id, created_at DESC);

    -- Reply-capable email foundation for DarkLion Messages.
    -- Tokens produce branded reply addresses like reply+<token>@messages.yourfirm.com
    -- and map inbound email replies back to immutable message threads without exposing IDs.
    CREATE TABLE IF NOT EXISTS email_reply_tokens (
      id BIGSERIAL PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      purpose TEXT NOT NULL DEFAULT 'message_notification',
      reply_address TEXT NOT NULL,
      expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS email_reply_tokens_thread_active
      ON email_reply_tokens(firm_id, thread_id, person_id, expires_at DESC)
      WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS email_reply_tokens_reply_address
      ON email_reply_tokens(LOWER(reply_address));

    CREATE TABLE IF NOT EXISTS inbound_email_replies (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      email_reply_token_id BIGINT REFERENCES email_reply_tokens(id) ON DELETE SET NULL,
      from_email TEXT NOT NULL DEFAULT '',
      from_name TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      provider_message_id TEXT NOT NULL DEFAULT '',
      raw_headers JSONB NOT NULL DEFAULT '{}',
      matched_status TEXT NOT NULL DEFAULT 'matched' CHECK(matched_status IN ('matched','sender_mismatch','token_expired','token_missing','error')),
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS inbound_email_replies_thread
      ON inbound_email_replies(firm_id, thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS inbound_email_replies_provider_message
      ON inbound_email_replies(provider_message_id) WHERE provider_message_id != '';
    CREATE UNIQUE INDEX IF NOT EXISTS inbound_email_replies_provider_message_unique
      ON inbound_email_replies(provider_message_id) WHERE provider_message_id != '';

    -- ===================== PIPELINES =====================
    CREATE TABLE IF NOT EXISTS pipeline_templates (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      name TEXT NOT NULL DEFAULT '',
      entity_type TEXT NOT NULL DEFAULT 'company' CHECK(entity_type IN ('company','person','relationship')),
      description TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_stages (
      id SERIAL PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES pipeline_templates(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT DEFAULT '#c9a84c',
      is_terminal BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_instances (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      template_id INTEGER REFERENCES pipeline_templates(id),
      name TEXT NOT NULL DEFAULT '',
      tax_year TEXT DEFAULT '',
      status TEXT DEFAULT 'active' CHECK(status IN ('active','archived')),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_jobs (
      id SERIAL PRIMARY KEY,
      instance_id INTEGER NOT NULL REFERENCES pipeline_instances(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL DEFAULT 'company' CHECK(entity_type IN ('company','person','relationship')),
      entity_id INTEGER NOT NULL,
      current_stage_id INTEGER REFERENCES pipeline_stages(id),
      assigned_to INTEGER REFERENCES firm_users(id),
      notes TEXT DEFAULT '',
      priority TEXT DEFAULT 'normal' CHECK(priority IN ('normal','high','urgent')),
      due_date DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pipeline_job_history (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
      from_stage_id INTEGER REFERENCES pipeline_stages(id),
      to_stage_id INTEGER REFERENCES pipeline_stages(id),
      moved_by INTEGER REFERENCES firm_users(id),
      moved_at TIMESTAMPTZ DEFAULT NOW(),
      note TEXT DEFAULT ''
    );

    -- ===================== PIPELINE ENHANCEMENTS =====================

    -- Job status / blocker flags
    DO $$ BEGIN
      ALTER TABLE pipeline_jobs ADD COLUMN IF NOT EXISTS job_status TEXT DEFAULT 'active';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Stage auto-assign on entry
    DO $$ BEGIN
      ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS auto_assign_to INTEGER REFERENCES firm_users(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Stage auto-message on entry
    DO $$ BEGIN
      ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS auto_message TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Team member credentials (e.g. CPA/PFS, CFP)
    DO $$ BEGIN
      ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS credentials TEXT DEFAULT '';
    ALTER TABLE firm_users ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Per-user thread dismissals (Resolve Me)
    CREATE TABLE IF NOT EXISTS thread_dismissals (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      firm_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      dismissed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(thread_id, firm_user_id)
    );

    -- Pipeline template status (active/archived)
    DO $$ BEGIN
      ALTER TABLE pipeline_templates ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Signed PDF document link on tax delivery signers
    DO $$ BEGIN
      ALTER TABLE tax_delivery_signers ADD COLUMN IF NOT EXISTS signed_doc_id INTEGER REFERENCES documents(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TAX RETURN DELIVERIES =====================
    CREATE TABLE IF NOT EXISTS tax_deliveries (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id),
      company_id INTEGER REFERENCES companies(id),
      tax_year TEXT NOT NULL DEFAULT '',
      title TEXT DEFAULT '',
      intro_note TEXT DEFAULT '',
      tax_summary JSONB DEFAULT '{}',
      review_doc_id INTEGER REFERENCES documents(id),
      signature_doc_id INTEGER REFERENCES documents(id),
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','approved','needs_changes','signed','complete')),
      needs_changes_note TEXT DEFAULT '',
      pipeline_job_id INTEGER REFERENCES pipeline_jobs(id),
      created_by INTEGER REFERENCES firm_users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- The fully signed PDF belongs to the delivery (one combined document for all signers).
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS signed_doc_id INTEGER REFERENCES documents(id);

    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS tax_report_data JSONB;
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS tax_report_status TEXT DEFAULT 'none';
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS tax_report_error TEXT;

    -- E-file progress recorded by staff after all signatures are in.
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS filed_at TIMESTAMPTZ;
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
    -- When the return actually went to the client (a draft can sit for days before it is sent).
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
    -- False when a return was marked filed by the one-time launch backfill, so no filing date is shown.
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS filed_date_known BOOLEAN NOT NULL DEFAULT TRUE;
    -- Last staff signature reminder, used to prevent duplicate reminders.
    ALTER TABLE tax_deliveries ADD COLUMN IF NOT EXISTS last_reminded_at TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS pipeline_job_updates (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES firm_users(id),
      body TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS pipeline_jobs_instance_idx
      ON pipeline_jobs(instance_id);
    CREATE INDEX IF NOT EXISTS pipeline_stages_template_position_idx
      ON pipeline_stages(template_id, position, id);
    CREATE INDEX IF NOT EXISTS pipeline_job_updates_job_recent_idx
      ON pipeline_job_updates(job_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS tax_delivery_signers (
      id SERIAL PRIMARY KEY,
      delivery_id INTEGER NOT NULL REFERENCES tax_deliveries(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id),
      approved_at TIMESTAMPTZ,
      approved_ip TEXT DEFAULT '',
      signed_at TIMESTAMPTZ,
      signed_ip TEXT DEFAULT '',
      signature_data TEXT DEFAULT '',
      signature_type TEXT DEFAULT 'drawn' CHECK(signature_type IN ('drawn','typed')),
      needs_changes_at TIMESTAMPTZ,
      needs_changes_note TEXT DEFAULT '',
      signer_role TEXT DEFAULT 'taxpayer',
      UNIQUE(delivery_id, person_id, signer_role)
    );

    -- ===================== MESSAGE TEMPLATES =====================
    CREATE TABLE IF NOT EXISTS message_templates (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES firm_users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== PROPOSALS =====================
    CREATE TABLE IF NOT EXISTS proposals (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id) ON DELETE CASCADE,
      relationship_id INTEGER REFERENCES relationships(id) ON DELETE SET NULL,
      title TEXT NOT NULL DEFAULT 'Service Engagement Proposal',
      client_name TEXT NOT NULL DEFAULT '',
      client_email TEXT NOT NULL DEFAULT '',
      client_phone TEXT DEFAULT '',
      client_address TEXT DEFAULT '',
      client_city_state_zip TEXT DEFAULT '',
      engagement_type TEXT DEFAULT 'tax' CHECK(engagement_type IN ('tax','wealth')),
      tiers JSONB NOT NULL DEFAULT '[]',
      add_ons JSONB DEFAULT '[]',
      backwork JSONB DEFAULT '[]',
      aum_fee_percent NUMERIC(5,2) DEFAULT 0.69,
      require_dual_signature BOOLEAN DEFAULT false,
      notes TEXT DEFAULT '',
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','viewed','accepted','signed')),
      public_token TEXT UNIQUE,
      expires_at TIMESTAMPTZ,
      created_by INTEGER REFERENCES firm_users(id),
      viewed_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proposal_acceptances (
      id SERIAL PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      company_name TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      contact_email TEXT DEFAULT '',
      contact_phone TEXT DEFAULT '',
      address_line1 TEXT DEFAULT '',
      address_line2 TEXT DEFAULT '',
      entity_type TEXT DEFAULT '',
      owners TEXT DEFAULT '',
      additional_notes TEXT DEFAULT '',
      selected_tier_index INTEGER,
      selected_tier_indices JSONB DEFAULT '[]',
      selected_tier_names JSONB DEFAULT '[]',
      accepted_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proposal_engagements (
      id SERIAL PRIMARY KEY,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      firm_id INTEGER REFERENCES firms(id),
      engagement_type TEXT DEFAULT 'tax',
      status TEXT DEFAULT 'pending_signature' CHECK(status IN ('pending_signature','signed')),
      signature_data TEXT DEFAULT '',
      signed_by_name TEXT DEFAULT '',
      signed_at TIMESTAMPTZ,
      signer_ip TEXT DEFAULT '',
      signature2_data TEXT DEFAULT '',
      signed2_by_name TEXT DEFAULT '',
      signed2_at TIMESTAMPTZ,
      signer2_ip TEXT DEFAULT '',
      client_name TEXT DEFAULT '',
      contact_name TEXT DEFAULT '',
      company_name TEXT DEFAULT '',
      contact_email TEXT DEFAULT '',
      address_line1 TEXT DEFAULT '',
      address_line2 TEXT DEFAULT '',
      entity_type TEXT DEFAULT '',
      owners TEXT DEFAULT '',
      monthly_price NUMERIC(10,2) DEFAULT 0,
      selected_tier_index INTEGER,
      selected_tier_indices JSONB DEFAULT '[]',
      tiers JSONB DEFAULT '[]',
      add_ons JSONB DEFAULT '[]',
      backwork JSONB DEFAULT '[]',
      aum_fee_percent NUMERIC(5,2) DEFAULT 0.69,
      require_dual_signature BOOLEAN DEFAULT false,
      saved_to_crm BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- ===================== FIRM CUSTOM DOMAINS =====================
    CREATE TABLE IF NOT EXISTS firm_domains (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      domain TEXT NOT NULL UNIQUE,
      verified_at TIMESTAMPTZ,
      verification_token TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_firm_domains_domain ON firm_domains(domain);

    -- ===================== API TOKENS =====================
    CREATE TABLE IF NOT EXISTS api_tokens (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'API Token',
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL;
    ALTER TABLE api_tokens ADD COLUMN IF NOT EXISTS scopes JSONB DEFAULT '{"agent_work":true,"inbox_read":true,"inbox_drafts":true,"team_chat_read":true,"team_chat_send":true,"documents_read":true,"documents_write":true,"documents_delete":false,"activity_log_read":true,"transactions_read":true,"transactions_write":true,"revenue_read":true,"general_api":true,"summaries_read":true,"crm_read":true,"crm_write":true,"pipelines_read":true,"pipelines_write":true,"staff_read":true,"work_read":true,"messages_send":true,"bookkeeping_read":true,"tax_deliveries_read":true,"organizers_read":true,"proposals_read":true,"billing_read":true,"investments_read":true,"engagements_read":true}'::jsonb;
    ALTER TABLE api_tokens ALTER COLUMN scopes SET DEFAULT '{"agent_work":true,"inbox_read":true,"inbox_drafts":true,"team_chat_read":true,"team_chat_send":true,"documents_read":true,"documents_write":true,"documents_delete":false,"activity_log_read":true,"transactions_read":true,"transactions_write":true,"revenue_read":true,"general_api":true,"summaries_read":true,"crm_read":true,"crm_write":true,"pipelines_read":true,"pipelines_write":true,"staff_read":true,"work_read":true,"messages_send":true,"bookkeeping_read":true,"tax_deliveries_read":true,"organizers_read":true,"proposals_read":true,"billing_read":true,"investments_read":true,"engagements_read":true}'::jsonb;
    UPDATE api_tokens SET scopes = jsonb_set(COALESCE(scopes, '{}'::jsonb), '{documents_write}', 'true'::jsonb, true) WHERE NOT (COALESCE(scopes, '{}'::jsonb) ? 'documents_write');
    UPDATE api_tokens SET scopes = jsonb_set(COALESCE(scopes, '{}'::jsonb), '{documents_delete}', 'false'::jsonb, true) WHERE NOT (COALESCE(scopes, '{}'::jsonb) ? 'documents_delete');
    CREATE INDEX IF NOT EXISTS api_tokens_by_firm ON api_tokens(firm_id);
    CREATE INDEX IF NOT EXISTS api_tokens_by_hash ON api_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS api_tokens_by_staff_user ON api_tokens(staff_user_id);

    -- ===================== VIKTOR SESSIONS =====================
    CREATE TABLE IF NOT EXISTS emma_context (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      context TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by TEXT DEFAULT 'emma',
      UNIQUE(firm_id)
    );

    CREATE TABLE IF NOT EXISTS emma_sessions (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      session_date DATE NOT NULL DEFAULT CURRENT_DATE,
      messages JSONB DEFAULT '[]',
      briefing_generated BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, user_id, session_date)
    );
    CREATE INDEX IF NOT EXISTS emma_sessions_by_firm_user ON emma_sessions(firm_id, user_id, session_date);

    -- ===================== STAFF-OWNED AGENT CONNECTIONS =====================
    CREATE TABLE IF NOT EXISTS agent_connections (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      agent_name TEXT NOT NULL DEFAULT 'My Agent',
      provider TEXT NOT NULL DEFAULT 'webhook',
      endpoint_url TEXT,
      auth_type TEXT NOT NULL DEFAULT 'none',
      auth_secret_encrypted TEXT,
      session_key TEXT,
      status TEXT NOT NULL DEFAULT 'paused' CHECK(status IN ('connected','paused','disabled','error')),
      capabilities JSONB NOT NULL DEFAULT '{"chat":true,"inbox_drafts":true,"activity_log_read":true,"revenue_read":true}',
      preferences_json JSONB NOT NULL DEFAULT '{}',
      callback_token_hash TEXT,
      last_wake_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS agent_connections_by_staff ON agent_connections(firm_id, staff_user_id, status);
    CREATE INDEX IF NOT EXISTS agent_connections_callback_hash ON agent_connections(callback_token_hash);

    CREATE TABLE IF NOT EXISTS message_drafts (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      agent_connection_id INTEGER REFERENCES agent_connections(id) ON DELETE SET NULL,
      draft_body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','edited_sent','discarded','error')),
      confidence REAL,
      agent_notes TEXT,
      source_event TEXT DEFAULT 'inbox.message.received',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS message_drafts_by_thread ON message_drafts(thread_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS message_drafts_by_staff ON message_drafts(firm_id, staff_user_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS emma_draft_jobs (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed','cancelled')),
      priority INTEGER NOT NULL DEFAULT 5,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      research_packet JSONB,
      draft_id INTEGER REFERENCES message_drafts(id) ON DELETE SET NULL,
      requested_by INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      source_event TEXT NOT NULL DEFAULT 'inbox.message.received',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS emma_draft_jobs_queue ON emma_draft_jobs(status, priority, created_at);
    CREATE INDEX IF NOT EXISTS emma_draft_jobs_thread ON emma_draft_jobs(thread_id, created_at DESC);
    ALTER TABLE emma_draft_jobs ADD COLUMN IF NOT EXISTS research_packet JSONB;
    CREATE UNIQUE INDEX IF NOT EXISTS emma_draft_jobs_source_message_unique
      ON emma_draft_jobs(source_message_id)
      WHERE source_message_id IS NOT NULL AND source_event = 'inbox.message.received';

    CREATE TABLE IF NOT EXISTS agent_audit_events (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      agent_connection_id INTEGER REFERENCES agent_connections(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      related_thread_id INTEGER,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS agent_audit_by_firm ON agent_audit_events(firm_id, created_at DESC);

    -- ===================== TELEGRAM TEAM CHAT SPIKE =====================
    -- Retired staff-owned Telegram session table kept for controlled data archival.
    -- Session strings must be encrypted before production use.
    CREATE TABLE IF NOT EXISTS telegram_connections (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      telegram_user_id TEXT,
      telegram_username TEXT,
      telegram_display_name TEXT,
      phone_last4 TEXT,
      session_encrypted TEXT,
      pending_phone_number TEXT,
      pending_phone_code_hash TEXT,
      pending_session_encrypted TEXT,
      primary_bot_peer TEXT NOT NULL DEFAULT 'Telegram',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pending_password','connected','disabled','error')),
      last_sync_at TIMESTAMPTZ,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS telegram_connections_by_staff ON telegram_connections(firm_id, staff_user_id, status);

    -- ===================== TEAM CHAT TELEGRAM FOUNDATION =====================
    -- Production Team Chat tables are intentionally separate from the
    -- Legacy telegram_connections data above is kept for controlled archival; production uses dedicated Team Chat tables.
    -- until the production listener and UI are ready.
    --
    -- Sensitive Telegram session material belongs only in *_encrypted columns.
    CREATE TABLE IF NOT EXISTS team_chat_telegram_connections (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL DEFAULT '',
      telegram_username TEXT NOT NULL DEFAULT '',
      telegram_display_name TEXT NOT NULL DEFAULT '',
      phone_last4 TEXT NOT NULL DEFAULT '',
      session_encrypted TEXT,
      pending_session_encrypted TEXT,
      pending_phone_number_encrypted TEXT,
      pending_phone_code_hash_encrypted TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','pending_password','connected','disabled','error')),
      connection_scope TEXT NOT NULL DEFAULT 'staff_user' CHECK(connection_scope IN ('staff_user','service_account')),
      last_sync_at TIMESTAMPTZ,
      last_error TEXT,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS team_chat_tg_connections_user_unique
      ON team_chat_telegram_connections(firm_id, telegram_user_id)
      WHERE telegram_user_id != '';
    CREATE INDEX IF NOT EXISTS team_chat_tg_connections_staff ON team_chat_telegram_connections(firm_id, staff_user_id, status);
    CREATE INDEX IF NOT EXISTS team_chat_tg_connections_status ON team_chat_telegram_connections(firm_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS team_chat_chats (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE CASCADE,
      telegram_chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL DEFAULT 'unknown' CHECK(chat_type IN ('user','bot','group','supergroup','channel','unknown')),
      title TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      last_message_at TIMESTAMPTZ,
      last_sync_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id, telegram_chat_id)
    );
    ALTER TABLE team_chat_chats ADD COLUMN IF NOT EXISTS staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX IF NOT EXISTS team_chat_chats_staff_unique ON team_chat_chats(firm_id, staff_user_id, telegram_chat_id) WHERE staff_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS team_chat_chats_firm_recent ON team_chat_chats(firm_id, staff_user_id, is_archived, last_message_at DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS team_chat_chats_firm_pinned ON team_chat_chats(firm_id, staff_user_id, is_pinned, updated_at DESC);

    CREATE TABLE IF NOT EXISTS team_chat_memberships (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES team_chat_chats(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL DEFAULT '',
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      display_name TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      member_type TEXT NOT NULL DEFAULT 'unknown' CHECK(member_type IN ('staff','bot','external','unknown')),
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member','readonly','left','banned')),
      joined_at TIMESTAMPTZ,
      left_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, chat_id, telegram_user_id)
    );
    CREATE INDEX IF NOT EXISTS team_chat_memberships_chat ON team_chat_memberships(chat_id, role, display_name);
    CREATE INDEX IF NOT EXISTS team_chat_memberships_staff ON team_chat_memberships(firm_id, staff_user_id, role) WHERE staff_user_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS team_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      chat_id INTEGER NOT NULL REFERENCES team_chat_chats(id) ON DELETE CASCADE,
      telegram_message_id TEXT NOT NULL,
      sender_telegram_user_id TEXT NOT NULL DEFAULT '',
      sender_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      direction TEXT NOT NULL DEFAULT 'inbound' CHECK(direction IN ('inbound','outbound','system')),
      message_kind TEXT NOT NULL DEFAULT 'text' CHECK(message_kind IN ('text','photo','document','audio','video','sticker','system','unknown')),
      text_encrypted TEXT,
      caption_encrypted TEXT,
      media_metadata JSONB NOT NULL DEFAULT '{}',
      sent_at TIMESTAMPTZ,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      raw_update JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, chat_id, telegram_message_id)
    );
    CREATE INDEX IF NOT EXISTS team_chat_messages_chat_recent ON team_chat_messages(chat_id, sent_at DESC NULLS LAST, id DESC);
    CREATE INDEX IF NOT EXISTS team_chat_messages_sender_staff ON team_chat_messages(firm_id, sender_staff_user_id, sent_at DESC) WHERE sender_staff_user_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS team_chat_staff_links (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      telegram_user_id TEXT NOT NULL,
      telegram_username TEXT NOT NULL DEFAULT '',
      telegram_display_name TEXT NOT NULL DEFAULT '',
      link_source TEXT NOT NULL DEFAULT 'manual' CHECK(link_source IN ('manual','connection','membership','import')),
      verified_at TIMESTAMPTZ,
      disabled_at TIMESTAMPTZ,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id, telegram_user_id),
      UNIQUE(firm_id, telegram_user_id)
    );
    CREATE INDEX IF NOT EXISTS team_chat_staff_links_staff ON team_chat_staff_links(firm_id, staff_user_id, disabled_at);

    -- ===================== NATIVE DARKLION TEAM CHAT =====================
    -- Native, firm-scoped staff/team chat. Telegram is no longer the Team Chat backend;
    -- Telegram tables above are retained only for controlled archival/agent connector work.
    CREATE TABLE IF NOT EXISTS native_team_chat_conversations (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      conversation_type TEXT NOT NULL CHECK(conversation_type IN ('dm','group')),
      title TEXT NOT NULL DEFAULT '',
      created_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      compliance_hold BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS native_team_chat_conversations_firm_recent
      ON native_team_chat_conversations(firm_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS native_team_chat_members (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      conversation_id BIGINT NOT NULL REFERENCES native_team_chat_conversations(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      member_role TEXT NOT NULL DEFAULT 'member' CHECK(member_role IN ('owner','admin','member')),
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      left_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, conversation_id, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS native_team_chat_members_staff
      ON native_team_chat_members(firm_id, staff_user_id, left_at);
    CREATE INDEX IF NOT EXISTS native_team_chat_members_conversation
      ON native_team_chat_members(firm_id, conversation_id, left_at);

    CREATE TABLE IF NOT EXISTS native_team_chat_messages (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      conversation_id BIGINT NOT NULL REFERENCES native_team_chat_conversations(id) ON DELETE CASCADE,
      sender_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      message_kind TEXT NOT NULL DEFAULT 'text' CHECK(message_kind IN ('text','system')),
      body_encrypted TEXT,
      immutable_sha256 TEXT NOT NULL DEFAULT '',
      client_nonce TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      retained_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, conversation_id, client_nonce)
    );
    CREATE INDEX IF NOT EXISTS native_team_chat_messages_conversation_recent
      ON native_team_chat_messages(firm_id, conversation_id, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS native_team_chat_messages_sender
      ON native_team_chat_messages(firm_id, sender_staff_user_id, created_at DESC) WHERE sender_staff_user_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS native_team_chat_attachments (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      message_id BIGINT NOT NULL REFERENCES native_team_chat_messages(id) ON DELETE CASCADE,
      storage_key TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      content_type TEXT NOT NULL DEFAULT '',
      byte_size BIGINT,
      sha256 TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS native_team_chat_attachments_message
      ON native_team_chat_attachments(firm_id, message_id);

    DO $$ BEGIN
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS deleted_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS edited_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS original_body_encrypted TEXT;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS edit_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS visible_until TIMESTAMPTZ;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
      ALTER TABLE native_team_chat_messages ADD COLUMN IF NOT EXISTS removed_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL;
      UPDATE native_team_chat_messages
         SET visible_until = created_at + INTERVAL '7 days'
       WHERE visible_until IS NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS native_team_chat_read_state (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      conversation_id BIGINT NOT NULL REFERENCES native_team_chat_conversations(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      last_read_message_id BIGINT REFERENCES native_team_chat_messages(id) ON DELETE SET NULL,
      last_read_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, conversation_id, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS native_team_chat_read_state_staff
      ON native_team_chat_read_state(firm_id, staff_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS native_team_chat_user_state (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      conversation_id BIGINT NOT NULL REFERENCES native_team_chat_conversations(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
      is_archived BOOLEAN NOT NULL DEFAULT FALSE,
      is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, conversation_id, staff_user_id)
    );
    CREATE INDEX IF NOT EXISTS native_team_chat_user_state_staff
      ON native_team_chat_user_state(firm_id, staff_user_id, is_hidden, is_archived, is_pinned, updated_at DESC);

    CREATE TABLE IF NOT EXISTS message_mentions (
      id SERIAL PRIMARY KEY,
      message_id INTEGER NOT NULL,
      firm_user_id INTEGER NOT NULL,
      firm_id INTEGER NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, firm_user_id)
    );

    -- ===================== MESSAGING REBUILD (per-staff threads) =====================

    -- One-time wipe of old test data (only runs if staff_user_id column doesn't exist yet)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='message_threads' AND column_name='staff_user_id') THEN
        DELETE FROM message_mentions;
        DELETE FROM thread_dismissals;
        DELETE FROM thread_companies;
        DELETE FROM messages;
        DELETE FROM message_threads;
      END IF;
    END $$;

    -- Add staff_user_id to message_threads
    ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS staff_user_id INTEGER REFERENCES firm_users(id);
    ALTER TABLE message_threads ADD COLUMN IF NOT EXISTS staff_archived_at TIMESTAMPTZ DEFAULT NULL;

    -- Indexes for fast inbox queries
    CREATE INDEX IF NOT EXISTS idx_msg_threads_staff ON message_threads(staff_user_id, firm_id);
    CREATE INDEX IF NOT EXISTS idx_msg_threads_person ON message_threads(person_id, firm_id);
    CREATE INDEX IF NOT EXISTS idx_msg_threads_staff_active ON message_threads(staff_user_id, firm_id, last_message_at DESC NULLS LAST) WHERE staff_archived_at IS NULL;

    -- Update status constraint to include 'archived'
    DO $$ BEGIN
      ALTER TABLE message_threads DROP CONSTRAINT IF EXISTS message_threads_status_check;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE message_threads ADD CONSTRAINT message_threads_status_check CHECK (status IN ('open', 'resolved', 'archived'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- ===================== CONVERSATION SUMMARIES =====================

    -- is_system_message flag (exclude from summaries)
    DO $$ BEGIN
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_system_message BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- is_emma_draft flag (Emma auto-generated draft replies)
    DO $$ BEGIN
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS is_emma_draft BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- message_type: 'message' (default), 'task' (staff to-do, internal), 'system'
    DO $$ BEGIN
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type TEXT DEFAULT 'message';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TWO-WAY SMS =====================
    -- Provider metadata lets inbound Twilio replies share the existing
    -- Communications threads while remaining idempotent and auditable.
    ALTER TABLE firms ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT DEFAULT '';
    ALTER TABLE people ADD COLUMN IF NOT EXISTS sms_opted_out BOOLEAN DEFAULT FALSE;
    ALTER TABLE people ADD COLUMN IF NOT EXISTS sms_opt_status_updated_at TIMESTAMPTZ;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'portal';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_status TEXT DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_from_phone TEXT DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_to_phone TEXT DEFAULT '';

    CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_message_id_unique
      ON messages(provider_message_id)
      WHERE provider_message_id IS NOT NULL AND provider_message_id <> '';

    CREATE TABLE IF NOT EXISTS twilio_inbound_sms_events (
      id BIGSERIAL PRIMARY KEY,
      provider_message_id TEXT NOT NULL UNIQUE,
      firm_id INTEGER REFERENCES firms(id) ON DELETE SET NULL,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      from_phone TEXT NOT NULL DEFAULT '',
      to_phone TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      opt_out_type TEXT NOT NULL DEFAULT '',
      match_status TEXT NOT NULL DEFAULT 'received'
        CHECK(match_status IN ('received','matched','unmatched','ambiguous','unknown_destination')),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE twilio_inbound_sms_events
      ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_twilio_inbound_sms_events_firm_created
      ON twilio_inbound_sms_events(firm_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sms_thread_routes (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      client_phone TEXT NOT NULL,
      twilio_phone TEXT NOT NULL,
      last_outbound_at TIMESTAMPTZ,
      last_inbound_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, client_phone, twilio_phone)
    );

    CREATE INDEX IF NOT EXISTS idx_sms_thread_routes_thread
      ON sms_thread_routes(firm_id, thread_id);
    CREATE INDEX IF NOT EXISTS idx_sms_thread_routes_person
      ON sms_thread_routes(firm_id, person_id);

    -- Firm-level metric cache: slow-to-compute numbers refreshed by cron
    -- (e.g. mrr, past_due flag). Read by dashboard /intel for instant load.
    CREATE TABLE IF NOT EXISTS firm_metrics (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      metric_key TEXT NOT NULL,
      value JSONB NOT NULL DEFAULT '{}'::jsonb,
      computed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, metric_key)
    );

    -- Conversation summaries table
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL,
      summary_date DATE NOT NULL,
      summary_json JSONB,
      generated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, summary_date)
    );

    -- Track which staff have viewed which day's summary
    CREATE TABLE IF NOT EXISTS summary_views (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL,
      summary_date DATE NOT NULL,
      firm_user_id INTEGER NOT NULL,
      viewed_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, summary_date, firm_user_id)
    );

    -- Thread participants: staff members who have been @mentioned/shared into a thread
    CREATE TABLE IF NOT EXISTS thread_participants (
      id SERIAL PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      firm_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      added_by_id INTEGER REFERENCES firm_users(id),
      firm_id INTEGER NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      archived_at TIMESTAMPTZ DEFAULT NULL,
      UNIQUE(thread_id, firm_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_participants_user ON thread_participants(firm_user_id, firm_id) WHERE archived_at IS NULL;

    -- Audit trail for forwarding a client message thread to another staff owner.
    -- Forwarding is different from sharing: it transfers external-reply ownership.
    CREATE TABLE IF NOT EXISTS message_thread_forwards (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      thread_id INTEGER NOT NULL REFERENCES message_threads(id) ON DELETE CASCADE,
      forwarded_by_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      forwarded_to_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      previous_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_message_thread_forwards_thread ON message_thread_forwards(firm_id, thread_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_message_thread_forwards_to ON message_thread_forwards(firm_id, forwarded_to_id, created_at DESC);
    -- A transfer stays unread for its recipient until they open the thread.
    ALTER TABLE message_thread_forwards ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ DEFAULT NULL;
    CREATE TABLE IF NOT EXISTS one_time_data_updates (
      name TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rows_changed INTEGER NOT NULL DEFAULT 0
    );
    DO $$
    DECLARE changed INTEGER;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM one_time_data_updates WHERE name = 'message_thread_forwards_seen_backfill') THEN
        UPDATE message_thread_forwards SET seen_at = created_at
         WHERE seen_at IS NULL AND created_at < NOW() - INTERVAL '24 hours';
        GET DIAGNOSTICS changed = ROW_COUNT;
        INSERT INTO one_time_data_updates (name, rows_changed) VALUES ('message_thread_forwards_seen_backfill', changed);
      END IF;
    END $$;

    -- ===================== PIPELINE TRIGGERS & ACTIONS =====================

    -- Named trigger types (seed rows)
    CREATE TABLE IF NOT EXISTS pipeline_triggers (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      category TEXT DEFAULT ''
    );
    INSERT INTO pipeline_triggers (key, label, category) VALUES
      ('tax_return_deployed',         'Tax Return Sent to Client',     'tax'),
      ('tax_return_signed',           'Tax Return Signed by Client',   'tax'),
      ('tax_return_approved',         'Tax Return Approved by Staff',  'tax'),
      ('client_requested_changes',    'Client Requested Changes',      'tax'),
      ('engagement_letter_sent',      'Engagement Letter Sent',        'engagement'),
      ('engagement_letter_signed',    'Client Signed Engagement Letter','engagement'),
      ('tax_loe_signed',              'Tax LOE Signed',                'engagement'),
      ('wealth_loe_signed',           'Wealth LOE Signed',             'engagement'),
      ('proposal_sent',               'Proposal Sent',                 'proposals'),
      ('proposal_accepted',           'Proposal Accepted',             'proposals'),
      ('proposal_signed',             'Proposal Signed',               'proposals'),
      ('portal_first_login',          'Client First Portal Login',     'portal'),
      ('portal_message_received',     'Client Sent a Portal Message',  'portal'),
      ('document_uploaded_by_client', 'Client Uploaded a Document',    'portal'),
      ('client_statement_uploaded',   'Client Uploaded a Bank Statement', 'portal')
    ON CONFLICT (key) DO UPDATE SET label = EXCLUDED.label;

    -- Maps trigger keys → pipeline stages (max 2 per stage)
    CREATE TABLE IF NOT EXISTS pipeline_stage_triggers (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      pipeline_instance_id INTEGER NOT NULL REFERENCES pipeline_instances(id),
      stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id),
      trigger_key TEXT NOT NULL REFERENCES pipeline_triggers(key),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (firm_id, pipeline_instance_id, trigger_key)
    );

    -- Audit log for fired triggers
    CREATE TABLE IF NOT EXISTS pipeline_trigger_log (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER,
      trigger_key TEXT,
      person_id INTEGER,
      pipeline_instance_id INTEGER,
      from_stage_id INTEGER,
      to_stage_id INTEGER,
      job_id INTEGER,
      fired_at TIMESTAMPTZ DEFAULT NOW(),
      context JSONB
    );

    -- Actions that fire when a card enters a stage
    CREATE TABLE IF NOT EXISTS pipeline_stage_actions (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      pipeline_instance_id INTEGER NOT NULL REFERENCES pipeline_instances(id),
      stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id),
      action_type TEXT NOT NULL CHECK(action_type IN ('portal_message', 'staff_task')),
      config JSONB DEFAULT '{}',
      position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Pipeline completion history (terminal stage archival)
    CREATE TABLE IF NOT EXISTS pipeline_completions (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      pipeline_instance_id INTEGER NOT NULL REFERENCES pipeline_instances(id),
      stage_id INTEGER NOT NULL REFERENCES pipeline_stages(id),
      job_id INTEGER REFERENCES pipeline_jobs(id),
      entity_type TEXT DEFAULT 'person',
      entity_id INTEGER,
      pipeline_name TEXT,
      tax_year INTEGER,
      completed_at TIMESTAMPTZ DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );

    -- Ensure extra columns for completion records (pipeline_name, tax_year for display/history)
    DO $$ BEGIN
      ALTER TABLE pipeline_completions ADD COLUMN IF NOT EXISTS pipeline_name TEXT;
      ALTER TABLE pipeline_completions ADD COLUMN IF NOT EXISTS tax_year INTEGER;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Tax organizer: custom questions per client (advisor-added)
    DO $$ BEGIN
      ALTER TABLE tax_organizers ADD COLUMN IF NOT EXISTS custom_questions JSONB DEFAULT '[]';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Tax organizer items: flag advisor-added items
    DO $$ BEGIN
      ALTER TABLE tax_organizer_items ADD COLUMN IF NOT EXISTS advisor_added BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- is_terminal flag on pipeline_stages
    DO $$ BEGIN
      ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS is_terminal BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- hold_for_migration: immortal card — don't archive, hold for next year's pipeline
    DO $$ BEGIN
      ALTER TABLE pipeline_stages ADD COLUMN IF NOT EXISTS hold_for_migration BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- default_year on pipeline_templates
    DO $$ BEGIN
      ALTER TABLE pipeline_templates ADD COLUMN IF NOT EXISTS default_year TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Billing method on people and companies
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS billing_method TEXT DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS billing_method TEXT DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== ADDRESS FIELDS (people + companies) =====================
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS address_line1 TEXT DEFAULT '';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS address_line2 TEXT DEFAULT '';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS state TEXT DEFAULT '';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS zip TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line1 TEXT DEFAULT '';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line2 TEXT DEFAULT '';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS city TEXT DEFAULT '';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS state TEXT DEFAULT '';
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS zip TEXT DEFAULT '';
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS annual_revenue NUMERIC(14,2) DEFAULT NULL;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS annual_revenue_synced_at TIMESTAMPTZ DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TAX SEASON LIFECYCLE =====================
    -- active_tax_year: the year currently open for organizer submissions
    DO $$ BEGIN
      ALTER TABLE firms ADD COLUMN IF NOT EXISTS active_tax_year TEXT DEFAULT '2025';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TAX ORGANIZERS =====================
    -- One organizer session per person per tax year
    CREATE TABLE IF NOT EXISTS tax_organizers (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      tax_year TEXT NOT NULL DEFAULT '2025',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','in_progress','submitted','reviewed','closed','reopened')),
      source_document_id INTEGER REFERENCES documents(id), -- the uploaded Drake organizer PDF
      workpaper_document_id INTEGER REFERENCES documents(id), -- the compiled workpaper PDF
      question_answers JSONB DEFAULT '{}',  -- { crypto: false, foreign_accounts: false, ... }
      submitted_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      reopen_note TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id, tax_year)
    );

    -- Expand CHECK constraint to include closed/reopened (if table already exists)
    DO $$ BEGIN
      ALTER TABLE tax_organizers DROP CONSTRAINT IF EXISTS tax_organizers_status_check;
      ALTER TABLE tax_organizers ADD CONSTRAINT tax_organizers_status_check
        CHECK(status IN ('pending','in_progress','submitted','reviewed','closed','reopened'));
    EXCEPTION WHEN others THEN NULL;
    END $$;

    -- Add new columns to existing tax_organizers table (migrations)
    DO $$ BEGIN
      ALTER TABLE tax_organizers ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE tax_organizers ADD COLUMN IF NOT EXISTS reopen_note TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Individual checklist items parsed from the Drake organizer
    CREATE TABLE IF NOT EXISTS tax_organizer_items (
      id SERIAL PRIMARY KEY,
      organizer_id INTEGER NOT NULL REFERENCES tax_organizers(id) ON DELETE CASCADE,
      section TEXT NOT NULL,        -- 'w2', '1099-int', '1099-div', '1099-r', 'k1', 'schedule-c', '1098', 'childcare', 'other'
      payer_name TEXT NOT NULL,
      account_number TEXT DEFAULT '',
      owner TEXT DEFAULT 'joint',   -- 'taxpayer', 'spouse', 'joint'
      prior_year_amount NUMERIC,
      ein TEXT DEFAULT '',
      sentinel_provides BOOLEAN DEFAULT FALSE,  -- custodian or firm-prepared entity
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','uploaded','not_this_year','not_applicable')),
      document_id INTEGER REFERENCES documents(id),  -- the uploaded file
      display_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Expand CHECK constraint to include 'not_applicable'
    DO $$ BEGIN
      ALTER TABLE tax_organizer_items DROP CONSTRAINT IF EXISTS tax_organizer_items_status_check;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE tax_organizer_items ADD CONSTRAINT tax_organizer_items_status_check
        CHECK(status IN ('pending','uploaded','not_this_year','not_applicable'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    -- Add bulk_document_id to tax_organizers (the "dump everything in one PDF" upload)
    DO $$ BEGIN
      ALTER TABLE tax_organizers ADD COLUMN IF NOT EXISTS bulk_document_id INTEGER REFERENCES documents(id);
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TAX SEASON VISIBILITY =====================
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS organizer_visible BOOLEAN DEFAULT FALSE;
      ALTER TABLE people ADD COLUMN IF NOT EXISTS personal_tax_engaged BOOLEAN DEFAULT TRUE;
      ALTER TABLE people ADD COLUMN IF NOT EXISTS occupation TEXT DEFAULT '';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS spouse_phone TEXT DEFAULT '';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS spouse_occupation TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== TAX ORGANIZER V2 PROFILE / QUESTIONNAIRE =====================
    DO $$ BEGIN
      ALTER TABLE tax_organizers ADD COLUMN IF NOT EXISTS profile_snapshot JSONB DEFAULT '{}';
      ALTER TABLE tax_organizers ADD COLUMN IF NOT EXISTS organizer_version TEXT DEFAULT 'v1';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    DO $$ BEGIN
      ALTER TABLE tax_organizer_items ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'prior_year';
      ALTER TABLE tax_organizer_items ADD COLUMN IF NOT EXISTS triggered_by TEXT DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;
    CREATE TABLE IF NOT EXISTS person_dependents (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      relationship TEXT DEFAULT '',
      date_of_birth TEXT DEFAULT '',
      ssn_last4 TEXT DEFAULT '',
      ssn_on_file BOOLEAN DEFAULT FALSE,
      school_childcare TEXT DEFAULT '',
      active BOOLEAN DEFAULT TRUE,
      display_order INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS person_dependents_person_idx ON person_dependents(person_id, active, display_order);
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS blueleaf_hidden_accounts JSONB DEFAULT '[]';
      ALTER TABLE people ADD COLUMN IF NOT EXISTS blueleaf_migration_config JSONB DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- ===================== BLUELEAF / FINANCIAL PLANNING =====================
    DO $$ BEGIN
      ALTER TABLE people ADD COLUMN IF NOT EXISTS financial_planning_enabled BOOLEAN DEFAULT FALSE;
      ALTER TABLE people ADD COLUMN IF NOT EXISTS blueleaf_household_id TEXT DEFAULT NULL;
      ALTER TABLE people ADD COLUMN IF NOT EXISTS bkq_last_notified_at TIMESTAMPTZ DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE firms ADD COLUMN IF NOT EXISTS blueleaf_api_token TEXT DEFAULT NULL;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS blueleaf_snapshots (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      blueleaf_household_id TEXT NOT NULL,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      performance JSONB NOT NULL DEFAULT '{}',
      accounts JSONB NOT NULL DEFAULT '[]',
      raw_balance NUMERIC,
      synced_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(person_id, snapshot_date)
    );

    -- ===================== AUTO-BOOKKEEPER =====================
    -- Vendor mapping — self-learning vendor → GL account mapping
    -- direction: 'expense' (money out) or 'income' (money in)
    -- min_amount/max_amount: typical transaction range for this vendor (±20% guard)
    CREATE TABLE IF NOT EXISTS vendor_mapping (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      realm_id TEXT NOT NULL,
      vendor_name TEXT NOT NULL,
      vendor_name_normalized TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL DEFAULT 'expense'
        CHECK(direction IN ('expense','income')),
      account_name TEXT NOT NULL,
      account_id TEXT DEFAULT '',
      source TEXT DEFAULT 'auto-learned'
        CHECK(source IN ('auto-learned','manual','ai-research')),
      confidence INTEGER DEFAULT 0,
      usage_count INTEGER DEFAULT 0,
      min_amount NUMERIC(14,2) DEFAULT NULL,
      max_amount NUMERIC(14,2) DEFAULT NULL,
      last_used_at TIMESTAMPTZ,
      notes TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(realm_id, vendor_name, direction)
    );

    -- Migration: add amount range columns if table already exists
    DO $$ BEGIN
      ALTER TABLE vendor_mapping ADD COLUMN IF NOT EXISTS min_amount NUMERIC(14,2) DEFAULT NULL;
      ALTER TABLE vendor_mapping ADD COLUMN IF NOT EXISTS max_amount NUMERIC(14,2) DEFAULT NULL;
    EXCEPTION WHEN others THEN NULL;
    END $$;

    -- Migration: add direction column if table already exists
    DO $$ BEGIN
      ALTER TABLE vendor_mapping ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'expense';
      ALTER TABLE vendor_mapping DROP CONSTRAINT IF EXISTS vendor_mapping_realm_id_vendor_name_key;
      ALTER TABLE vendor_mapping ADD CONSTRAINT vendor_mapping_realm_id_vendor_name_direction_key
        UNIQUE(realm_id, vendor_name, direction);
    EXCEPTION WHEN others THEN NULL;
    END $$;

    -- Bookkeeper run log — one row per company per nightly run
    CREATE TABLE IF NOT EXISTS bookkeeper_runs (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      realm_id TEXT NOT NULL,
      run_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status TEXT DEFAULT 'running'
        CHECK(status IN ('running','completed','failed')),
      txns_found INTEGER DEFAULT 0,
      txns_auto_coded INTEGER DEFAULT 0,
      txns_ai_coded INTEGER DEFAULT 0,
      txns_manual_review INTEGER DEFAULT 0,
      txns_failed INTEGER DEFAULT 0,
      new_mappings_created INTEGER DEFAULT 0,
      error_message TEXT,
      started_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    -- Daily uncoded transaction report — transactions that need manager review
    CREATE TABLE IF NOT EXISTS bookkeeper_uncoded (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id),
      realm_id TEXT NOT NULL,
      company_name TEXT DEFAULT '',
      report_date DATE NOT NULL DEFAULT CURRENT_DATE,
      run_id INTEGER,
      txn_qb_id TEXT NOT NULL,
      txn_type TEXT DEFAULT 'Purchase',
      txn_date TEXT,
      vendor_name TEXT DEFAULT '',
      amount REAL DEFAULT 0,
      description TEXT DEFAULT '',
      original_account TEXT DEFAULT '',
      ai_suggested_account TEXT DEFAULT '',
      ai_confidence INTEGER DEFAULT 0,
      ai_reasoning TEXT DEFAULT '',
      status TEXT DEFAULT 'pending'
        CHECK(status IN ('pending','coded','skipped')),
      coded_account TEXT DEFAULT '',
      coded_account_id TEXT DEFAULT '',
      coded_at TIMESTAMPTZ,
      coded_by INTEGER,
      save_mapping BOOLEAN DEFAULT TRUE
    );

    -- Bookkeeper indexes
    CREATE INDEX IF NOT EXISTS idx_vm_realm_vendor ON vendor_mapping(realm_id, vendor_name_normalized);
    CREATE INDEX IF NOT EXISTS idx_bu_firm_status ON bookkeeper_uncoded(firm_id, status);
    CREATE INDEX IF NOT EXISTS idx_bu_firm_date ON bookkeeper_uncoded(firm_id, report_date);

    -- Per-company auto-bookkeeper toggle
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_bookkeeper_enabled BOOLEAN DEFAULT FALSE;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Archive support for companies
    DO $$ BEGIN
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Client coding columns on bookkeeper_uncoded
    DO $$ BEGIN
      ALTER TABLE bookkeeper_uncoded ADD COLUMN IF NOT EXISTS sent_to_client BOOLEAN DEFAULT FALSE;
      ALTER TABLE bookkeeper_uncoded ADD COLUMN IF NOT EXISTS sent_to_client_at TIMESTAMPTZ;
      ALTER TABLE bookkeeper_uncoded ADD COLUMN IF NOT EXISTS coded_by_client BOOLEAN DEFAULT FALSE;
      ALTER TABLE bookkeeper_uncoded ADD COLUMN IF NOT EXISTS coded_by_client_at TIMESTAMPTZ;
      ALTER TABLE bookkeeper_uncoded ADD COLUMN IF NOT EXISTS coded_by_client_account TEXT DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS idx_bu_sent_to_client ON bookkeeper_uncoded(firm_id, sent_to_client) WHERE sent_to_client = TRUE;

    -- Alter transactions table for bookkeeper tracking
    DO $$ BEGIN
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS firm_id INTEGER;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bookkeeper_run_id INTEGER;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS coded_by TEXT DEFAULT '';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS coded_account TEXT DEFAULT '';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS coded_at TIMESTAMPTZ;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS doc_number TEXT DEFAULT '';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS memo TEXT DEFAULT '';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qbo_txn_type TEXT DEFAULT '';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS qbo_raw JSONB;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Agent transaction search indexes (vendor/amount/date per company)
    CREATE INDEX IF NOT EXISTS idx_transactions_agent_company_amount ON transactions(firm_id, realm_id, ABS(amount));
    CREATE INDEX IF NOT EXISTS idx_transactions_agent_company_date ON transactions(firm_id, realm_id, date);
    CREATE INDEX IF NOT EXISTS idx_transactions_agent_company_vendor ON transactions(firm_id, realm_id, LOWER(vendor_name));
    CREATE INDEX IF NOT EXISTS idx_transactions_agent_company_doc_number ON transactions(firm_id, realm_id, LOWER(doc_number));
    CREATE INDEX IF NOT EXISTS idx_bu_agent_company_amount ON bookkeeper_uncoded(firm_id, realm_id, ABS(amount));
    CREATE INDEX IF NOT EXISTS idx_bu_agent_company_date ON bookkeeper_uncoded(firm_id, realm_id, txn_date);
    CREATE INDEX IF NOT EXISTS idx_bu_agent_company_vendor ON bookkeeper_uncoded(firm_id, realm_id, LOWER(vendor_name));

    -- ===================== MOBILE PORTAL FOUNDATION =====================
    CREATE TABLE IF NOT EXISTS portal_mobile_devices (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      push_token TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown' CHECK(platform IN ('ios','android','web','unknown')),
      device_id TEXT DEFAULT '',
      app_version TEXT DEFAULT '',
      device_model TEXT DEFAULT '',
      os_version TEXT DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      disabled_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, person_id, push_token)
    );

    CREATE INDEX IF NOT EXISTS idx_portal_mobile_devices_person
      ON portal_mobile_devices(firm_id, person_id)
      WHERE disabled_at IS NULL;

    CREATE TABLE IF NOT EXISTS portal_mobile_notification_preferences (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      messages_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      documents_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      tasks_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      tax_delivery_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      marketing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      quiet_hours JSONB NOT NULL DEFAULT '{}',
      timezone TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, person_id)
    );

    -- ===================== STAFF MOBILE NOTIFICATIONS =====================
    CREATE TABLE IF NOT EXISTS staff_mobile_devices (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      push_token TEXT NOT NULL,
      platform TEXT NOT NULL DEFAULT 'unknown' CHECK(platform IN ('ios','android','web','unknown')),
      device_id TEXT DEFAULT '',
      app_version TEXT DEFAULT '',
      device_model TEXT DEFAULT '',
      os_version TEXT DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}',
      disabled_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id, push_token)
    );

    CREATE INDEX IF NOT EXISTS idx_staff_mobile_devices_user
      ON staff_mobile_devices(firm_id, staff_user_id)
      WHERE disabled_at IS NULL;

    CREATE TABLE IF NOT EXISTS staff_mobile_notification_preferences (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      staff_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      client_messages_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      team_chat_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      tasks_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      marketing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      quiet_hours JSONB NOT NULL DEFAULT '{}',
      timezone TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, staff_user_id)
    );


    -- ===================== COMMUNICATIONS COMPLIANCE ARCHIVE =====================
    -- Operational index/receipt tables for the immutable WORM communications archive.
    -- Retained archive objects remain the source of record; receipts describe actual provider retention.
    CREATE TABLE IF NOT EXISTS communication_archive_events (
      id BIGSERIAL PRIMARY KEY,
      event_id UUID NOT NULL UNIQUE,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      communication_scope TEXT NOT NULL DEFAULT 'client',
      channel TEXT NOT NULL DEFAULT 'portal',
      conversation_type TEXT NOT NULL DEFAULT '',
      conversation_source_id TEXT NOT NULL DEFAULT '',
      message_source_id TEXT NOT NULL DEFAULT '',
      occurred_at TIMESTAMPTZ NOT NULL,
      content_sha256 TEXT NOT NULL DEFAULT '',
      archive_bucket TEXT NOT NULL DEFAULT '',
      archive_object_key TEXT NOT NULL DEFAULT '',
      archive_version_id TEXT,
      retain_until TIMESTAMPTZ,
      object_lock_mode TEXT NOT NULL DEFAULT 'NONE',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','archived','failed')),
      error_text TEXT,
      payload_json JSONB NOT NULL DEFAULT '{}',
      requested_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_comm_archive_events_firm_occurred
      ON communication_archive_events(firm_id, occurred_at DESC, event_id DESC);
    CREATE INDEX IF NOT EXISTS idx_comm_archive_events_firm_status
      ON communication_archive_events(firm_id, status, occurred_at DESC);

    CREATE TABLE IF NOT EXISTS communication_archive_outbox (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      event_id UUID NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','archived','failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firm_id, source_key)
    );
    CREATE INDEX IF NOT EXISTS idx_comm_archive_outbox_pending
      ON communication_archive_outbox(status, next_attempt_at ASC);

    CREATE TABLE IF NOT EXISTS communication_archive_exports (
      id BIGSERIAL PRIMARY KEY,
      export_id UUID NOT NULL UNIQUE,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      requested_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      inclusive_start_at TIMESTAMPTZ NOT NULL,
      exclusive_end_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      event_count INTEGER NOT NULL DEFAULT 0,
      exception_count INTEGER NOT NULL DEFAULT 0,
      archive_bucket TEXT NOT NULL DEFAULT '',
      archive_prefix TEXT NOT NULL DEFAULT '',
      manifest_object_key TEXT NOT NULL DEFAULT '',
      manifest_version_id TEXT,
      root_hash TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      request_json JSONB NOT NULL DEFAULT '{}',
      verification_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_comm_archive_exports_firm_created
      ON communication_archive_exports(firm_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS communication_archive_access_events (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      export_id UUID,
      staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      detail JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_comm_archive_access_firm_created
      ON communication_archive_access_events(firm_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS communication_archive_holds (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      hold_name TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      target_type TEXT NOT NULL DEFAULT 'firm' CHECK(target_type IN ('firm','conversation','message','export','object')),
      target_id TEXT NOT NULL DEFAULT '',
      created_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL,
      released_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS communication_archive_reconciliation_runs (
      id BIGSERIAL PRIMARY KEY,
      firm_id INTEGER REFERENCES firms(id) ON DELETE CASCADE,
      run_type TEXT NOT NULL DEFAULT 'daily',
      status TEXT NOT NULL DEFAULT 'pending',
      source_count INTEGER NOT NULL DEFAULT 0,
      archived_count INTEGER NOT NULL DEFAULT 0,
      exception_count INTEGER NOT NULL DEFAULT 0,
      report_object_key TEXT NOT NULL DEFAULT '',
      report_version_id TEXT,
      detail_json JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Soft-removal columns for client messages (no physical deletes for compliance).
    DO $$ BEGIN
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_at TIMESTAMPTZ;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS removed_by_staff_user_id INTEGER REFERENCES firm_users(id) ON DELETE SET NULL;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS removal_reason TEXT NOT NULL DEFAULT '';
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- Migrate category_rules → vendor_mapping (if category_rules exists)
    DO $$ BEGIN
      INSERT INTO vendor_mapping (firm_id, realm_id, vendor_name, vendor_name_normalized, account_name, source, confidence)
        SELECT 1, realm_id, vendor_name, LOWER(TRIM(vendor_name)), category, 'manual', 100
        FROM category_rules
        ON CONFLICT DO NOTHING;
    EXCEPTION WHEN undefined_table THEN NULL;
    END $$;

    -- One-time, at the launch of filed/accepted tracking: returns already fully signed were filed
    -- outside DarkLion. Mark them filed without a date. The marker row keeps this from ever running again,
    -- so returns signed after launch rely on staff marking them e-filed.
    CREATE TABLE IF NOT EXISTS one_time_data_updates (
      name TEXT PRIMARY KEY,
      ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      rows_changed INTEGER NOT NULL DEFAULT 0
    );
    DO $$
    DECLARE changed INTEGER;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM one_time_data_updates WHERE name = 'tax_deliveries_filed_launch_backfill') THEN
        UPDATE tax_deliveries td
           SET filed_at = COALESCE((SELECT MAX(s.signed_at) FROM tax_delivery_signers s WHERE s.delivery_id = td.id), td.updated_at, NOW()),
               filed_date_known = FALSE
         WHERE td.status IN ('signed', 'complete') AND td.filed_at IS NULL;
        GET DIAGNOSTICS changed = ROW_COUNT;
        INSERT INTO one_time_data_updates (name, rows_changed) VALUES ('tax_deliveries_filed_launch_backfill', changed);
      END IF;
    END $$;
  `);
  // Previously created lazily inside GET handlers, which fails under read-only
  // support sessions. Definitions match routes/engagement.js and routes/relationships.js.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relationship_team (
      relationship_id INTEGER NOT NULL,
      firm_user_id INTEGER NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (relationship_id, firm_user_id)
    );
    -- Clients can message every active staff member by default. The firm owner
    -- can hide specific staff from a specific client; one row per hidden pair.
    CREATE TABLE IF NOT EXISTS client_staff_hidden (
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      firm_user_id INTEGER NOT NULL REFERENCES firm_users(id) ON DELETE CASCADE,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (person_id, firm_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_client_staff_hidden_firm ON client_staff_hidden(firm_id, person_id);
    CREATE TABLE IF NOT EXISTS engagement_letters (
      id SERIAL PRIMARY KEY,
      firm_id INTEGER NOT NULL,
      relationship_id INTEGER NOT NULL REFERENCES relationships(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL DEFAULT '',
      s3_key TEXT NOT NULL,
      s3_bucket TEXT NOT NULL,
      mime_type TEXT DEFAULT 'application/pdf',
      size_bytes INTEGER,
      status TEXT NOT NULL DEFAULT 'active',
      extracted_data JSONB,
      extracted_at TIMESTAMPTZ,
      retired_at TIMESTAMPTZ,
      retired_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      created_by INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_engagement_letters_rel ON engagement_letters(relationship_id);
    CREATE INDEX IF NOT EXISTS idx_engagement_letters_firm ON engagement_letters(firm_id);
  `);
  await require('./services/publicOfferSchema').initializePublicOffer(pool);
  await require('./services/loginIdentitySchema').initializeLoginIdentities(pool);
  await require('./services/adminSchema').initializeAdmin(pool);
}

module.exports = { pool, initDB };
