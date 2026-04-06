-- Messaging database schema — greenfield init
-- Part of the identity/messaging/club database split.
-- Generic messaging plane: supports direct threads (day one) and future support threads.
-- NO RLS, NO security definer roles, NO club_id on any table.
-- NOTE: Do NOT wrap in BEGIN/COMMIT — the migration runner uses --single-transaction.

SET check_function_bodies = false;
SET default_tablespace = '';
SET default_table_access_method = heap;

-- ============================================================
-- Schema
-- ============================================================

CREATE SCHEMA app;

-- ============================================================
-- Domain
-- ============================================================

CREATE DOMAIN app.short_id AS text
    CONSTRAINT short_id_check CHECK (VALUE ~ '^[23456789abcdefghjkmnpqrstuvwxyz]{12}$');

-- ============================================================
-- ID generator
-- ============================================================

CREATE FUNCTION app.new_id() RETURNS app.short_id
    LANGUAGE plpgsql
AS $$
declare
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  output text := '';
  idx integer;
begin
  for idx in 1..12 loop
    output := output || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;

  return output::app.short_id;
end;
$$;

-- ============================================================
-- Enums
-- ============================================================

CREATE TYPE app.messaging_thread_kind AS ENUM (
    'direct'
);

CREATE TYPE app.messaging_role AS ENUM (
    'member',
    'agent',
    'system'
);

-- ============================================================
-- Canonical messaging tables
-- Member IDs are soft references to the identity database.
-- Display names are resolved at the application layer.
-- ============================================================

-- ── messaging_threads ──────────────────────────────────────

CREATE TABLE app.messaging_threads (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    kind                    app.messaging_thread_kind NOT NULL,
    created_by_member_id    text,           -- soft ref to identity.members
    subject_entity_id       text,           -- soft ref to club.entities (nullable)
    member_a_id             text,           -- LEAST(creator, counterpart) for kind='direct'
    member_b_id             text,           -- GREATEST(creator, counterpart) for kind='direct'
    metadata                jsonb DEFAULT '{}' NOT NULL,
    created_at              timestamptz DEFAULT now() NOT NULL,
    archived_at             timestamptz,

    CONSTRAINT messaging_threads_pkey PRIMARY KEY (id),
    CONSTRAINT messaging_threads_direct_pair_check CHECK (
        kind <> 'direct' OR (
            member_a_id IS NOT NULL
            AND member_b_id IS NOT NULL
            AND member_a_id < member_b_id
        )
    )
);

-- One active direct thread per member pair
CREATE UNIQUE INDEX messaging_threads_direct_pair_unique_idx
    ON app.messaging_threads (kind, member_a_id, member_b_id)
    WHERE kind = 'direct' AND archived_at IS NULL;

CREATE INDEX messaging_threads_created_by_idx
    ON app.messaging_threads (created_by_member_id, created_at DESC);

-- ── messaging_thread_participants ──────────────────────────

CREATE TABLE app.messaging_thread_participants (
    id              app.short_id DEFAULT app.new_id() NOT NULL,
    thread_id       app.short_id NOT NULL,
    member_id       text NOT NULL,          -- soft ref to identity.members
    role            text NOT NULL DEFAULT 'participant',
    joined_at       timestamptz DEFAULT now() NOT NULL,
    left_at         timestamptz,

    CONSTRAINT messaging_thread_participants_pkey PRIMARY KEY (id),
    CONSTRAINT messaging_thread_participants_unique UNIQUE (thread_id, member_id),
    CONSTRAINT messaging_thread_participants_thread_fkey
        FOREIGN KEY (thread_id) REFERENCES app.messaging_threads(id)
);

-- "Find threads I'm in"
CREATE INDEX messaging_thread_participants_member_idx
    ON app.messaging_thread_participants (member_id, thread_id);

-- ── messaging_messages ─────────────────────────────────────

