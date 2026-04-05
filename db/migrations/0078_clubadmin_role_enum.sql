-- Add 'clubadmin' to membership_role enum.
-- Must be in its own migration because ALTER TYPE ADD VALUE cannot
-- be used in the same transaction as the new value.

ALTER TYPE app.membership_role ADD VALUE IF NOT EXISTS 'clubadmin';
