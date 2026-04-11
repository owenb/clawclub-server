ALTER TYPE rsvp_state ADD VALUE IF NOT EXISTS 'cancelled';

DROP VIEW IF EXISTS live_events;
DROP VIEW IF EXISTS current_event_versions;
DROP VIEW IF EXISTS current_event_rsvps;
DROP VIEW IF EXISTS live_entities;
DROP VIEW IF EXISTS published_entity_versions;
DROP VIEW IF EXISTS current_entity_versions;

DO $$
DECLARE
  enum_labels text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'entity_kind'
      AND e.enumlabel = 'comment'
  ) THEN
    IF EXISTS (
      SELECT 1
      FROM entities
      WHERE kind::text <> 'comment'
        AND parent_entity_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Migration aborted: found non-comment entities with parent_entity_id set';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM entities e
      JOIN entities p ON p.id = e.parent_entity_id
      WHERE e.club_id <> p.club_id
    ) THEN
      RAISE EXCEPTION 'Migration aborted: found cross-club parent_entity_id links';
    END IF;

    IF EXISTS (
      WITH RECURSIVE walk AS (
        SELECT e.id AS start_id, e.parent_entity_id, ARRAY[e.id] AS path
        FROM entities e
        WHERE e.parent_entity_id IS NOT NULL
        UNION ALL
        SELECT walk.start_id, p.parent_entity_id, walk.path || p.id
        FROM walk
        JOIN entities p ON p.id = walk.parent_entity_id
        WHERE walk.parent_entity_id IS NOT NULL
          AND NOT p.id = ANY(walk.path)
      )
      SELECT 1
      FROM walk
      JOIN entities p ON p.id = walk.parent_entity_id
      WHERE p.id = ANY(walk.path)
      LIMIT 1
    ) THEN
      RAISE EXCEPTION 'Migration aborted: found cyclic comment parent chains';
    END IF;

    UPDATE entities
       SET kind = 'post'
     WHERE kind = 'comment';

    IF EXISTS (SELECT 1 FROM entities WHERE kind::text = 'comment') THEN
      RAISE EXCEPTION 'Migration aborted: comment entities remain after conversion';
    END IF;

    SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
      INTO enum_labels
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'entity_kind'
       AND e.enumlabel <> 'comment';

    IF enum_labels IS NULL THEN
      RAISE EXCEPTION 'Migration aborted: could not derive replacement entity_kind enum labels';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_type
      WHERE typname = 'entity_kind_new'
    ) THEN
      EXECUTE 'DROP TYPE entity_kind_new';
    END IF;

    EXECUTE format('CREATE TYPE entity_kind_new AS ENUM (%s)', enum_labels);

    -- Drop CHECK constraints that reference entity_kind enum literals before swapping
    EXECUTE 'ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_open_loop_kind_check';
    EXECUTE 'ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_comment_parent_check';

    EXECUTE 'ALTER TABLE entities ALTER COLUMN kind TYPE entity_kind_new USING kind::text::entity_kind_new';
    EXECUTE 'DROP TYPE entity_kind';
    EXECUTE 'ALTER TYPE entity_kind_new RENAME TO entity_kind';

    -- Re-add the open_loop constraint with the new enum type
    EXECUTE '
      ALTER TABLE entities ADD CONSTRAINT entities_open_loop_kind_check CHECK (
        (
          kind IN (''ask'', ''gift'', ''service'', ''opportunity'')
          AND open_loop IS NOT NULL
        )
        OR (
          kind NOT IN (''ask'', ''gift'', ''service'', ''opportunity'')
          AND open_loop IS NULL
        )
      )';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS content_threads (
    id                      short_id DEFAULT new_id() NOT NULL,
    club_id                 short_id NOT NULL,
    created_by_member_id    short_id NOT NULL,
    last_activity_at        timestamptz DEFAULT now() NOT NULL,
    created_at              timestamptz DEFAULT now() NOT NULL,
    archived_at             timestamptz,

    CONSTRAINT content_threads_pkey PRIMARY KEY (id),
    CONSTRAINT content_threads_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT content_threads_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES members(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS content_threads_id_club_idx ON content_threads (id, club_id);
CREATE INDEX IF NOT EXISTS content_threads_club_activity_idx
    ON content_threads (club_id, last_activity_at DESC, id DESC)
    WHERE archived_at IS NULL;

ALTER TABLE entities ADD COLUMN IF NOT EXISTS content_thread_id short_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM entities WHERE content_thread_id IS NULL LIMIT 1) THEN
    CREATE TEMP TABLE thread_root_map (
      root_entity_id short_id PRIMARY KEY,
      thread_id short_id NOT NULL,
      club_id short_id NOT NULL
    ) ON COMMIT DROP;

    CREATE TEMP TABLE entity_thread_roots (
      entity_id short_id PRIMARY KEY,
      root_entity_id short_id NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO entity_thread_roots (entity_id, root_entity_id)
    WITH RECURSIVE ancestry AS (
      SELECT e.id AS entity_id, e.id AS ancestor_id, e.parent_entity_id, 0 AS depth
      FROM entities e
      WHERE e.content_thread_id IS NULL
      UNION ALL
      SELECT ancestry.entity_id, p.id AS ancestor_id, p.parent_entity_id, ancestry.depth + 1
      FROM ancestry
      JOIN entities p ON p.id = ancestry.parent_entity_id
    ),
    roots AS (
      SELECT DISTINCT ON (entity_id)
             entity_id,
             ancestor_id AS root_entity_id
      FROM ancestry
      ORDER BY entity_id, depth DESC, ancestor_id
    )
    SELECT entity_id, root_entity_id
    FROM roots;

    INSERT INTO thread_root_map (root_entity_id, thread_id, club_id)
    SELECT r.root_entity_id, new_id(), e.club_id
    FROM (SELECT DISTINCT root_entity_id FROM entity_thread_roots) r
    JOIN entities e ON e.id = r.root_entity_id;

    INSERT INTO content_threads (id, club_id, created_by_member_id, created_at, last_activity_at)
    SELECT
      trm.thread_id,
      root.club_id,
      root.author_member_id,
      root.created_at,
      GREATEST(root.created_at, COALESCE(max(member_entity.created_at), root.created_at))
    FROM thread_root_map trm
    JOIN entities root ON root.id = trm.root_entity_id
    LEFT JOIN entity_thread_roots etr ON etr.root_entity_id = trm.root_entity_id
    LEFT JOIN entities member_entity ON member_entity.id = etr.entity_id
    GROUP BY trm.thread_id, root.club_id, root.author_member_id, root.created_at;

    UPDATE entities e
       SET content_thread_id = trm.thread_id
      FROM entity_thread_roots etr
      JOIN thread_root_map trm ON trm.root_entity_id = etr.root_entity_id
     WHERE e.id = etr.entity_id
       AND e.content_thread_id IS NULL;

    CREATE TEMP TABLE orphan_thread_map (
      entity_id short_id PRIMARY KEY,
      thread_id short_id NOT NULL,
      club_id short_id NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO orphan_thread_map (entity_id, thread_id, club_id)
    SELECT e.id, new_id(), e.club_id
    FROM entities e
    WHERE e.content_thread_id IS NULL;

    INSERT INTO content_threads (id, club_id, created_by_member_id, created_at, last_activity_at)
    SELECT otm.thread_id, e.club_id, e.author_member_id, e.created_at, e.created_at
    FROM orphan_thread_map otm
    JOIN entities e ON e.id = otm.entity_id;

    UPDATE entities e
       SET content_thread_id = otm.thread_id
      FROM orphan_thread_map otm
     WHERE e.id = otm.entity_id
       AND e.content_thread_id IS NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM entities WHERE content_thread_id IS NULL LIMIT 1) THEN
    RAISE EXCEPTION 'Migration aborted: content_thread_id backfill left null rows behind';
  END IF;
END
$$;

ALTER TABLE entities ALTER COLUMN content_thread_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'entities_content_thread_same_club_fkey'
  ) THEN
    ALTER TABLE entities
      ADD CONSTRAINT entities_content_thread_same_club_fkey
      FOREIGN KEY (content_thread_id, club_id)
      REFERENCES content_threads (id, club_id);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS entities_thread_created_idx
    ON entities (content_thread_id, created_at ASC, id ASC)
    WHERE archived_at IS NULL AND deleted_at IS NULL;

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_comment_parent_check;

