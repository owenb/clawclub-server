-- Rename transcript_threads/transcript_messages → dm_threads/dm_messages.
-- Replace transcript_thread_kind enum with dm_thread_kind (conversation, complaint, support, billing).
-- Rename transcript_role → dm_role.
-- Rename transcript_message_id columns across all tables.
-- Add app.redactions table for immutable redaction log.
-- Filter redacted content from pending_member_updates view.

-- ── Phase 1: Drop dependent views ──────────────────────────────────────────────

DROP VIEW IF EXISTS app.current_dm_inbox_threads;
DROP VIEW IF EXISTS app.current_dm_thread_participants;
DROP VIEW IF EXISTS app.pending_member_updates;

-- ── Phase 2: Drop RLS policies on transcript tables ────────────────────────────

DROP POLICY IF EXISTS transcript_messages_insert_thread_scope ON app.transcript_messages;
DROP POLICY IF EXISTS transcript_messages_select_superadmin ON app.transcript_messages;
DROP POLICY IF EXISTS transcript_messages_select_thread_scope ON app.transcript_messages;
DROP POLICY IF EXISTS transcript_threads_insert_participant_scope ON app.transcript_threads;
DROP POLICY IF EXISTS transcript_threads_select_participant_scope ON app.transcript_threads;
DROP POLICY IF EXISTS transcript_threads_select_superadmin ON app.transcript_threads;

-- ── Phase 3: Rename tables ─────────────────────────────────────────────────────

ALTER TABLE app.transcript_threads RENAME TO dm_threads;
ALTER TABLE app.transcript_messages RENAME TO dm_messages;

-- ── Phase 4: Drop indexes that reference old enum before type change ───────────

DROP INDEX IF EXISTS app.transcript_threads_live_dm_pair_unique_idx;
DROP INDEX IF EXISTS app.transcript_threads_club_kind_idx;

-- ── Phase 5: Enum changes ──────────────────────────────────────────────────────

-- 5a: Create new dm_thread_kind enum and convert the column
CREATE TYPE app.dm_thread_kind AS ENUM ('conversation', 'complaint', 'support', 'billing');

ALTER TABLE app.dm_threads
  ALTER COLUMN kind DROP DEFAULT,
  ALTER COLUMN kind TYPE app.dm_thread_kind
    USING 'conversation'::app.dm_thread_kind;

DROP TYPE app.transcript_thread_kind;

-- 4b: Rename transcript_role → dm_role
ALTER TYPE app.transcript_role RENAME TO dm_role;

-- ── Phase 5: Rename columns on referencing tables ──────────────────────────────

-- member_updates
ALTER TABLE app.member_updates RENAME COLUMN transcript_message_id TO dm_message_id;

-- Drop and recreate the CHECK constraint that references the old column name
ALTER TABLE app.member_updates DROP CONSTRAINT member_updates_check;
ALTER TABLE app.member_updates ADD CONSTRAINT member_updates_check
  CHECK (dm_message_id IS NOT NULL
    OR (entity_id IS NOT NULL AND entity_version_id IS NOT NULL)
    OR payload <> '{}'::jsonb);

-- embeddings
ALTER TABLE app.embeddings RENAME COLUMN transcript_message_id TO dm_message_id;

ALTER TABLE app.embeddings DROP CONSTRAINT embeddings_check;
ALTER TABLE app.embeddings ADD CONSTRAINT embeddings_check
  CHECK ((
    (member_profile_version_id IS NOT NULL)::integer
    + (entity_version_id IS NOT NULL)::integer
    + (dm_message_id IS NOT NULL)::integer
  ) = 1);

-- entity_versions
ALTER TABLE app.entity_versions RENAME COLUMN source_transcript_thread_id TO source_dm_thread_id;
ALTER TABLE app.entity_versions RENAME COLUMN source_transcript_message_id TO source_dm_message_id;

