-- Member signals: targeted, system-generated notifications delivered
-- through the update feed. General-purpose transport primitive for
-- billing, moderation, admissions, serendipity, and any future
-- system-to-member notification.
--
-- See docs/member-signals-plan.md for full design rationale.

-- ── member_signals ────────────────────────────────────────

CREATE TABLE app.member_signals (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 text NOT NULL,
    recipient_member_id     text NOT NULL,
    seq                     bigint GENERATED ALWAYS AS IDENTITY,
    topic                   text NOT NULL,
    payload                 jsonb NOT NULL DEFAULT '{}',
    entity_id               text,
    match_id                text,
    acknowledged_state      text,
    acknowledged_at         timestamptz,
    suppression_reason      text,
    created_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT member_signals_pkey PRIMARY KEY (id),
    CONSTRAINT member_signals_seq_unique UNIQUE (seq),
    CONSTRAINT member_signals_topic_check CHECK (length(btrim(topic)) > 0),
    CONSTRAINT member_signals_entity_fkey
        FOREIGN KEY (entity_id) REFERENCES app.entities(id),
    CONSTRAINT member_signals_ack_state_check CHECK (
        acknowledged_state IS NULL
        OR acknowledged_state IN ('processed', 'suppressed')
    ),
    CONSTRAINT member_signals_suppression_check CHECK (
        (acknowledged_state = 'suppressed' AND suppression_reason IS NOT NULL)
        OR (acknowledged_state IS DISTINCT FROM 'suppressed')
    )
);

-- Primary query path: unacknowledged signals for a member in their clubs
CREATE INDEX member_signals_recipient_poll_idx
    ON app.member_signals (recipient_member_id, club_id, seq)
    WHERE acknowledged_state IS NULL;

-- Admin/cleanup: find signals for a given match
CREATE INDEX member_signals_match_idx
    ON app.member_signals (match_id)
    WHERE match_id IS NOT NULL;

-- ── NOTIFY trigger ────────────────────────────────────────
-- Reuses the club_activity channel so existing SSE/notifier wakes up.

CREATE FUNCTION app.notify_member_signal() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('club_activity', json_build_object(
        'clubId', NEW.club_id,
        'recipientMemberId', NEW.recipient_member_id
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER member_signals_notify
    AFTER INSERT ON app.member_signals
    FOR EACH ROW EXECUTE FUNCTION app.notify_member_signal();

-- ── worker_state ──────────────────────────────────────────
-- Generic key-value state for background workers.
-- Lives in clubs DB (shard-local in a sharded world).

CREATE TABLE app.worker_state (
    worker_id       text NOT NULL,
    state_key       text NOT NULL,
    state_value     text NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT worker_state_pkey PRIMARY KEY (worker_id, state_key)
);
