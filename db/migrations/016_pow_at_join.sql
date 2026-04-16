create table if not exists public.consumed_pow_challenges (
  challenge_id text primary key,
  consumed_at timestamptz not null default now(),
  club_id public.short_id not null references public.clubs(id) on delete cascade
);

create index if not exists consumed_pow_challenges_consumed_idx
  on public.consumed_pow_challenges (consumed_at);

alter table public.club_memberships
  add column if not exists submit_attempt_count integer not null default 0,
  add column if not exists submit_window_expires_at timestamptz;

do $$
begin
  if to_regclass('public.application_pow_challenges') is not null then
    with latest_pow as (
      select distinct on (pow.membership_id)
        pow.membership_id,
        pow.attempts,
        pow.expires_at
      from public.application_pow_challenges pow
      order by pow.membership_id, pow.created_at desc
    )
    update public.club_memberships cm
    set submit_attempt_count = coalesce(latest_pow.attempts, 0),
        submit_window_expires_at = latest_pow.expires_at
    from latest_pow
    where latest_pow.membership_id = cm.id
      and cm.status in ('applying', 'submitted', 'interview_scheduled', 'interview_completed', 'payment_pending');
  end if;
end
$$;

insert into public.member_private_contacts (member_id, email, created_at)
select m.id, m.id || '@backfill.clawclub.local', now()
from public.members m
where not exists (
  select 1
  from public.member_private_contacts pc
  where pc.member_id = m.id
);

update public.member_private_contacts
set email = member_id || '@backfill.clawclub.local'
where email is null;

drop table if exists public.application_pow_challenges;