-- admission_versions (was application_versions)
ALTER TABLE app.admission_versions RENAME COLUMN source_transcript_thread_id TO source_dm_thread_id;
ALTER TABLE app.admission_versions RENAME COLUMN source_transcript_message_id TO source_dm_message_id;

-- edges
ALTER TABLE app.edges RENAME COLUMN source_transcript_message_id TO source_dm_message_id;

-- event_rsvps
ALTER TABLE app.event_rsvps RENAME COLUMN source_transcript_message_id TO source_dm_message_id;

-- member_profile_versions
ALTER TABLE app.member_profile_versions RENAME COLUMN source_transcript_thread_id TO source_dm_thread_id;
ALTER TABLE app.member_profile_versions RENAME COLUMN source_transcript_message_id TO source_dm_message_id;

-- club_membership_state_versions
ALTER TABLE app.club_membership_state_versions RENAME COLUMN source_transcript_thread_id TO source_dm_thread_id;
ALTER TABLE app.club_membership_state_versions RENAME COLUMN source_transcript_message_id TO source_dm_message_id;

-- ── Phase 6: Rename indexes on renamed tables ──────────────────────────────────

ALTER INDEX app.transcript_messages_pkey RENAME TO dm_messages_pkey;
ALTER INDEX app.transcript_threads_pkey RENAME TO dm_threads_pkey;
ALTER INDEX app.transcript_messages_sender_idx RENAME TO dm_messages_sender_idx;
ALTER INDEX app.transcript_messages_thread_created_desc_idx RENAME TO dm_messages_thread_created_desc_idx;
ALTER INDEX app.transcript_messages_thread_created_idx RENAME TO dm_messages_thread_created_idx;
ALTER INDEX app.transcript_threads_subject_idx RENAME TO dm_threads_subject_idx;

-- Recreate indexes with new enum value (were dropped in Phase 4)
CREATE INDEX dm_threads_club_kind_idx ON app.dm_threads USING btree (club_id, kind, created_at DESC);
CREATE UNIQUE INDEX dm_threads_live_pair_unique_idx ON app.dm_threads
  USING btree (
    club_id,
    LEAST(created_by_member_id::text, counterpart_member_id::text),
    GREATEST(created_by_member_id::text, counterpart_member_id::text)
  )
  WHERE kind = 'conversation'::app.dm_thread_kind
    AND archived_at IS NULL
    AND created_by_member_id IS NOT NULL
    AND counterpart_member_id IS NOT NULL;

-- ── Phase 8: Replace actor_can_access_thread function ──────────────────────────

CREATE OR REPLACE FUNCTION app.actor_can_access_thread(target_thread_id app.short_id) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'app', 'pg_temp'
AS $$
  select exists (
    select 1 from app.dm_threads tt
    where tt.id = target_thread_id
      and tt.archived_at is null
      and app.actor_has_club_access(tt.club_id)
      and app.current_actor_member_id() in (tt.created_by_member_id, tt.counterpart_member_id)
  )
$$;

-- ── Phase 9: Replace count_member_writes_today function ────────────────────────
-- It references transcript_messages/transcript_threads for the messages.send quota.

CREATE OR REPLACE FUNCTION app.count_member_writes_today(
  target_member_id app.short_id,
  target_club_id app.short_id,
  target_action text
) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'app', 'pg_temp'
AS $$
  select case target_action
    when 'entities.create' then (select count(*)::int from app.entities e where e.author_member_id = target_member_id and e.club_id = target_club_id and e.kind != 'event' and e.created_at >= current_date)
    when 'events.create' then (select count(*)::int from app.entities e where e.author_member_id = target_member_id and e.club_id = target_club_id and e.kind = 'event' and e.created_at >= current_date)
    when 'messages.send' then (select count(*)::int from app.dm_messages tm join app.dm_threads tt on tt.id = tm.thread_id where tm.sender_member_id = target_member_id and tt.club_id = target_club_id and tm.created_at >= current_date)
    else 0
  end
