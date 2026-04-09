-- Migration: add gift entities and persisted open-loop state

ALTER TYPE entity_kind ADD VALUE IF NOT EXISTS 'gift';

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS open_loop boolean;

UPDATE entities
SET open_loop = true
WHERE kind IN ('ask', 'gift', 'service', 'opportunity')
  AND open_loop IS DISTINCT FROM true;

UPDATE entities
SET open_loop = null
WHERE kind NOT IN ('ask', 'gift', 'service', 'opportunity')
  AND open_loop IS NOT NULL;

ALTER TABLE entities
  DROP CONSTRAINT IF EXISTS entities_open_loop_kind_check;

ALTER TABLE entities
  ADD CONSTRAINT entities_open_loop_kind_check CHECK (
    (
      kind IN ('ask', 'gift', 'service', 'opportunity')
      AND open_loop IS NOT NULL
    )
    OR (
      kind NOT IN ('ask', 'gift', 'service', 'opportunity')
      AND open_loop IS NULL
    )
  );

DROP VIEW IF EXISTS live_events;
DROP VIEW IF EXISTS live_entities;

CREATE VIEW live_entities AS
    SELECT
        e.id                AS entity_id,
        e.club_id,
        e.kind,
        e.open_loop,
        e.author_member_id,
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

CREATE VIEW live_events AS
    SELECT le.*, evd.location, evd.starts_at, evd.ends_at,
           evd.timezone, evd.recurrence_rule, evd.capacity
    FROM live_entities le
    JOIN event_version_details evd ON evd.entity_version_id = le.entity_version_id
    WHERE le.kind = 'event';
