alter table public.members
  add column if not exists onboarded_at timestamptz;

alter table public.clubs
  add column if not exists welcome_template jsonb;

update public.members
  set onboarded_at = created_at
  where onboarded_at is null;
