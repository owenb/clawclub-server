-- Club activity: append-only log of club-wide events.
-- One row per event, no per-recipient fanout.
--
-- Replaces the member_updates fanout for:
--   entity.version.published
--   entity.version.archived
--   entity.redacted
--
-- member_updates is narrowed to targeted/inbox notifications only:
--   dm.message.created
--   dm.message.redacted
--   admission.submitted

-- ── club_activity table ─────────────────────────────────────

CREATE TABLE app.club_activity (
  id                    app.short_id DEFAULT app.new_id() NOT NULL,
  club_id               app.short_id NOT NULL,
  seq                   bigint GENERATED ALWAYS AS IDENTITY,
  topic                 text NOT NULL,
  payload               jsonb NOT NULL DEFAULT '{}',
  entity_id             app.short_id,
  entity_version_id     app.short_id,
  created_by_member_id  app.short_id,
  created_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_activity_pkey PRIMARY KEY (id),
  CONSTRAINT club_activity_seq_key UNIQUE (seq),
  CONSTRAINT club_activity_topic_check CHECK (length(btrim(topic)) > 0),
  CONSTRAINT club_activity_club_id_fkey FOREIGN KEY (club_id) REFERENCES app.clubs(id),
  CONSTRAINT club_activity_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES app.entities(id),
  CONSTRAINT club_activity_created_by_fkey FOREIGN KEY (created_by_member_id) REFERENCES app.members(id)
);

-- Primary query path: "activity for this club since seq N"
CREATE INDEX club_activity_club_seq_idx ON app.club_activity (club_id, seq);

-- ── club_activity_cursors table ─────────────────────────────

CREATE TABLE app.club_activity_cursors (
  member_id   app.short_id NOT NULL,
  club_id     app.short_id NOT NULL,
  last_seq    bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT club_activity_cursors_pkey PRIMARY KEY (member_id, club_id),
  CONSTRAINT club_activity_cursors_member_fkey FOREIGN KEY (member_id) REFERENCES app.members(id),
  CONSTRAINT club_activity_cursors_club_fkey FOREIGN KEY (club_id) REFERENCES app.clubs(id)
);

-- ── NOTIFY trigger: one notification per club event ─────────

CREATE FUNCTION app.notify_club_activity() RETURNS trigger
LANGUAGE plpgsql AS $$
begin
  perform pg_notify(
    'club_activity',
    json_build_object(
      'clubId', new.club_id,
      'seq', new.seq
    )::text
  );
  return new;
end;
$$;

CREATE TRIGGER club_activity_notify_trigger
  AFTER INSERT ON app.club_activity
  FOR EACH ROW EXECUTE FUNCTION app.notify_club_activity();

-- ── RLS: club_activity ──────────────────────────────────────

ALTER TABLE app.club_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.club_activity FORCE ROW LEVEL SECURITY;

CREATE POLICY club_activity_select_club_scope ON app.club_activity
  FOR SELECT
  USING (app.actor_has_club_access(club_id));

CREATE POLICY club_activity_insert_actor_scope ON app.club_activity
  FOR INSERT
  WITH CHECK (
    app.actor_has_club_access(club_id)
    AND (created_by_member_id)::text = (app.current_actor_member_id())::text
  );

CREATE POLICY club_activity_delete_none ON app.club_activity
  FOR DELETE USING (false);

-- ── RLS: club_activity_cursors ──────────────────────────────

ALTER TABLE app.club_activity_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.club_activity_cursors FORCE ROW LEVEL SECURITY;

CREATE POLICY club_activity_cursors_select_own ON app.club_activity_cursors
  FOR SELECT
  USING ((member_id)::text = (app.current_actor_member_id())::text);

CREATE POLICY club_activity_cursors_insert_own ON app.club_activity_cursors
  FOR INSERT
  WITH CHECK ((member_id)::text = (app.current_actor_member_id())::text);

CREATE POLICY club_activity_cursors_update_own ON app.club_activity_cursors
  FOR UPDATE
  USING ((member_id)::text = (app.current_actor_member_id())::text);

CREATE POLICY club_activity_cursors_delete_none ON app.club_activity_cursors
  FOR DELETE USING (false);

-- ── Grants for special roles ────────────────────────────────

GRANT SELECT ON TABLE app.club_activity TO clawclub_view_owner;
GRANT SELECT ON TABLE app.club_activity TO clawclub_security_definer_owner;
GRANT SELECT ON TABLE app.club_activity_cursors TO clawclub_view_owner;
GRANT SELECT, INSERT, UPDATE ON TABLE app.club_activity_cursors TO clawclub_security_definer_owner;
