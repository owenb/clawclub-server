-- Migration: Replace club_quota_policies with unified quota_policies table
-- Adds explicit scope (global/club), global default quotas, and role-based multiplier support

-- 1. Create the scope enum
CREATE TYPE quota_scope AS ENUM ('global', 'club');

-- 2. Drop the old table
DROP TABLE IF EXISTS club_quota_policies;

-- 3. Create the new table
CREATE TABLE quota_policies (
    id              short_id DEFAULT new_id() NOT NULL,
    scope           quota_scope NOT NULL,
    club_id         short_id,
    action_name     text NOT NULL,
    max_per_day     integer NOT NULL,
    created_at      timestamptz DEFAULT now() NOT NULL,
    updated_at      timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT quota_policies_pkey PRIMARY KEY (id),
    CONSTRAINT quota_policies_action_check CHECK (
        action_name IN ('content.create', 'events.create')
    ),
    CONSTRAINT quota_policies_max_check CHECK (max_per_day > 0),
    CONSTRAINT quota_policies_club_fkey FOREIGN KEY (club_id) REFERENCES clubs(id),
    CONSTRAINT quota_policies_scope_club_check CHECK (
        (scope = 'global' AND club_id IS NULL) OR
        (scope = 'club'   AND club_id IS NOT NULL)
    )
);

-- At most one global policy per action
CREATE UNIQUE INDEX quota_policies_global_action_unique
    ON quota_policies (action_name) WHERE (scope = 'global');

-- At most one club override per club/action
CREATE UNIQUE INDEX quota_policies_club_action_unique
    ON quota_policies (club_id, action_name) WHERE (scope = 'club');

-- 4. Insert global defaults
INSERT INTO quota_policies (scope, club_id, action_name, max_per_day) VALUES
    ('global', NULL, 'content.create', 30),
    ('global', NULL, 'events.create',  20);

-- 5. Grant access to app role
GRANT SELECT ON quota_policies TO clawclub_app;
