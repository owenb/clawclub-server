-- Migration: canary that exercises the ALTER TYPE failure mode.
--
-- This is the exact pattern that broke production in 002_gifts_open_loops.sql
-- under the old multi-role design: ALTER TYPE on an enum requires the
-- caller to own the type. Under the single-role schema model, clawclub_app
-- owns entity_kind (db/init.sql does SET SESSION AUTHORIZATION clawclub_app
-- before creating any types) and migrate.sh runs as clawclub_app, so this
-- migration applies cleanly on every deploy.
--
-- After it runs, the value 'migration_canary' is present in pg_enum and
-- can be read back to confirm the deploy succeeded end-to-end.

ALTER TYPE entity_kind ADD VALUE IF NOT EXISTS 'migration_canary';
