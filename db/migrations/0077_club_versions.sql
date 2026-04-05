-- Replace club_owner_versions with club_versions: full snapshots of all mutable
-- club fields per version, enabling audit trails for name/summary/policy changes
-- alongside ownership changes.

-- 1. Create club_versions table -------------------------------------------

CREATE TABLE app.club_versions (
    id                    app.short_id DEFAULT app.new_id() NOT NULL,
    club_id               app.short_id NOT NULL,
    owner_member_id       app.short_id NOT NULL,
    name                  text NOT NULL,
    summary               text,
    publicly_listed       boolean NOT NULL,
    admission_policy      text,
    version_no            integer NOT NULL,
    supersedes_version_id app.short_id,
    created_at            timestamptz DEFAULT now() NOT NULL,
    created_by_member_id  app.short_id,

    CONSTRAINT club_versions_pkey PRIMARY KEY (id),
    CONSTRAINT club_versions_club_version_unique UNIQUE (club_id, version_no),
    CONSTRAINT club_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT club_versions_name_check CHECK (length(btrim(name)) > 0),
    CONSTRAINT club_versions_admission_policy_length CHECK (
        admission_policy IS NULL OR char_length(admission_policy) BETWEEN 1 AND 2000
    ),

    CONSTRAINT club_versions_club_id_fkey
        FOREIGN KEY (club_id) REFERENCES app.clubs(id),
    CONSTRAINT club_versions_owner_member_id_fkey
        FOREIGN KEY (owner_member_id) REFERENCES app.members(id),
    CONSTRAINT club_versions_created_by_member_id_fkey
        FOREIGN KEY (created_by_member_id) REFERENCES app.members(id),
    CONSTRAINT club_versions_supersedes_version_id_fkey
        FOREIGN KEY (supersedes_version_id) REFERENCES app.club_versions(id)
);

CREATE INDEX club_versions_club_idx
    ON app.club_versions USING btree (club_id, version_no DESC, created_at DESC);

-- Normalize admission_policy on club_versions (mirrors clubs trigger from 0068)
CREATE OR REPLACE FUNCTION app.normalize_club_versions_admission_policy() RETURNS trigger
    LANGUAGE plpgsql
AS $$
begin
  if new.admission_policy is not null then
    new.admission_policy := btrim(new.admission_policy);
    if new.admission_policy = '' then
      new.admission_policy := null;
    end if;
  end if;
  return new;
end;
$$;

CREATE TRIGGER club_versions_normalize_admission_policy
    BEFORE INSERT OR UPDATE OF admission_policy ON app.club_versions
    FOR EACH ROW EXECUTE FUNCTION app.normalize_club_versions_admission_policy();

-- 2. RLS + policies -------------------------------------------------------

ALTER TABLE ONLY app.club_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE app.club_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY club_versions_insert_superadmin ON app.club_versions
    FOR INSERT WITH CHECK (
        app.current_actor_is_superadmin()
        AND (created_by_member_id)::text = (app.current_actor_member_id())::text
    );

CREATE POLICY club_versions_select_actor_scope ON app.club_versions
    FOR SELECT USING (
        app.current_actor_is_superadmin() OR app.actor_has_club_access(club_id)
    );

GRANT SELECT ON TABLE app.club_versions TO clawclub_view_owner;
GRANT SELECT ON TABLE app.club_versions TO clawclub_security_definer_owner;

-- 3. current_club_versions view -------------------------------------------

CREATE VIEW app.current_club_versions AS
    SELECT DISTINCT ON (club_id) *
    FROM app.club_versions
    ORDER BY club_id, version_no DESC, created_at DESC;

ALTER TABLE app.current_club_versions OWNER TO clawclub_view_owner;
GRANT SELECT ON TABLE app.current_club_versions TO clawclub_security_definer_owner;

-- 4. Data migration -------------------------------------------------------

INSERT INTO app.club_versions (
    id, club_id, owner_member_id, name, summary,
    publicly_listed, admission_policy, version_no,
    supersedes_version_id, created_at, created_by_member_id
)
SELECT
    cov.id,
    cov.club_id,
    cov.owner_member_id,
    c.name,
    c.summary,
    c.publicly_listed,
    c.admission_policy,
    cov.version_no,
    cov.supersedes_owner_version_id,
    cov.created_at,
    cov.created_by_member_id
