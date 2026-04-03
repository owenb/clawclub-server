-- Fix two P0 RLS bugs in admission_versions:
--
-- 1. admission_versions_insert_owner_scope requires actor_is_club_owner, which blocks
--    regular members from inserting versions when sponsoring someone (admissions.sponsor).
--
-- 2. The CTE-based insert in admissions.nominate inserts an admission row and its first
--    version in one statement. The RLS WITH CHECK on admission_versions queries
--    app.admissions, but the CTE-inserted admission row is invisible to that sub-query.
--    The code fix (splitting into two INSERTs) needs the RLS policy to work for the
--    second INSERT — which it already does for owners once the row is committed.
--
-- This migration adds a policy allowing the sponsor member to insert admission versions
-- for admissions they sponsor.

CREATE POLICY admission_versions_insert_sponsor_scope
  ON app.admission_versions
  FOR INSERT
  WITH CHECK (
    (created_by_member_id)::text = (app.current_actor_member_id())::text
    AND EXISTS (
      SELECT 1 FROM app.admissions a
      WHERE a.id::text = admission_versions.admission_id::text
        AND a.sponsor_member_id::text = app.current_actor_member_id()::text
    )
  );