$$;

-- ── Phase 10: Create redactions table ──────────────────────────────────────────

CREATE TABLE app.redactions (
  id app.short_id DEFAULT app.new_id() NOT NULL,
  club_id app.short_id NOT NULL,
  target_kind text NOT NULL,
  target_id app.short_id NOT NULL,
  reason text,
  created_by_member_id app.short_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT redactions_pkey PRIMARY KEY (id),
  CONSTRAINT redactions_club_id_fkey FOREIGN KEY (club_id) REFERENCES app.clubs(id),
  CONSTRAINT redactions_created_by_member_id_fkey FOREIGN KEY (created_by_member_id) REFERENCES app.members(id),
  CONSTRAINT redactions_target_kind_check CHECK (target_kind IN ('dm_message', 'entity')),
  CONSTRAINT redactions_unique_target UNIQUE (target_kind, target_id)
);

ALTER TABLE ONLY app.redactions FORCE ROW LEVEL SECURITY;

-- ── Phase 11: Recreate views ───────────────────────────────────────────────────

-- pending_member_updates: now filters redacted content
CREATE VIEW app.pending_member_updates AS
 SELECT mu.id AS update_id,
    mu.stream_seq,
    mu.recipient_member_id,
    mu.club_id,
    mu.topic,
    mu.payload,
    mu.entity_id,
    mu.entity_version_id,
    mu.dm_message_id,
    mu.created_by_member_id,
    mu.created_at
   FROM app.member_updates mu
   LEFT JOIN app.current_member_update_receipts cmur
     ON cmur.member_update_id = mu.id
    AND cmur.recipient_member_id = mu.recipient_member_id
   LEFT JOIN app.redactions r_msg
     ON r_msg.target_kind = 'dm_message'
    AND r_msg.target_id = mu.dm_message_id
   LEFT JOIN app.redactions r_entity
     ON r_entity.target_kind = 'entity'
    AND r_entity.target_id = mu.entity_id
  WHERE cmur.id IS NULL
    AND r_msg.id IS NULL
    AND r_entity.id IS NULL;

-- current_dm_thread_participants
CREATE VIEW app.current_dm_thread_participants AS
 SELECT tt.id AS thread_id,
    tt.club_id,
    tt.created_by_member_id AS participant_member_id,
    tt.counterpart_member_id
   FROM app.dm_threads tt
  WHERE tt.kind = 'conversation'::app.dm_thread_kind
    AND tt.archived_at IS NULL
    AND tt.created_by_member_id IS NOT NULL
    AND tt.counterpart_member_id IS NOT NULL
UNION ALL
 SELECT tt.id AS thread_id,
    tt.club_id,
    tt.counterpart_member_id AS participant_member_id,
    tt.created_by_member_id AS counterpart_member_id
   FROM app.dm_threads tt
  WHERE tt.kind = 'conversation'::app.dm_thread_kind
    AND tt.archived_at IS NULL
    AND tt.created_by_member_id IS NOT NULL
    AND tt.counterpart_member_id IS NOT NULL;

