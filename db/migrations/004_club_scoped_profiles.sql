ALTER TABLE members ADD COLUMN IF NOT EXISTS display_name text;

DO $$
BEGIN
  IF to_regclass('public.current_member_profiles') IS NOT NULL THEN
    EXECUTE $sql$
      UPDATE members m
         SET display_name = COALESCE(m.display_name, cmp.display_name, m.public_name)
        FROM current_member_profiles cmp
       WHERE cmp.member_id = m.id
         AND m.display_name IS NULL
    $sql$;
  END IF;
END
$$;

UPDATE members
   SET display_name = COALESCE(display_name, public_name)
 WHERE display_name IS NULL;

ALTER TABLE members ALTER COLUMN display_name SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'members_display_name_check'
  ) THEN
    ALTER TABLE members
      ADD CONSTRAINT members_display_name_check CHECK (length(btrim(display_name)) > 0);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS member_club_profile_versions (
    id                      short_id DEFAULT new_id() NOT NULL,
    member_id               short_id NOT NULL,
    club_id                 short_id NOT NULL,
    version_no              integer NOT NULL,
    tagline                 text,
    summary                 text,
    what_i_do               text,
    known_for               text,
    services_summary        text,
    website_url             text,
    links                   jsonb DEFAULT '[]' NOT NULL,
    profile                 jsonb DEFAULT '{}' NOT NULL,
    search_vector           tsvector,
    created_at              timestamptz DEFAULT now() NOT NULL,
    created_by_member_id    short_id,
    generation_source       text DEFAULT 'manual' NOT NULL,

    CONSTRAINT member_club_profile_versions_pkey PRIMARY KEY (id),
    CONSTRAINT member_club_profile_versions_member_club_version_unique UNIQUE (member_id, club_id, version_no),
    CONSTRAINT member_club_profile_versions_version_no_check CHECK (version_no > 0),
    CONSTRAINT member_club_profile_versions_generation_source_check
        CHECK (generation_source IN ('manual', 'migration_backfill', 'admission_generated', 'membership_seed')),
    CONSTRAINT member_club_profile_versions_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_club_profile_versions_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT member_club_profile_versions_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS member_club_profile_versions_member_club_idx
    ON member_club_profile_versions (member_id, club_id, version_no DESC);
CREATE INDEX IF NOT EXISTS member_club_profile_versions_club_member_idx
    ON member_club_profile_versions (club_id, member_id, version_no DESC);
CREATE INDEX IF NOT EXISTS member_club_profile_versions_search_idx
    ON member_club_profile_versions USING gin (search_vector);

CREATE OR REPLACE FUNCTION member_club_profile_versions_search_vector_trigger() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    NEW.search_vector := to_tsvector('english',
        coalesce(NEW.tagline, '') || ' ' ||
        coalesce(NEW.summary, '') || ' ' ||
        coalesce(NEW.what_i_do, '') || ' ' ||
        coalesce(NEW.known_for, '') || ' ' ||
        coalesce(NEW.services_summary, '')
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_club_profile_versions_search_vector_update ON member_club_profile_versions;
CREATE TRIGGER member_club_profile_versions_search_vector_update
    BEFORE INSERT OR UPDATE ON member_club_profile_versions
    FOR EACH ROW
    EXECUTE FUNCTION member_club_profile_versions_search_vector_trigger();

CREATE OR REPLACE VIEW current_member_club_profiles AS
    SELECT DISTINCT ON (member_id, club_id) *
    FROM member_club_profile_versions
    ORDER BY member_id, club_id, version_no DESC, created_at DESC;

DO $$
BEGIN
  IF to_regclass('public.current_member_profiles') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO member_club_profile_versions (
        member_id, club_id, version_no,
        tagline, summary, what_i_do, known_for, services_summary,
        website_url, links, profile,
        created_by_member_id, generation_source
      )
      SELECT
        cm.member_id, cm.club_id, 1,
        cmp.tagline, cmp.summary, cmp.what_i_do, cmp.known_for, cmp.services_summary,
        cmp.website_url, cmp.links, cmp.profile,
        cm.member_id, 'migration_backfill'
      FROM club_memberships cm
      LEFT JOIN current_member_profiles cmp ON cmp.member_id = cm.member_id
      WHERE cm.left_at IS NULL
      ON CONFLICT (member_id, club_id, version_no) DO NOTHING
    $sql$;
  END IF;
END
$$;

DROP TABLE IF EXISTS member_profile_embeddings;

CREATE TABLE member_profile_embeddings (
    id                  short_id DEFAULT new_id() NOT NULL,
    member_id           short_id NOT NULL,
    club_id             short_id NOT NULL,
    profile_version_id  short_id NOT NULL,
    model               text NOT NULL,
    dimensions          integer NOT NULL,
    source_version      text NOT NULL,
    chunk_index         integer NOT NULL DEFAULT 0,
    source_text         text NOT NULL,
    source_hash         text NOT NULL,
    embedding           vector(1536) NOT NULL,
    metadata            jsonb NOT NULL DEFAULT '{}',
    created_at          timestamptz DEFAULT now() NOT NULL,
    updated_at          timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT member_profile_embeddings_pkey PRIMARY KEY (id),
    CONSTRAINT member_profile_embeddings_unique UNIQUE (member_id, club_id, model, dimensions, source_version, chunk_index),
    CONSTRAINT member_profile_embeddings_dimensions_check CHECK (dimensions > 0),
    CONSTRAINT member_profile_embeddings_member_fkey FOREIGN KEY (member_id) REFERENCES members(id),
    CONSTRAINT member_profile_embeddings_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT member_profile_embeddings_version_fkey FOREIGN KEY (profile_version_id) REFERENCES member_club_profile_versions(id) ON DELETE CASCADE
);

CREATE INDEX member_profile_embeddings_member_idx ON member_profile_embeddings (member_id);
CREATE INDEX member_profile_embeddings_version_idx ON member_profile_embeddings (profile_version_id);
CREATE INDEX member_profile_embeddings_club_member_idx ON member_profile_embeddings (club_id, member_id);

DELETE FROM ai_embedding_jobs WHERE subject_kind = 'member_profile_version';

ALTER TABLE ai_embedding_jobs DROP CONSTRAINT IF EXISTS ai_embedding_jobs_subject_kind_check;
ALTER TABLE ai_embedding_jobs ADD CONSTRAINT ai_embedding_jobs_subject_kind_check
    CHECK (subject_kind IN ('member_club_profile_version', 'entity_version'));

INSERT INTO ai_embedding_jobs (subject_kind, subject_version_id, model, dimensions, source_version)
SELECT 'member_club_profile_version', mcpv.id, 'text-embedding-3-small', 1536, 'v1'
FROM current_member_club_profiles mcpv
ON CONFLICT DO NOTHING;