DO $$
DECLARE
  snapshot_global_content integer;
  snapshot_global_event integer;
BEGIN
  CREATE TEMP TABLE quota_snapshot ON COMMIT DROP AS
  SELECT scope, club_id, action_name, max_per_day
  FROM quota_policies
  WHERE action_name IN ('content.create', 'events.create');

  IF EXISTS (SELECT 1 FROM quota_snapshot WHERE action_name = 'events.create') THEN
    SELECT max_per_day
      INTO snapshot_global_content
      FROM quota_snapshot
     WHERE scope = 'global'
       AND action_name = 'content.create';

    SELECT max_per_day
      INTO snapshot_global_event
      FROM quota_snapshot
     WHERE scope = 'global'
       AND action_name = 'events.create';

    IF snapshot_global_content IS NULL OR snapshot_global_event IS NULL THEN
      RAISE EXCEPTION 'Migration aborted: quota snapshot missing required global rows for content.create/events.create';
    END IF;

    UPDATE quota_policies qp
       SET max_per_day = merged.max_per_day,
           updated_at = now()
      FROM (
        SELECT content.club_id,
               content.max_per_day + event.max_per_day AS max_per_day
        FROM quota_snapshot content
        JOIN quota_snapshot event
          ON event.scope = 'club'
         AND content.scope = 'club'
         AND event.club_id = content.club_id
         AND content.action_name = 'content.create'
         AND event.action_name = 'events.create'
      ) merged
     WHERE qp.scope = 'club'
       AND qp.action_name = 'content.create'
       AND qp.club_id = merged.club_id;

    INSERT INTO quota_policies (scope, club_id, action_name, max_per_day)
    SELECT 'club', event.club_id, 'content.create', snapshot_global_content + event.max_per_day
    FROM quota_snapshot event
    WHERE event.scope = 'club'
      AND event.action_name = 'events.create'
      AND NOT EXISTS (
        SELECT 1
        FROM quota_snapshot content
        WHERE content.scope = 'club'
          AND content.action_name = 'content.create'
          AND content.club_id = event.club_id
      );

    UPDATE quota_policies qp
       SET max_per_day = content.max_per_day + snapshot_global_event,
           updated_at = now()
      FROM quota_snapshot content
     WHERE qp.scope = 'club'
       AND qp.action_name = 'content.create'
       AND content.scope = 'club'
       AND content.action_name = 'content.create'
       AND qp.club_id = content.club_id
       AND NOT EXISTS (
         SELECT 1
         FROM quota_snapshot event
         WHERE event.scope = 'club'
           AND event.action_name = 'events.create'
           AND event.club_id = content.club_id
       );

    UPDATE quota_policies
       SET max_per_day = snapshot_global_content + snapshot_global_event,
           updated_at = now()
     WHERE scope = 'global'
       AND action_name = 'content.create';

    DELETE FROM quota_policies
     WHERE action_name = 'events.create';
  END IF;
