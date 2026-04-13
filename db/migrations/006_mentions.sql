CREATE TABLE IF NOT EXISTS entity_version_mentions (
    entity_version_id        short_id NOT NULL,
    field                    text NOT NULL,
    start_offset             integer NOT NULL,
    end_offset               integer NOT NULL,
    mentioned_member_id      short_id NOT NULL,
    authored_handle          text NOT NULL,
    created_at               timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT entity_version_mentions_pkey PRIMARY KEY (entity_version_id, field, start_offset),
    CONSTRAINT entity_version_mentions_field_check CHECK (field IN ('title', 'summary', 'body')),
    CONSTRAINT entity_version_mentions_offset_check CHECK (
        start_offset >= 0
        AND end_offset > start_offset
    ),
    CONSTRAINT entity_version_mentions_version_fkey FOREIGN KEY (entity_version_id) REFERENCES entity_versions(id),
    CONSTRAINT entity_version_mentions_member_fkey FOREIGN KEY (mentioned_member_id) REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS entity_version_mentions_member_created_idx
    ON entity_version_mentions (mentioned_member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dm_message_mentions (
    message_id               short_id NOT NULL,
    start_offset             integer NOT NULL,
    end_offset               integer NOT NULL,
    mentioned_member_id      short_id NOT NULL,
    authored_handle          text NOT NULL,
    created_at               timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT dm_message_mentions_pkey PRIMARY KEY (message_id, start_offset),
    CONSTRAINT dm_message_mentions_offset_check CHECK (
        start_offset >= 0
        AND end_offset > start_offset
    ),
    CONSTRAINT dm_message_mentions_message_fkey FOREIGN KEY (message_id) REFERENCES dm_messages(id),
    CONSTRAINT dm_message_mentions_member_fkey FOREIGN KEY (mentioned_member_id) REFERENCES members(id)
);

CREATE INDEX IF NOT EXISTS dm_message_mentions_member_created_idx
    ON dm_message_mentions (mentioned_member_id, created_at DESC);
