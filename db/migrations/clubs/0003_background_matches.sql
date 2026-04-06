-- Background matches: lifecycle tracking for member-targeted matches.
-- Reusable primitive for any worker that computes "member X should know
-- about thing Y" — serendipity, digests, billing nudges, etc.
--
-- See docs/member-signals-plan.md for full design rationale.

CREATE TABLE app.background_matches (
    id                      app.short_id DEFAULT app.new_id() NOT NULL,
    club_id                 text NOT NULL,
    match_kind              text NOT NULL,
    source_id               text NOT NULL,
    target_member_id        text NOT NULL,
    score                   double precision NOT NULL,
    state                   text NOT NULL DEFAULT 'pending',
    payload                 jsonb NOT NULL DEFAULT '{}',
    signal_id               text,
    created_at              timestamptz NOT NULL DEFAULT now(),
    delivered_at            timestamptz,
    expires_at              timestamptz,

    CONSTRAINT background_matches_pkey PRIMARY KEY (id),
    CONSTRAINT background_matches_state_check CHECK (
        state IN ('pending', 'delivered', 'expired')
    ),
    -- Prevents duplicate matches: same kind + source + target = one match.
    -- For introductions: (member_to_member, other_member_id, recipient_member_id)
    -- ensures a member never receives the same introduction twice.
    CONSTRAINT background_matches_unique
        UNIQUE (match_kind, source_id, target_member_id),
    CONSTRAINT background_matches_signal_fkey
        FOREIGN KEY (signal_id) REFERENCES app.member_signals(id)
);

-- Worker query: find pending matches ready for delivery
CREATE INDEX background_matches_pending_idx
    ON app.background_matches (state, created_at)
    WHERE state = 'pending';

-- Cleanup: expire old matches
CREATE INDEX background_matches_expires_idx
    ON app.background_matches (expires_at)
    WHERE expires_at IS NOT NULL AND state = 'pending';

-- Throttle queries: count recent deliveries per member
CREATE INDEX background_matches_delivery_idx
    ON app.background_matches (target_member_id, delivered_at)
    WHERE state = 'delivered';

-- Per-kind throttle: count recent deliveries per member per kind
CREATE INDEX background_matches_kind_delivery_idx
    ON app.background_matches (target_member_id, match_kind, delivered_at)
    WHERE state = 'delivered';
