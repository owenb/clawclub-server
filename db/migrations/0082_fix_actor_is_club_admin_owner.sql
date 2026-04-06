-- Fix actor_is_club_admin ownership.
-- Migration 0079 created this function but did not assign it to the
-- security definer owner role, leaving it owned by the migrator (superuser).

ALTER FUNCTION app.actor_is_club_admin(app.short_id)
    OWNER TO clawclub_security_definer_owner;
