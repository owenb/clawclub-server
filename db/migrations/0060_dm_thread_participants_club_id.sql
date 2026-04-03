-- Rename network_id → club_id in current_dm_thread_participants to match the
-- column name used throughout the rest of the schema and application code.

DROP VIEW IF EXISTS app.current_dm_thread_participants;

CREATE VIEW app.current_dm_thread_participants AS
 SELECT tt.id AS thread_id,
    tt.club_id,
    tt.created_by_member_id AS participant_member_id,
    tt.counterpart_member_id
   FROM app.transcript_threads tt
  WHERE ((tt.kind = 'dm'::app.transcript_thread_kind) AND (tt.archived_at IS NULL) AND (tt.created_by_member_id IS NOT NULL) AND (tt.counterpart_member_id IS NOT NULL))
UNION ALL
 SELECT tt.id AS thread_id,
    tt.club_id,
    tt.counterpart_member_id AS participant_member_id,
    tt.created_by_member_id AS counterpart_member_id
   FROM app.transcript_threads tt
  WHERE ((tt.kind = 'dm'::app.transcript_thread_kind) AND (tt.archived_at IS NULL) AND (tt.created_by_member_id IS NOT NULL) AND (tt.counterpart_member_id IS NOT NULL));

ALTER TABLE app.current_dm_thread_participants OWNER TO clawclub_view_owner;

GRANT SELECT ON TABLE app.current_dm_thread_participants TO clawclub_security_definer_owner;
