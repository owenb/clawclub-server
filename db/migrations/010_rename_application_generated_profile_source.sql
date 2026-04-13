update public.member_club_profile_versions
set generation_source = 'application_generated'
where generation_source = 'admission_generated';

alter table public.member_club_profile_versions
  drop constraint member_club_profile_versions_generation_source_check;

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
