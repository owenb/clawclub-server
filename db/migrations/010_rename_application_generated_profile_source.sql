-- Order of operations matters here:
--   1. Drop the old CHECK constraint, otherwise the UPDATE below would fail
--      with "new row violates check constraint" on any database that has
--      'admission_generated' rows to rewrite (the new value isn't in the old
--      allowed list yet).
--   2. Drop the immutability trigger, otherwise the UPDATE would fail with
--      "UPDATE not allowed on member_club_profile_versions". This is a one-time
--      controlled exception to the append-only invariant on profile versions,
--      done specifically to clean up vocabulary.
--   3. UPDATE the rows.
--   4. Recreate the immutability trigger so the invariant is restored before
--      the next statement runs.
--   5. Add the new CHECK constraint with the 'application_generated' value.

alter table public.member_club_profile_versions
  drop constraint member_club_profile_versions_generation_source_check;

drop trigger if exists member_club_profile_versions_immutable on public.member_club_profile_versions;

update public.member_club_profile_versions
set generation_source = 'application_generated'
where generation_source = 'admission_generated';

create trigger member_club_profile_versions_immutable
    before delete or update on public.member_club_profile_versions
    for each row execute function public.reject_row_mutation();

alter table public.member_club_profile_versions
  add constraint member_club_profile_versions_generation_source_check
  check (
    generation_source = any (
      array[
        'manual'::text,
        'migration_backfill'::text,
        'application_generated'::text,
        'membership_seed'::text
      ]
    )
  );
