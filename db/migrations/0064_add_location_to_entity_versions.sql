-- Add location column to entity_versions for event location tracking.

ALTER TABLE app.entity_versions ADD COLUMN location text;

-- The view chain is: entity_versions -> current_entity_versions
--   -> current_published_entity_versions -> live_entities.
-- All three views explicitly enumerate columns, so we must recreate them
-- in reverse-dependency order to propagate the new column.

-- Drop in reverse order (live_entities depends on current_published_entity_versions
-- depends on current_entity_versions).
DROP VIEW IF EXISTS app.live_entities;
DROP VIEW IF EXISTS app.current_published_entity_versions;
DROP VIEW IF EXISTS app.current_entity_versions;

CREATE VIEW app.current_entity_versions AS
SELECT DISTINCT ON (entity_versions.entity_id)
    entity_versions.id,
    entity_versions.entity_id,
    entity_versions.version_no,
    entity_versions.state,
    entity_versions.title,
    entity_versions.summary,
    entity_versions.body,
    entity_versions.location,
    entity_versions.work_mode,
    entity_versions.compensation,
    entity_versions.starts_at,
    entity_versions.ends_at,
    entity_versions.timezone,
    entity_versions.recurrence_rule,
    entity_versions.capacity,
    entity_versions.effective_at,
    entity_versions.expires_at,
    entity_versions.content,
    entity_versions.source_dm_thread_id,
    entity_versions.source_dm_message_id,
    entity_versions.supersedes_version_id,
    entity_versions.created_at,
    entity_versions.created_by_member_id
   FROM app.entity_versions
  ORDER BY entity_versions.entity_id, entity_versions.version_no DESC, entity_versions.created_at DESC;

CREATE VIEW app.current_published_entity_versions AS
SELECT
    current_entity_versions.id,
    current_entity_versions.entity_id,
    current_entity_versions.version_no,
    current_entity_versions.state,
    current_entity_versions.title,
    current_entity_versions.summary,
    current_entity_versions.body,
    current_entity_versions.location,
    current_entity_versions.work_mode,
    current_entity_versions.compensation,
    current_entity_versions.starts_at,
    current_entity_versions.ends_at,
    current_entity_versions.timezone,
    current_entity_versions.recurrence_rule,
    current_entity_versions.capacity,
    current_entity_versions.effective_at,
    current_entity_versions.expires_at,
    current_entity_versions.content,
    current_entity_versions.source_dm_thread_id,
    current_entity_versions.source_dm_message_id,
    current_entity_versions.supersedes_version_id,
    current_entity_versions.created_at,
    current_entity_versions.created_by_member_id
   FROM app.current_entity_versions
  WHERE current_entity_versions.state = 'published'::app.entity_state;

CREATE VIEW app.live_entities AS
SELECT e.id AS entity_id,
    e.club_id,
    e.kind,
    e.author_member_id,
    e.parent_entity_id,
    e.created_at AS entity_created_at,
    cev.id AS entity_version_id,
    cev.version_no,
    cev.state,
    cev.title,
    cev.summary,
    cev.body,
    cev.location,
    cev.work_mode,
    cev.compensation,
    cev.starts_at,
    cev.ends_at,
    cev.timezone,
    cev.recurrence_rule,
    cev.capacity,
    cev.effective_at,
    cev.expires_at,
    cev.content,
    cev.created_at AS version_created_at,
    cev.created_by_member_id
   FROM app.entities e
   JOIN app.current_published_entity_versions cev ON cev.entity_id = e.id
  WHERE e.archived_at IS NULL AND e.deleted_at IS NULL;

-- Restore view ownership and grants dropped with the old views.
ALTER TABLE app.current_entity_versions OWNER TO clawclub_view_owner;
ALTER TABLE app.current_published_entity_versions OWNER TO clawclub_view_owner;
ALTER TABLE app.live_entities OWNER TO clawclub_view_owner;

GRANT SELECT ON TABLE app.current_entity_versions TO clawclub_security_definer_owner;
GRANT SELECT ON TABLE app.current_published_entity_versions TO clawclub_security_definer_owner;
GRANT SELECT ON TABLE app.live_entities TO clawclub_security_definer_owner;