FROM app.club_owner_versions cov
JOIN app.clubs c ON c.id = cov.club_id;

-- 5. New sync trigger: club_versions → clubs ------------------------------

CREATE OR REPLACE FUNCTION app.sync_club_version_compatibility_state() RETURNS trigger
    LANGUAGE plpgsql
AS $$
begin
  perform set_config('app.allow_club_version_sync', '1', true);
  update app.clubs c set
    owner_member_id = new.owner_member_id,
    name            = new.name,
    summary         = new.summary,
    publicly_listed = new.publicly_listed,
    admission_policy = new.admission_policy
  where c.id = new.club_id;
  perform set_config('app.allow_club_version_sync', '', true);
  return new;
exception
  when others then
    perform set_config('app.allow_club_version_sync', '', true);
    raise;
end;
$$;

CREATE TRIGGER club_versions_sync
    AFTER INSERT ON app.club_versions
    FOR EACH ROW EXECUTE FUNCTION app.sync_club_version_compatibility_state();

-- 6. New lock trigger: prevent direct mutation of versioned fields ---------

CREATE OR REPLACE FUNCTION app.lock_club_versioned_mutation() RETURNS trigger
    LANGUAGE plpgsql
AS $$
begin
  if tg_op <> 'UPDATE' then return new; end if;
  if coalesce(current_setting('app.allow_club_version_sync', true), '') = '1' then
    return new;
  end if;
  if new.owner_member_id is distinct from old.owner_member_id then
    raise exception 'clubs.owner_member_id must change via club_versions';
  end if;
  if new.name is distinct from old.name then
    raise exception 'clubs.name must change via club_versions';
  end if;
  if new.summary is distinct from old.summary then
    raise exception 'clubs.summary must change via club_versions';
  end if;
  if new.publicly_listed is distinct from old.publicly_listed then
    raise exception 'clubs.publicly_listed must change via club_versions';
  end if;
  if new.admission_policy is distinct from old.admission_policy then
    raise exception 'clubs.admission_policy must change via club_versions';
  end if;
  return new;
end;
$$;

DROP TRIGGER IF EXISTS clubs_owner_member_lock ON app.clubs;
CREATE TRIGGER clubs_versioned_field_lock
    BEFORE UPDATE ON app.clubs
    FOR EACH ROW EXECUTE FUNCTION app.lock_club_versioned_mutation();

-- 7. Function grants (mirrors old lock_club_owner_mutation / sync grants) --

GRANT ALL ON FUNCTION app.sync_club_version_compatibility_state() TO clawclub_view_owner;
GRANT ALL ON FUNCTION app.sync_club_version_compatibility_state() TO clawclub_security_definer_owner;
GRANT ALL ON FUNCTION app.sync_club_version_compatibility_state() TO clawclub_cold_application_owner;
GRANT ALL ON FUNCTION app.lock_club_versioned_mutation() TO clawclub_view_owner;
GRANT ALL ON FUNCTION app.lock_club_versioned_mutation() TO clawclub_security_definer_owner;
GRANT ALL ON FUNCTION app.lock_club_versioned_mutation() TO clawclub_cold_application_owner;
GRANT ALL ON FUNCTION app.normalize_club_versions_admission_policy() TO clawclub_view_owner;
GRANT ALL ON FUNCTION app.normalize_club_versions_admission_policy() TO clawclub_security_definer_owner;
GRANT ALL ON FUNCTION app.normalize_club_versions_admission_policy() TO clawclub_cold_application_owner;

-- 8. Drop old infrastructure ----------------------------------------------

DROP TRIGGER IF EXISTS club_owner_versions_sync ON app.club_owner_versions;
DROP VIEW IF EXISTS app.current_club_owners;
DROP POLICY IF EXISTS club_owner_versions_insert_superadmin ON app.club_owner_versions;
DROP POLICY IF EXISTS club_owner_versions_select_actor_scope ON app.club_owner_versions;
DROP TABLE IF EXISTS app.club_owner_versions;
DROP FUNCTION IF EXISTS app.sync_club_owner_compatibility_state();
DROP FUNCTION IF EXISTS app.lock_club_owner_mutation();