END
$$;

ALTER TABLE quota_policies DROP CONSTRAINT IF EXISTS quota_policies_action_check;
ALTER TABLE quota_policies
  ADD CONSTRAINT quota_policies_action_check CHECK (action_name IN ('content.create'));

CREATE VIEW current_entity_versions AS
    SELECT DISTINCT ON (entity_id) *
    FROM entity_versions
    ORDER BY entity_id, version_no DESC, created_at DESC;

CREATE VIEW published_entity_versions AS
    SELECT * FROM current_entity_versions WHERE state = 'published';

CREATE VIEW current_event_rsvps AS
    SELECT DISTINCT ON (event_entity_id, membership_id) *
    FROM event_rsvps
    ORDER BY event_entity_id, membership_id, version_no DESC, created_at DESC;

CREATE VIEW live_entities AS
    SELECT
        e.id                AS entity_id,
        e.club_id,
        e.kind,
        e.open_loop,
        e.author_member_id,
        e.content_thread_id,
        e.parent_entity_id,
        e.created_at        AS entity_created_at,
        pev.id              AS entity_version_id,
        pev.version_no,
        pev.state,
        pev.title,
        pev.summary,
        pev.body,
        pev.effective_at,
        pev.expires_at,
        pev.content,
        pev.created_at      AS version_created_at,
        pev.created_by_member_id
    FROM entities e
    JOIN published_entity_versions pev ON pev.entity_id = e.id
    WHERE e.archived_at IS NULL
      AND e.deleted_at IS NULL
      AND (pev.expires_at IS NULL OR pev.expires_at > now());

CREATE VIEW current_event_versions AS
    SELECT cev.*, evd.location, evd.starts_at, evd.ends_at,
           evd.timezone, evd.recurrence_rule, evd.capacity
    FROM current_entity_versions cev
    JOIN event_version_details evd ON evd.entity_version_id = cev.id;

CREATE VIEW live_events AS
    SELECT le.*, evd.location, evd.starts_at, evd.ends_at,
           evd.timezone, evd.recurrence_rule, evd.capacity
    FROM live_entities le
    JOIN event_version_details evd ON evd.entity_version_id = le.entity_version_id
    WHERE le.kind = 'event';