-- current_dm_inbox_threads
CREATE VIEW app.current_dm_inbox_threads AS
 WITH thread_messages AS (
   SELECT tt.id AS thread_id,
      tt.club_id,
      participant.recipient_member_id,
      CASE
        WHEN tt.created_by_member_id::text = participant.recipient_member_id::text
          THEN tt.counterpart_member_id
        ELSE tt.created_by_member_id
      END AS counterpart_member_id,
      tm_1.id AS message_id,
      tm_1.sender_member_id,
      tm_1.role,
      tm_1.message_text,
      tm_1.created_at,
      row_number() OVER (
        PARTITION BY participant.recipient_member_id, tt.id
        ORDER BY tm_1.created_at DESC, tm_1.id DESC
      ) AS latest_row_no
     FROM app.dm_threads tt
     JOIN (
       SELECT tt_inner.id AS thread_id,
              tt_inner.created_by_member_id AS recipient_member_id
         FROM app.dm_threads tt_inner
        WHERE tt_inner.kind = 'conversation'::app.dm_thread_kind
          AND tt_inner.archived_at IS NULL
          AND tt_inner.created_by_member_id IS NOT NULL
       UNION
       SELECT tt_inner.id AS thread_id,
              tt_inner.counterpart_member_id AS recipient_member_id
         FROM app.dm_threads tt_inner
        WHERE tt_inner.kind = 'conversation'::app.dm_thread_kind
          AND tt_inner.archived_at IS NULL
          AND tt_inner.counterpart_member_id IS NOT NULL
     ) participant ON participant.thread_id::text = tt.id::text
     JOIN app.dm_messages tm_1 ON tm_1.thread_id::text = tt.id::text
    WHERE tt.kind = 'conversation'::app.dm_thread_kind
      AND tt.archived_at IS NULL
 ), unread_messages AS (
   SELECT pmu.recipient_member_id,
      tm_1.thread_id,
      count(DISTINCT pmu.dm_message_id)::integer AS unread_message_count,
      count(*)::integer AS unread_update_count,
      max(tm_1.created_at) AS latest_unread_message_created_at
     FROM app.pending_member_updates pmu
     JOIN app.dm_messages tm_1 ON tm_1.id::text = pmu.dm_message_id::text
     JOIN app.dm_threads tt ON tt.id::text = tm_1.thread_id::text
    WHERE pmu.topic = 'dm.message.created'
      AND pmu.dm_message_id IS NOT NULL
      AND tt.kind = 'conversation'::app.dm_thread_kind
      AND tt.archived_at IS NULL
    GROUP BY pmu.recipient_member_id, tm_1.thread_id
 )
 SELECT tm.recipient_member_id,
    tm.club_id,
    tm.thread_id,
    tm.counterpart_member_id,
    tm.message_id AS latest_message_id,
    tm.sender_member_id AS latest_sender_member_id,
    tm.role AS latest_role,
    tm.message_text AS latest_message_text,
    tm.created_at AS latest_created_at,
    COALESCE(um.unread_message_count, 0) AS unread_message_count,
    COALESCE(um.unread_update_count, 0) AS unread_update_count,
    um.latest_unread_message_created_at,
    (COALESCE(um.unread_message_count, 0) > 0) AS has_unread
   FROM thread_messages tm
   LEFT JOIN unread_messages um
     ON um.recipient_member_id::text = tm.recipient_member_id::text
    AND um.thread_id::text = tm.thread_id::text
  WHERE tm.latest_row_no = 1;

-- ── Phase 12: Fix member_updates insert policy (references old table names) ────

DROP POLICY IF EXISTS member_updates_insert_actor_scope ON app.member_updates;

CREATE POLICY member_updates_insert_actor_scope ON app.member_updates
  FOR INSERT WITH CHECK (
    created_by_member_id::text = app.current_actor_member_id()::text
    AND app.actor_has_club_access(club_id)
    AND EXISTS (
      SELECT 1 FROM app.accessible_club_memberships acm
      WHERE acm.club_id::text = member_updates.club_id::text
        AND acm.member_id::text = member_updates.recipient_member_id::text
    )
    AND (dm_message_id IS NULL OR EXISTS (
      SELECT 1 FROM app.dm_messages tm
      JOIN app.dm_threads tt ON tt.id::text = tm.thread_id::text
      WHERE tm.id::text = member_updates.dm_message_id::text
        AND tt.club_id::text = member_updates.club_id::text
    ))
    AND (entity_id IS NULL OR EXISTS (
      SELECT 1 FROM app.entities e
      WHERE e.id::text = member_updates.entity_id::text
        AND e.club_id::text = member_updates.club_id::text
    ))
    AND (entity_version_id IS NULL OR EXISTS (
      SELECT 1 FROM app.entity_versions ev
      JOIN app.entities e ON e.id::text = ev.entity_id::text
      WHERE ev.id::text = member_updates.entity_version_id::text
        AND e.club_id::text = member_updates.club_id::text
    ))
  );

