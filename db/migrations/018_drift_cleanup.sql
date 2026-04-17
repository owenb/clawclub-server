-- Migration 018: drift cleanup
--
-- Fixes a real functional bug plus three lingering name-drift issues that were
-- invisible until we compared a prod-equivalent schema against dev's init.sql.
--
-- 1. Views out of date.
--    Migration 016 added submit_attempt_count and submit_window_expires_at to
--    club_memberships but did not rebuild the three views that project over it.
--    The views use explicit column lists, so the new columns were silently
--    dropped. src/clubs/unified.ts queries current_club_memberships for those
--    fields, which fails in prod.
--
-- 2. Stale auto-generated constraint names.
--    Postgres does not rename the NOT NULL / FK constraint that sits on top of
--    a column when the column is renamed. Migrations 011 and 014 renamed
--    columns, and migration 016's inline FK pattern produced a constraint name
--    that differs from the one in dev's init.sql. Rename each one to match the
--    current column. Each rename is wrapped in a DO block so that environments
--    where the constraint is already correctly named (fresh dev) are no-ops.

drop view if exists public.active_club_memberships;
drop view if exists public.accessible_club_memberships;
drop view if exists public.current_club_memberships;

create view public.current_club_memberships as
  select
    m.id,
    m.club_id,
    m.member_id,
    m.sponsor_member_id,
    m.role,
    m.status,
    m.joined_at,
    m.left_at,
    m.accepted_covenant_at,
    m.metadata,
    m.is_comped,
    m.comped_at,
    m.comped_by_member_id,
    m.approved_price_amount,
    m.approved_price_currency,
    m.application_name,
    m.application_email,
    m.application_email_normalized,
    m.application_socials,
    m.application_text,
    m.applied_at,
    m.application_submitted_at,
    m.submission_path,
    m.proof_kind,
    m.invitation_id,
    m.generated_profile_draft,
    m.submit_attempt_count,
    m.submit_window_expires_at,
    cms.id as state_version_id,
    cms.reason as state_reason,
    cms.version_no as state_version_no,
    cms.created_at as state_created_at,
    cms.created_by_member_id as state_created_by_member_id
  from public.club_memberships m
    left join public.current_club_membership_states cms
      on cms.membership_id = m.id;

create view public.accessible_club_memberships as
  select *
  from public.current_club_memberships cm
  where left_at is null
    and (
      (is_comped = true and status = 'active'::public.membership_state)
      or (
        status = any (array['active'::public.membership_state, 'cancelled'::public.membership_state])
        and exists (
          select 1
          from public.club_subscriptions s
          where s.membership_id = cm.id
            and s.status = any (array[
              'trialing'::public.subscription_status,
              'active'::public.subscription_status,
              'past_due'::public.subscription_status
            ])
            and coalesce(s.ended_at, 'infinity'::timestamptz) > now()
            and coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
        )
      )
      or (
        status = 'renewal_pending'::public.membership_state
        and (state_created_at + interval '7 days') > now()
      )
    );

create view public.active_club_memberships as
  select *
  from public.current_club_memberships
  where status = 'active'::public.membership_state
    and left_at is null;

do $$
begin
  if exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relnamespace = 'public'::regnamespace
      and t.relname = 'ai_llm_usage_log'
      and c.conname = 'ai_llm_usage_log_gate_name_not_null'
  ) then
    alter table public.ai_llm_usage_log
      rename constraint ai_llm_usage_log_gate_name_not_null
      to ai_llm_usage_log_artifact_kind_not_null;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relnamespace = 'public'::regnamespace
      and t.relname = 'dm_message_mentions'
      and c.conname = 'dm_message_mentions_authored_handle_not_null'
  ) then
    alter table public.dm_message_mentions
      rename constraint dm_message_mentions_authored_handle_not_null
      to dm_message_mentions_authored_label_not_null;
  end if;
end
$$;

do $$
begin
  if exists (
    select 1
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relnamespace = 'public'::regnamespace
      and t.relname = 'consumed_pow_challenges'
      and c.conname = 'consumed_pow_challenges_club_id_fkey'
  ) then
    alter table public.consumed_pow_challenges
      rename constraint consumed_pow_challenges_club_id_fkey
      to consumed_pow_challenges_club_fkey;
  end if;
end
$$;
