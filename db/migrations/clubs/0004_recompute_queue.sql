-- Recompute queue: debounced (member_id, club_id) dirty-set for
-- background workers that need to reprocess a member's state in a club.
--
-- First consumer: introduction matching in the serendipity worker.
-- Any worker can enqueue and claim from this table.
--
-- Design:
--   - One pending entry per (member_id, club_id, queue_name) — natural dedup.
--   - recompute_after supports warm-up delays (e.g., new members wait 24h).
--   - claimed_at enables lease-based claiming to prevent double-processing.

CREATE TABLE app.recompute_queue (
    id                  app.short_id DEFAULT app.new_id() NOT NULL,
    queue_name          text NOT NULL,
    member_id           text NOT NULL,
    club_id             text NOT NULL,
    recompute_after     timestamptz NOT NULL DEFAULT now(),
    created_at          timestamptz NOT NULL DEFAULT now(),
    claimed_at          timestamptz,

    CONSTRAINT recompute_queue_pkey PRIMARY KEY (id),
    CONSTRAINT recompute_queue_pending_unique
        UNIQUE (queue_name, member_id, club_id)
);

-- Claim path: find unclaimed items ready for processing
CREATE INDEX recompute_queue_claimable_idx
    ON app.recompute_queue (queue_name, recompute_after)
    WHERE claimed_at IS NULL;