CREATE TABLE app.messaging_messages (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    thread_id               app.short_id NOT NULL,
    sender_member_id        text,           -- soft ref to identity.members
    role                    app.messaging_role NOT NULL,
    message_text            text,
    payload                 jsonb DEFAULT '{}' NOT NULL,
    in_reply_to_message_id  app.short_id,
    client_key              text,           -- idempotency key from client
    created_at              timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT messaging_messages_pkey PRIMARY KEY (id),
    CONSTRAINT messaging_messages_content_check CHECK (
        message_text IS NOT NULL OR payload <> '{}'
    ),
    CONSTRAINT messaging_messages_thread_fkey
        FOREIGN KEY (thread_id) REFERENCES app.messaging_threads(id),
    CONSTRAINT messaging_messages_reply_fkey
        FOREIGN KEY (in_reply_to_message_id) REFERENCES app.messaging_messages(id)
);

-- Idempotency: one client_key per sender
CREATE UNIQUE INDEX messaging_messages_idempotent_idx
    ON app.messaging_messages (sender_member_id, client_key)
    WHERE client_key IS NOT NULL;

CREATE INDEX messaging_messages_thread_created_desc_idx
    ON app.messaging_messages (thread_id, created_at DESC, id DESC);

CREATE INDEX messaging_messages_thread_created_asc_idx
    ON app.messaging_messages (thread_id, created_at);

CREATE INDEX messaging_messages_sender_idx
    ON app.messaging_messages (sender_member_id, created_at DESC);

-- ── messaging_inbox_entries ────────────────────────────────

CREATE TABLE app.messaging_inbox_entries (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    recipient_member_id     text NOT NULL,  -- soft ref to identity.members
    thread_id               app.short_id NOT NULL,
    message_id              app.short_id NOT NULL,
    acknowledged            boolean NOT NULL DEFAULT false,
    created_at              timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT messaging_inbox_entries_pkey PRIMARY KEY (id),
    CONSTRAINT messaging_inbox_entries_recipient_message_unique
        UNIQUE (recipient_member_id, message_id),
    CONSTRAINT messaging_inbox_entries_thread_fkey
        FOREIGN KEY (thread_id) REFERENCES app.messaging_threads(id),
    CONSTRAINT messaging_inbox_entries_message_fkey
        FOREIGN KEY (message_id) REFERENCES app.messaging_messages(id)
);

-- Fast-path: "any unread messages?"
CREATE INDEX messaging_inbox_entries_unread_idx
    ON app.messaging_inbox_entries (recipient_member_id)
    WHERE acknowledged = false;

CREATE INDEX messaging_inbox_entries_recipient_created_idx
    ON app.messaging_inbox_entries (recipient_member_id, created_at DESC);

-- ── messaging_inbox_receipts ───────────────────────────────

CREATE TABLE app.messaging_inbox_receipts (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    inbox_entry_id          app.short_id NOT NULL,
    recipient_member_id     text NOT NULL,
    acknowledged_at         timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT messaging_inbox_receipts_pkey PRIMARY KEY (id),
    CONSTRAINT messaging_inbox_receipts_entry_fkey
        FOREIGN KEY (inbox_entry_id) REFERENCES app.messaging_inbox_entries(id)
);

CREATE INDEX messaging_inbox_receipts_entry_idx
    ON app.messaging_inbox_receipts (inbox_entry_id);

-- ── NOTIFY triggers (for SSE streaming) ───────────────────

CREATE FUNCTION app.notify_messaging_inbox() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('member_updates', json_build_object('recipientMemberId', NEW.recipient_member_id)::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER messaging_inbox_entries_notify
    AFTER INSERT ON app.messaging_inbox_entries
    FOR EACH ROW
    EXECUTE FUNCTION app.notify_messaging_inbox();

-- ── messaging_message_removals ─────────────────────────────

CREATE TABLE app.messaging_message_removals (
    message_id              app.short_id NOT NULL,
    removed_by_member_id    text NOT NULL,  -- soft ref to identity.members
    reason                  text,
    removed_at              timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT messaging_message_removals_pkey PRIMARY KEY (message_id),
    CONSTRAINT messaging_message_removals_message_fkey
        FOREIGN KEY (message_id) REFERENCES app.messaging_messages(id)
);
