'use strict';

// Reserve normalized login identities across client, spouse, staff, and owner
// records. Changing or deleting a role does not silently transfer its identity
// to another firm; a firm transfer requires an explicit administrative migration.
async function initializeLoginIdentities(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS login_identity_firms (
      email TEXT PRIMARY KEY,
      firm_id INTEGER NOT NULL REFERENCES firms(id) ON DELETE CASCADE
    );

    CREATE OR REPLACE FUNCTION claim_login_identity(address TEXT, owner_firm INTEGER)
    RETURNS VOID LANGUAGE plpgsql AS $$
    DECLARE normalized TEXT := LOWER(TRIM(address)); claimed INTEGER;
    BEGIN
      IF normalized IS NULL OR normalized = '' OR owner_firm IS NULL THEN RETURN; END IF;
      INSERT INTO login_identity_firms(email, firm_id) VALUES (normalized, owner_firm)
      ON CONFLICT (email) DO UPDATE SET firm_id = login_identity_firms.firm_id
        WHERE login_identity_firms.firm_id = EXCLUDED.firm_id
      RETURNING firm_id INTO claimed;
      IF claimed IS NULL THEN
        RAISE EXCEPTION 'This email already belongs to another firm'
          USING ERRCODE = '23505', CONSTRAINT = 'login_identity_single_firm';
      END IF;
    END $$;

    LOCK TABLE firms, firm_users, people IN SHARE ROW EXCLUSIVE MODE;

    -- Refuse conflicting legacy records without choosing a firm or changing data.
    DO $$
    DECLARE identity RECORD;
    BEGIN
      FOR identity IN
        SELECT LOWER(TRIM(email)) AS email, id AS firm_id FROM firms
        UNION
        SELECT LOWER(TRIM(email)), firm_id FROM firm_users
        UNION
        SELECT LOWER(TRIM(email)), firm_id FROM people
        UNION
        SELECT LOWER(TRIM(spouse_email)), firm_id FROM people
      LOOP
        PERFORM claim_login_identity(identity.email, identity.firm_id);
      END LOOP;
    END $$;

    CREATE OR REPLACE FUNCTION enforce_login_identity_firm()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_TABLE_NAME = 'firms' THEN
        PERFORM claim_login_identity(NEW.email, NEW.id);
      ELSE
        PERFORM claim_login_identity(NEW.email, NEW.firm_id);
        IF TG_TABLE_NAME = 'people' THEN
          PERFORM claim_login_identity(NEW.spouse_email, NEW.firm_id);
        END IF;
      END IF;
      RETURN NEW;
    END $$;

    CREATE OR REPLACE TRIGGER firm_login_identity
      AFTER INSERT OR UPDATE OF email ON firms
      FOR EACH ROW EXECUTE FUNCTION enforce_login_identity_firm();
    CREATE OR REPLACE TRIGGER staff_login_identity
      AFTER INSERT OR UPDATE OF email, firm_id ON firm_users
      FOR EACH ROW EXECUTE FUNCTION enforce_login_identity_firm();
    CREATE OR REPLACE TRIGGER client_login_identity
      AFTER INSERT OR UPDATE OF email, spouse_email, firm_id ON people
      FOR EACH ROW EXECUTE FUNCTION enforce_login_identity_firm();
  `);
}

module.exports = { initializeLoginIdentities };