-- ── Phase 13: Recreate RLS policies ────────────────────────────────────────────

-- dm_messages
CREATE POLICY dm_messages_insert_thread_scope ON app.dm_messages
  FOR INSERT WITH CHECK (
    role = 'member'::app.dm_role
    AND sender_member_id::text = app.current_actor_member_id()::text
    AND app.actor_can_access_thread(thread_id)
  );

CREATE POLICY dm_messages_select_superadmin ON app.dm_messages
  FOR SELECT USING (app.current_actor_is_superadmin());

CREATE POLICY dm_messages_select_thread_scope ON app.dm_messages
  FOR SELECT USING (app.actor_can_access_thread(thread_id));

-- dm_threads
CREATE POLICY dm_threads_insert_participant_scope ON app.dm_threads
  FOR INSERT WITH CHECK (
    archived_at IS NULL
    AND kind = 'conversation'::app.dm_thread_kind
    AND created_by_member_id::text = app.current_actor_member_id()::text
    AND counterpart_member_id IS NOT NULL
    AND app.actor_has_club_access(club_id)
  );

CREATE POLICY dm_threads_select_participant_scope ON app.dm_threads
  FOR SELECT USING (
    archived_at IS NULL
    AND app.actor_has_club_access(club_id)
    AND (
      app.current_actor_member_id()::text = created_by_member_id::text
      OR app.current_actor_member_id()::text = counterpart_member_id::text
    )
  );

CREATE POLICY dm_threads_select_superadmin ON app.dm_threads
  FOR SELECT USING (app.current_actor_is_superadmin());

-- redactions
CREATE POLICY redactions_insert_actor ON app.redactions
  FOR INSERT WITH CHECK (
    created_by_member_id::text = app.current_actor_member_id()::text
  );

CREATE POLICY redactions_select_club_scope ON app.redactions
  FOR SELECT USING (app.actor_has_club_access(club_id));

CREATE POLICY redactions_select_superadmin ON app.redactions
  FOR SELECT USING (app.current_actor_is_superadmin());

-- ── Phase 13: Ownership ────────────────────────────────────────────────────────

ALTER TABLE app.current_dm_inbox_threads OWNER TO clawclub_view_owner;
ALTER TABLE app.current_dm_thread_participants OWNER TO clawclub_view_owner;
ALTER TABLE app.pending_member_updates OWNER TO clawclub_view_owner;

-- ── Phase 14: Grants ───────────────────────────────────────────────────────────

-- dm_messages (was transcript_messages)
GRANT SELECT ON TABLE app.dm_messages TO clawclub_view_owner;
GRANT SELECT ON TABLE app.dm_messages TO clawclub_security_definer_owner;

-- dm_threads (was transcript_threads)
GRANT SELECT ON TABLE app.dm_threads TO clawclub_view_owner;
GRANT SELECT ON TABLE app.dm_threads TO clawclub_security_definer_owner;

-- redactions
GRANT SELECT ON TABLE app.redactions TO clawclub_view_owner;
GRANT SELECT ON TABLE app.redactions TO clawclub_security_definer_owner;

-- views
GRANT SELECT ON TABLE app.current_dm_inbox_threads TO clawclub_security_definer_owner;
GRANT SELECT ON TABLE app.current_dm_thread_participants TO clawclub_security_definer_owner;
GRANT SELECT ON TABLE app.pending_member_updates TO clawclub_security_definer_owner;

-- ── Phase 15: Backfill existing topic values ───────────────────────────────────
-- Rename 'transcript.message.created' → 'dm.message.created' in member_updates.
-- This is a one-time data migration. Future inserts use the new topic name.

UPDATE app.member_updates
  SET topic = 'dm.message.created'
  WHERE topic = 'transcript.message.created';
