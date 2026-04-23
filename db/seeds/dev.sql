-- Unified local dev seed for single-database architecture.
-- Run as superuser against the dev database.
-- Tokens are created separately with src/token-cli.ts.

begin;

-- ============================================================
-- Members (12 active + 1 suspended)
-- ============================================================

insert into members (public_name, display_name, state, email, created_at) values
  ('Morgan Keeper',     'Morgan Keeper',     'active',    'morgan@clawclub.example.com',              now() - interval '60 days'),
  ('Alice Hound',     'Alice Hound',     'active',    'alice@alicehound.example.com',           now() - interval '50 days'),
  ('Bob Whiskers',    'Bob Whiskers',    'active',    'bob@whiskers.example.com',               now() - interval '50 days'),
  ('Charlie Paws',    'Charlie Paws',    'active',    'charlie@paws.example.com',               now() - interval '50 days'),
  ('Diana Feathers',  'Diana Feathers',  'active',    'diana@drdianafeathers.example.com',      now() - interval '40 days'),
  ('Eddie Scales',    'Eddie Scales',    'active',    'eddie@scales.example.com',               now() - interval '40 days'),
  ('Fiona Hooves',    'Fiona Hooves',    'active',    'fiona@fionahooves.example.com',          now() - interval '30 days'),
  ('George Wings',    'George Wings',    'active',    'george@wings.example.com',               now() - interval '30 days'),
  ('Hannah Fins',     'Hannah Fins',     'active',    'hannah@example.com',                     now() - interval '20 days'),
  ('Ivan Tusks',      'Ivan Tusks',      'active',    'ivan@ivantusks.example.com',             now() - interval '20 days'),
  ('Julia Stripes',   'Julia Stripes',   'active',    'julia@juliastripes.example.com',         now() - interval '20 days'),
  ('Kevin Spots',     'Kevin Spots',     'active',    'kevin@spots.example.com',                now() - interval '5 days'),
  ('Sam Shadow',      'Sam Shadow',      'suspended', 'sam@shadow.example.com',                 now() - interval '45 days');

select id as founder_id    from members where public_name = 'Morgan Keeper' \gset
select id as alice_id   from members where public_name = 'Alice Hound' \gset
select id as bob_id     from members where public_name = 'Bob Whiskers' \gset
select id as charlie_id from members where public_name = 'Charlie Paws' \gset
select id as diana_id   from members where public_name = 'Diana Feathers' \gset
select id as eddie_id   from members where public_name = 'Eddie Scales' \gset
select id as fiona_id   from members where public_name = 'Fiona Hooves' \gset
select id as george_id  from members where public_name = 'George Wings' \gset
select id as hannah_id  from members where public_name = 'Hannah Fins' \gset
select id as ivan_id    from members where public_name = 'Ivan Tusks' \gset
select id as julia_id   from members where public_name = 'Julia Stripes' \gset
select id as kevin_id   from members where public_name = 'Kevin Spots' \gset
select id as sam_id     from members where public_name = 'Sam Shadow' \gset

-- ============================================================
-- Seed profile source rows (replicated into each active membership below)
-- ============================================================

create temp table seed_member_profiles (
  member_id short_id not null,
  version_no integer not null,
  display_name text not null,
  tagline text,
  summary text,
  what_i_do text,
  known_for text,
  services_summary text,
  website_url text,
  links jsonb not null default '[]'::jsonb,
  created_by_member_id short_id not null,
  created_at timestamptz not null
) on commit drop;

insert into seed_member_profiles
  (member_id, version_no, display_name, tagline, summary, what_i_do, known_for, services_summary, website_url, links, created_by_member_id, created_at)
values
  -- Morgan v1 (initial)
  (:'founder_id', 1, 'Morgan', 'Platform founder', 'Founded ClawClub to connect animal lovers.', 'Community building', 'Starting ClawClub', null, null, '[]'::jsonb, :'founder_id', now() - interval '60 days'),
  -- Morgan v2 (updated, rich profile)
  (:'founder_id', 2, 'Morgan Keeper', 'Platform founder & community builder', 'Founder of ClawClub — an agent-first platform connecting animal enthusiasts. Building the future of professional communities through technology.', 'Platform architecture, community ops, partnership development', 'Creating ClawClub, pioneering agent-first community platforms', 'Platform consulting, API integrations, community strategy', 'https://morgankeeper.example.com', '[{"label":"Twitter","url":"https://twitter.com/morgankeeper"},{"label":"GitHub","url":"https://github.com/morgankeeper"},{"label":"LinkedIn","url":"https://linkedin.com/in/morgankeeper"}]'::jsonb, :'founder_id', now() - interval '30 days'),

  -- Alice v1 (initial)
  (:'alice_id', 1, 'Alice', 'Dog trainer', 'Professional dog trainer.', 'Dog training', 'Rescue dogs', null, null, '[]'::jsonb, :'alice_id', now() - interval '50 days'),
  -- Alice v2 (updated, rich profile)
  (:'alice_id', 2, 'Alice Hound', 'Certified dog trainer & canine behaviorist', 'Professional dog trainer with 15 years of experience. Specializing in rescue dog rehabilitation and positive reinforcement methods for all breeds.', 'Dog obedience training, behavioral consultations, puppy socialization programs', 'Rehabilitating rescue dogs, positive reinforcement advocacy', 'Private training sessions, group classes, behavioral assessments', 'https://alicehound.example.com', '[{"label":"Instagram","url":"https://instagram.com/alicehound"},{"label":"Website","url":"https://alicehound.example.com"}]'::jsonb, :'alice_id', now() - interval '25 days'),

  -- Bob
  (:'bob_id', 1, 'Bob Whiskers', 'Cat rescue advocate & wildlife photographer', 'Dedicated cat rescue volunteer and amateur wildlife photographer. Spending weekends at local shelters helping cats find forever homes.', 'Cat rescue coordination, adoption counseling, shelter photography', 'Finding homes for difficult-to-place cats, shelter cat portraits', 'Cat adoption consulting, foster home assessments', 'https://bobwhiskers.example.com', '[{"label":"Flickr","url":"https://flickr.com/bobwhiskers"}]'::jsonb, :'bob_id', now() - interval '50 days'),

  -- Charlie
  (:'charlie_id', 1, 'Charlie Paws', 'Trail runner with a pack of huskies', 'Adventure enthusiast who combines trail running and hiking with dog companionship. Three huskies, countless trails, infinite adventures.', 'Trail guiding with dogs, canine fitness coaching, outdoor photography', 'Epic dog hiking adventures, husky training for trail running', 'Guided trail runs with dogs, outdoor fitness consulting', null, '[{"label":"YouTube","url":"https://youtube.com/@charliepaws"},{"label":"AllTrails","url":"https://alltrails.com/charliepaws"}]'::jsonb, :'charlie_id', now() - interval '50 days'),

  -- Diana
  (:'diana_id', 1, 'Diana Feathers', 'Small animal veterinarian', 'Practicing veterinarian with expertise in cats, dogs, and exotic pets. Running free community vet clinics on weekends to help underserved pet owners.', 'Veterinary care, preventive health education, community clinics', 'Free community vet clinics, exotic pet care expertise', 'Veterinary consultations, wellness plans, nutrition counseling', 'https://drdianafeathers.example.com', '[{"label":"LinkedIn","url":"https://linkedin.com/in/dianafeathers"}]'::jsonb, :'diana_id', now() - interval '40 days'),

  -- Eddie
  (:'eddie_id', 1, 'Eddie Scales', 'Pet supplies & nutrition specialist', 'Running a premium pet supply store focused on artisanal and organic pet food. Helping pet owners make informed nutrition choices.', 'Pet nutrition consulting, product curation, retail management', 'Curating artisanal pet food brands, nutrition workshops', 'Nutrition consultations, custom diet plans, bulk ordering', null, '[]'::jsonb, :'eddie_id', now() - interval '40 days'),

  -- Fiona
  (:'fiona_id', 1, 'Fiona Hooves', 'Urban wildlife conservation researcher', 'PhD student researching urban fox populations and human-wildlife coexistence. Passionate about bridging the gap between city life and nature.', 'Field research, population surveys, conservation policy development', 'Urban fox population studies, wildlife corridor mapping', 'Research consulting, educational talks, field survey training', 'https://fionahooves.example.com', '[{"label":"ResearchGate","url":"https://researchgate.net/fionahooves"}]'::jsonb, :'fiona_id', now() - interval '30 days'),

  -- George
  (:'george_id', 1, 'George Wings', 'Birdwatcher who also loves cats', 'Finding the delicate balance between cat ownership and bird conservation. Designing outdoor cat enclosures that keep cats happy and birds safe.', 'Catio design, bird-safe cat ownership advocacy', 'Innovative catio designs, bird-friendly cat management', 'Custom catio design consultations', null, '[{"label":"eBird","url":"https://ebird.org/profile/georgewings"}]'::jsonb, :'george_id', now() - interval '30 days'),

  -- Hannah
  (:'hannah_id', 1, 'Hannah Fins', 'First-time puppy parent', 'Recently adopted my first dog — a golden retriever named Biscuit. Documenting every milestone and learning everything about dog ownership from scratch.', 'Software engineering (day job), puppy parenting (full-time)', 'Documenting the first-year puppy journey on social media', null, null, '[{"label":"TikTok","url":"https://tiktok.com/@hannahfins"}]'::jsonb, :'hannah_id', now() - interval '20 days'),

  -- Ivan
  (:'ivan_id', 1, 'Ivan Tusks', 'Professional wildlife & nature photographer', 'Award-winning photographer specializing in foxes and woodland wildlife. Published in National Geographic and BBC Wildlife Magazine.', 'Wildlife photography, print sales, editorial commissions, workshops', 'Fox photography in natural habitats, woodland wildlife series', 'Photography workshops, guided wildlife photo tours, print licensing', 'https://ivantusks.example.com', '[{"label":"Portfolio","url":"https://ivantusks.example.com"},{"label":"Instagram","url":"https://instagram.com/ivantusks"}]'::jsonb, :'ivan_id', now() - interval '20 days'),

  -- Julia
  (:'julia_id', 1, 'Julia Stripes', 'Feline behavior specialist', 'Certified cat behaviorist helping owners understand and resolve behavioral issues. Specializing in multi-cat household dynamics and stress reduction.', 'Behavior consultations, fear-free handling training, environmental enrichment', 'Solving multi-cat household conflicts, feline stress reduction', 'In-home behavior assessments, virtual consultations, workshops', 'https://juliastripes.example.com', '[]'::jsonb, :'julia_id', now() - interval '20 days'),

  -- Kevin
  (:'kevin_id', 1, 'Kevin Spots', 'Ethical Dalmatian breeder', 'Breeding healthy, well-socialized Dalmatians for over a decade. Every puppy is health-tested, microchipped, and raised in a family environment.', 'Responsible breeding, puppy socialization, genetic health testing', 'Health-tested Dalmatians, breed education and advocacy', 'Puppy placement consulting, breed selection guidance', null, '[]'::jsonb, :'kevin_id', now() - interval '5 days'),

  -- Sam (suspended — minimal profile)
  (:'sam_id', 1, 'Sam Shadow', 'Former member', null, null, null, null, null, '[]'::jsonb, :'sam_id', now() - interval '45 days')
on conflict do nothing;

update members m
set display_name = latest.display_name
from (
  select distinct on (member_id) member_id, display_name
  from seed_member_profiles
  order by member_id, version_no desc, created_at desc
) latest
where latest.member_id = m.id;

-- ============================================================
-- Global roles (Morgan is superadmin)
-- ============================================================

insert into member_global_role_versions
  (member_id, role, status, version_no, created_by_member_id, created_at)
values
  (:'founder_id', 'superadmin', 'active', 1, :'founder_id', now() - interval '60 days')
on conflict do nothing;

-- ============================================================
-- Clubs (3 clubs with admission policies)
-- ============================================================

insert into clubs (slug, name, owner_member_id, summary, created_at) values
  ('dogclub', 'DogClub', :'founder_id', 'A club for dog lovers and canine professionals.', now() - interval '58 days'),
  ('catclub', 'CatClub', :'founder_id', 'A club for cat enthusiasts and feline experts.',   now() - interval '58 days'),
  ('foxclub', 'FoxClub', :'founder_id', 'A club for wildlife enthusiasts focused on foxes.', now() - interval '58 days')
on conflict (slug) do nothing;

select id as dogclub_id from clubs where slug = 'dogclub' \gset
select id as catclub_id from clubs where slug = 'catclub' \gset
select id as foxclub_id from clubs where slug = 'foxclub' \gset

-- Club versions (with admission policies)
insert into club_versions
  (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id, created_at)
values
  (:'dogclub_id', :'founder_id', 'DogClub', 'A club for dog lovers and canine professionals.',
   'Members must demonstrate genuine passion for dogs and canine welfare. We welcome trainers, breeders, vets, groomers, and devoted dog owners. Applicants should share how they contribute to the dog community.',
   1, :'founder_id', now() - interval '58 days'),
  (:'catclub_id', :'founder_id', 'CatClub', 'A club for cat enthusiasts and feline experts.',
   'We welcome cat enthusiasts who contribute positively to feline communities. Preference given to rescue volunteers, veterinary professionals, and behaviorists. Tell us about your cats and your involvement.',
   1, :'founder_id', now() - interval '58 days'),
  (:'foxclub_id', :'founder_id', 'FoxClub', 'A club for wildlife enthusiasts focused on foxes.',
   'Open to wildlife enthusiasts with a focus on fox conservation and education. We value researchers, photographers, and conservationists. Describe your connection to wildlife and foxes specifically.',
   1, :'founder_id', now() - interval '58 days')
on conflict do nothing;

-- ============================================================
-- Memberships
-- ============================================================

-- Morgan: clubadmin of all three, auto-comped as owner
insert into club_memberships (club_id, member_id, role, status, joined_at, is_comped, comped_at, comped_by_member_id) values
  (:'dogclub_id', :'founder_id', 'clubadmin', 'active', now() - interval '58 days', true, now() - interval '58 days', null),
  (:'catclub_id', :'founder_id', 'clubadmin', 'active', now() - interval '58 days', true, now() - interval '58 days', null),
  (:'foxclub_id', :'founder_id', 'clubadmin', 'active', now() - interval '58 days', true, now() - interval '58 days', null)
on conflict do nothing;

-- Alice: member of DogClub and CatClub
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'dogclub_id', :'alice_id', 'member', :'founder_id', 'active', now() - interval '50 days'),
  (:'catclub_id', :'alice_id', 'member', :'founder_id', 'active', now() - interval '50 days')
on conflict do nothing;

-- Bob: member of CatClub and FoxClub
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'catclub_id', :'bob_id', 'member', :'founder_id', 'active', now() - interval '50 days'),
  (:'foxclub_id', :'bob_id', 'member', :'founder_id', 'active', now() - interval '50 days')
on conflict do nothing;

-- Charlie: member of DogClub and FoxClub
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'dogclub_id', :'charlie_id', 'member', :'founder_id', 'active', now() - interval '50 days'),
  (:'foxclub_id', :'charlie_id', 'member', :'founder_id', 'active', now() - interval '50 days')
on conflict do nothing;

-- Diana: member of DogClub and FoxClub, clubadmin of CatClub
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'dogclub_id', :'diana_id', 'member', :'founder_id', 'active', now() - interval '40 days'),
  (:'foxclub_id', :'diana_id', 'member', :'founder_id', 'active', now() - interval '40 days')
on conflict do nothing;
insert into club_memberships (club_id, member_id, role, status, joined_at) values
  (:'catclub_id', :'diana_id', 'clubadmin', 'active', now() - interval '40 days')
on conflict do nothing;

-- Eddie: member of DogClub (active) and CatClub (cancelled)
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at, left_at) values
  (:'dogclub_id', :'eddie_id', 'member', :'alice_id', 'active', now() - interval '38 days', null),
  (:'catclub_id', :'eddie_id', 'member', :'alice_id', 'cancelled', now() - interval '38 days', null)
on conflict do nothing;

-- Fiona: member of FoxClub (active), with a pending invitation-backed DogClub application
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'foxclub_id', :'fiona_id', 'member', :'bob_id', 'active', now() - interval '28 days')
on conflict do nothing;

-- George: member of CatClub (active) and FoxClub (removed)
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at, left_at) values
  (:'catclub_id', :'george_id', 'member', :'bob_id', 'active', now() - interval '28 days', null),
  (:'foxclub_id', :'george_id', 'member', :'bob_id', 'removed', now() - interval '28 days', now() - interval '14 days')
on conflict do nothing;

-- Hannah: registered but not yet admitted anywhere; pending DogClub invitation-backed application seeded below

-- Ivan: member of DogClub and FoxClub
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'dogclub_id', :'ivan_id', 'member', :'charlie_id', 'active', now() - interval '18 days'),
  (:'foxclub_id', :'ivan_id', 'member', :'charlie_id', 'active', now() - interval '18 days')
on conflict do nothing;

-- Julia: active in CatClub, with a pending DogClub application seeded below
insert into club_memberships (
  club_id, member_id, role, sponsor_member_id, status, joined_at
) values
  (:'catclub_id', :'julia_id', 'member', :'diana_id', 'active', now() - interval '15 days')
on conflict do nothing;

-- Kevin: member of DogClub (recently accepted via admission)
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at) values
  (:'dogclub_id', :'kevin_id', 'member', :'founder_id', 'active', now() - interval '5 days')
on conflict do nothing;

-- Sam: member of DogClub and CatClub (both removed after suspension)
insert into club_memberships (club_id, member_id, role, sponsor_member_id, status, joined_at, left_at) values
  (:'dogclub_id', :'sam_id', 'member', :'founder_id', 'removed', now() - interval '44 days', now() - interval '30 days'),
  (:'catclub_id', :'sam_id', 'member', :'founder_id', 'removed', now() - interval '44 days', now() - interval '30 days')
on conflict do nothing;

-- Capture all membership IDs
select id as founder_dog_mid    from club_memberships where club_id = :'dogclub_id' and member_id = :'founder_id' \gset
select id as founder_cat_mid    from club_memberships where club_id = :'catclub_id' and member_id = :'founder_id' \gset
select id as founder_fox_mid    from club_memberships where club_id = :'foxclub_id' and member_id = :'founder_id' \gset
select id as alice_dog_mid   from club_memberships where club_id = :'dogclub_id' and member_id = :'alice_id' \gset
select id as alice_cat_mid   from club_memberships where club_id = :'catclub_id' and member_id = :'alice_id' \gset
select id as bob_cat_mid     from club_memberships where club_id = :'catclub_id' and member_id = :'bob_id' \gset
select id as bob_fox_mid     from club_memberships where club_id = :'foxclub_id' and member_id = :'bob_id' \gset
select id as charlie_dog_mid from club_memberships where club_id = :'dogclub_id' and member_id = :'charlie_id' \gset
select id as charlie_fox_mid from club_memberships where club_id = :'foxclub_id' and member_id = :'charlie_id' \gset
select id as diana_dog_mid   from club_memberships where club_id = :'dogclub_id' and member_id = :'diana_id' \gset
select id as diana_cat_mid   from club_memberships where club_id = :'catclub_id' and member_id = :'diana_id' \gset
select id as diana_fox_mid   from club_memberships where club_id = :'foxclub_id' and member_id = :'diana_id' \gset
select id as eddie_dog_mid   from club_memberships where club_id = :'dogclub_id' and member_id = :'eddie_id' \gset
select id as eddie_cat_mid   from club_memberships where club_id = :'catclub_id' and member_id = :'eddie_id' \gset
select id as fiona_fox_mid   from club_memberships where club_id = :'foxclub_id' and member_id = :'fiona_id' \gset
select id as george_cat_mid  from club_memberships where club_id = :'catclub_id' and member_id = :'george_id' \gset
select id as george_fox_mid  from club_memberships where club_id = :'foxclub_id' and member_id = :'george_id' \gset
select id as ivan_dog_mid    from club_memberships where club_id = :'dogclub_id' and member_id = :'ivan_id' \gset
select id as ivan_fox_mid    from club_memberships where club_id = :'foxclub_id' and member_id = :'ivan_id' \gset
select id as julia_cat_mid   from club_memberships where club_id = :'catclub_id' and member_id = :'julia_id' \gset
select id as kevin_dog_mid   from club_memberships where club_id = :'dogclub_id' and member_id = :'kevin_id' \gset
select id as sam_dog_mid     from club_memberships where club_id = :'dogclub_id' and member_id = :'sam_id' \gset
select id as sam_cat_mid     from club_memberships where club_id = :'catclub_id' and member_id = :'sam_id' \gset

-- ============================================================
-- Membership state versions
-- ============================================================

-- Round 1: initial states for all memberships
insert into club_membership_state_versions
  (membership_id, status, reason, version_no, created_by_member_id, created_at)
values
  -- Morgan (clubadmin, active)
  (:'founder_dog_mid', 'active', 'founder',  1, :'founder_id', now() - interval '58 days'),
  (:'founder_cat_mid', 'active', 'founder',  1, :'founder_id', now() - interval '58 days'),
  (:'founder_fox_mid', 'active', 'founder',  1, :'founder_id', now() - interval '58 days'),
  -- Alice (active)
  (:'alice_dog_mid', 'active', 'seed',    1, :'founder_id', now() - interval '50 days'),
  (:'alice_cat_mid', 'active', 'seed',    1, :'founder_id', now() - interval '50 days'),
  -- Bob (active)
  (:'bob_cat_mid',   'active', 'seed',    1, :'founder_id', now() - interval '50 days'),
  (:'bob_fox_mid',   'active', 'seed',    1, :'founder_id', now() - interval '50 days'),
  -- Charlie (active)
  (:'charlie_dog_mid', 'active', 'seed',  1, :'founder_id', now() - interval '50 days'),
  (:'charlie_fox_mid', 'active', 'seed',  1, :'founder_id', now() - interval '50 days'),
  -- Diana (active)
  (:'diana_dog_mid', 'active', 'seed',    1, :'founder_id', now() - interval '40 days'),
  (:'diana_cat_mid', 'active', 'seed',    1, :'founder_id', now() - interval '40 days'),
  (:'diana_fox_mid', 'active', 'seed',    1, :'founder_id', now() - interval '40 days'),
  -- Eddie (both start active; CatClub will cancel in round 2)
  (:'eddie_dog_mid', 'active', 'seed',    1, :'founder_id', now() - interval '38 days'),
  (:'eddie_cat_mid', 'active', 'seed',    1, :'founder_id', now() - interval '38 days'),
  -- Fiona: FoxClub active
  (:'fiona_fox_mid', 'active', 'seed',    1, :'founder_id', now() - interval '28 days'),
  -- George: CatClub active, FoxClub starts active (removed in round 2)
  (:'george_cat_mid', 'active', 'seed',   1, :'founder_id', now() - interval '28 days'),
  (:'george_fox_mid', 'active', 'seed',   1, :'founder_id', now() - interval '28 days'),
  -- Ivan (active)
  (:'ivan_dog_mid',  'active', 'seed',    1, :'founder_id', now() - interval '18 days'),
  (:'ivan_fox_mid',  'active', 'seed',    1, :'founder_id', now() - interval '18 days'),
  -- Julia (active in CatClub)
  (:'julia_cat_mid', 'active', 'seed',    1, :'diana_id', now() - interval '15 days'),
  -- Kevin (active, admitted)
  (:'kevin_dog_mid', 'active', 'admitted via owner nomination', 1, :'founder_id', now() - interval '5 days'),
  -- Sam (both start active; removed in round 2)
  (:'sam_dog_mid',   'active', 'seed',    1, :'founder_id', now() - interval '44 days'),
  (:'sam_cat_mid',   'active', 'seed',    1, :'founder_id', now() - interval '44 days')
on conflict do nothing;

-- Round 2: state transitions
insert into club_membership_state_versions
  (membership_id, status, reason, version_no, created_by_member_id, created_at)
values
  -- Eddie cancelled in CatClub (membership ended)
  (:'eddie_cat_mid', 'cancelled', 'Membership ended after unpaid subscription', 2, :'founder_id', now() - interval '10 days'),
  -- George removed from FoxClub (posted inappropriate content)
  (:'george_fox_mid', 'removed', 'Repeated posting of off-topic content after warnings', 2, :'founder_id', now() - interval '14 days'),
  -- Sam removed from both clubs (suspended from platform)
  (:'sam_dog_mid', 'removed', 'Account suspended — platform policy violation', 2, :'founder_id', now() - interval '30 days'),
  (:'sam_cat_mid', 'removed', 'Account suspended — platform policy violation', 2, :'founder_id', now() - interval '30 days')
on conflict do nothing;

-- ============================================================
-- Club-scoped profile history (copy source rows into each membership)
-- ============================================================

insert into member_club_profile_versions (
  membership_id,
  member_id,
  club_id,
  version_no,
  tagline,
  summary,
  what_i_do,
  known_for,
  services_summary,
  website_url,
  links,
  created_by_member_id,
  generation_source,
  created_at
)
select
  cm.id,
  cm.member_id,
  cm.club_id,
  smp.version_no,
  smp.tagline,
  smp.summary,
  smp.what_i_do,
  smp.known_for,
  smp.services_summary,
  smp.website_url,
  smp.links,
  smp.created_by_member_id,
  'migration_backfill',
  smp.created_at
from club_memberships cm
join seed_member_profiles smp on smp.member_id = cm.member_id
where cm.joined_at is not null
on conflict do nothing;

-- ============================================================
-- Club applications
-- ============================================================

-- Invitations that feed the application seeds must exist before the
-- application subqueries below resolve invitation_id.

insert into invite_requests (
  club_id,
  sponsor_member_id,
  candidate_name,
  candidate_email,
  candidate_member_id,
  reason,
  delivery_kind,
  target_source,
  expires_at,
  used_at,
  used_membership_id,
  support_withdrawn_at,
  metadata,
  created_at
) values
  (
    :'dogclub_id',
    :'alice_id',
    'Fiona Hooves',
    'fiona@example.com',
    null,
    'Alice invited Fiona to join DogClub through the new invitation flow.',
    'code',
    'email',
    now() + interval '23 days',
    now() - interval '7 days',
    null,
    null,
    '{"seed":"used"}'::jsonb,
    now() - interval '7 days'
  ),
  (
    :'dogclub_id',
    :'charlie_id',
    'Hannah Fins',
    'hannah@example.com',
    null,
    'Charlie invited Hannah after meeting her at a dog training workshop.',
    'code',
    'email',
    now() + interval '27 days',
    now() - interval '3 days',
    null,
    null,
    '{"seed":"used"}'::jsonb,
    now() - interval '3 days'
  ),
  (
    :'dogclub_id',
    :'alice_id',
    'Nora Walks',
    'nora@example.com',
    null,
    'Open invitation example for local rescue volunteers.',
    'code',
    'email',
    now() + interval '30 days',
    null,
    null,
    null,
    '{"seed":"open"}'::jsonb,
    now() - interval '1 day'
  )
on conflict do nothing;

insert into invite_codes (invite_request_id, code)
select id, code
from (
  values
    ('fiona@example.com', 'FJ7A-2D6G'),
    ('hannah@example.com', 'HANH-A237'),
    ('nora@example.com', 'N4RA-2PK9')
) as seed(candidate_email, code)
join invite_requests ir on ir.candidate_email = seed.candidate_email
on conflict do nothing;

insert into club_applications (
  club_id,
  applicant_member_id,
  submission_path,
  invitation_id,
  sponsor_member_id,
  sponsor_name_snapshot,
  invite_reason_snapshot,
  invite_mode,
  phase,
  draft_name,
  draft_socials,
  draft_application,
  generated_profile_draft,
  gate_verdict,
  gate_feedback,
  gate_last_run_at,
  created_at,
  updated_at,
  submitted_at
) values
  (
    :'dogclub_id',
    :'fiona_id',
    'invitation',
    (select invite_request_id from invite_codes where code = 'FJ7A-2D6G'),
    :'alice_id',
    'Alice Hound',
    'Alice invited Fiona to join DogClub through the new invitation flow.',
    'external',
    'revision_required',
    'Fiona Hooves',
    '@fiona',
    'I would love to join DogClub and share urban wildlife crossover ideas with dog owners.',
    null,
    'needs_revision',
    jsonb_build_object('message', 'Please tell the admins a bit more about your hands-on dog experience.', 'missingItems', jsonb_build_array('dog_experience')),
    now() - interval '7 days',
    now() - interval '7 days',
    now() - interval '7 days',
    now() - interval '7 days'
  ),
  (
    :'dogclub_id',
    :'hannah_id',
    'invitation',
    (select invite_request_id from invite_codes where code = 'HANH-A237'),
    :'charlie_id',
    'Charlie Paws',
    'Charlie invited Hannah after meeting her at a dog training workshop.',
    'external',
    'awaiting_review',
    'Hannah Fins',
    '@hannahfins',
    'I recently adopted my first dog and I want to learn from experienced owners while contributing to local dog meetups.',
    null,
    'passed',
    null,
    now() - interval '3 days',
    now() - interval '3 days',
    now() - interval '3 days',
    now() - interval '3 days'
  ),
  (
    :'dogclub_id',
    :'julia_id',
    'cold',
    null,
    null,
    null,
    null,
    null,
    'awaiting_review',
    'Julia Stripes',
    '@juliastripes',
    'I would like to bring my feline behavior work into a broader animal-care community and contribute workshops for dog owners with shy rescue pets.',
    null,
    'passed',
    null,
    now() - interval '2 days',
    now() - interval '2 days',
    now() - interval '2 days',
    now() - interval '2 days'
  )
on conflict do nothing;

insert into club_application_revisions (
  application_id,
  version_no,
  draft_name,
  draft_socials,
  draft_application,
  gate_verdict,
  gate_feedback,
  created_by_member_id,
  created_at
)
select
  ca.id,
  1,
  ca.draft_name,
  ca.draft_socials,
  ca.draft_application,
  ca.gate_verdict,
  ca.gate_feedback,
  ca.applicant_member_id,
  ca.submitted_at
from club_applications ca
where ca.club_id = :'dogclub_id'
  and ca.applicant_member_id in (:'fiona_id', :'hannah_id', :'julia_id')
on conflict do nothing;

insert into club_applicant_blocks (club_id, member_id, block_kind, created_at, created_by_member_id, reason) values
  (:'foxclub_id', :'george_id', 'removed', now() - interval '14 days', :'founder_id', 'Seeded removal block'),
  (:'dogclub_id', :'sam_id', 'removed', now() - interval '30 days', :'founder_id', 'Seeded removal block'),
  (:'catclub_id', :'sam_id', 'removed', now() - interval '30 days', :'founder_id', 'Seeded removal block')
on conflict do nothing;

-- ============================================================
-- Subscriptions
-- ============================================================

insert into club_subscriptions
  (membership_id, payer_member_id, status, amount, currency, started_at, current_period_end)
values
  -- Alice (comped by Morgan)
  (:'alice_dog_mid', :'founder_id', 'active', 0, 'USD', now() - interval '50 days', null),
  (:'alice_cat_mid', :'founder_id', 'active', 0, 'USD', now() - interval '50 days', null),
  -- Bob (self-paid, real amount)
  (:'bob_cat_mid', :'bob_id', 'active', 29, 'USD', now() - interval '50 days', now() + interval '11 days'),
  (:'bob_fox_mid', :'bob_id', 'active', 29, 'USD', now() - interval '50 days', now() + interval '11 days'),
  -- Charlie (comped by Morgan)
  (:'charlie_dog_mid', :'founder_id', 'active', 0, 'USD', now() - interval '50 days', null),
  (:'charlie_fox_mid', :'founder_id', 'active', 0, 'USD', now() - interval '50 days', null),
  -- Diana: DogClub and FoxClub (self-paid)
  (:'diana_dog_mid', :'diana_id', 'active', 29, 'USD', now() - interval '40 days', now() + interval '21 days'),
  (:'diana_cat_mid', :'diana_id', 'active', 29, 'USD', now() - interval '40 days', now() + interval '21 days'),
  (:'diana_fox_mid', :'diana_id', 'active', 29, 'USD', now() - interval '40 days', now() + interval '21 days'),
  -- Eddie: DogClub active, CatClub past_due
  (:'eddie_dog_mid', :'eddie_id', 'active',   29, 'USD', now() - interval '38 days', now() + interval '23 days'),
  (:'eddie_cat_mid', :'eddie_id', 'past_due', 29, 'USD', now() - interval '38 days', now() - interval '3 days'),
  -- Fiona: FoxClub active (DogClub invited, no subscription)
  (:'fiona_fox_mid', :'fiona_id', 'active', 29, 'USD', now() - interval '28 days', now() + interval '2 days'),
  -- George: CatClub active, FoxClub canceled
  (:'george_cat_mid', :'george_id', 'active',   29, 'USD', now() - interval '28 days', now() + interval '2 days'),
  (:'george_fox_mid', :'george_id', 'canceled', 29, 'USD', now() - interval '28 days', now() - interval '14 days'),
  -- Ivan (comped by Morgan)
  (:'ivan_dog_mid', :'founder_id', 'active', 0, 'USD', now() - interval '18 days', null),
  (:'ivan_fox_mid', :'founder_id', 'active', 0, 'USD', now() - interval '18 days', null),
  -- Julia (trialing)
  (:'julia_cat_mid', :'julia_id', 'trialing', 29, 'USD', now() - interval '15 days', now() + interval '15 days'),
  -- Kevin (comped by Morgan, recently admitted)
  (:'kevin_dog_mid', :'founder_id', 'active', 0, 'USD', now() - interval '5 days', null),
  -- Sam (ended)
  (:'sam_dog_mid', :'sam_id', 'ended', 29, 'USD', now() - interval '44 days', now() - interval '30 days'),
  (:'sam_cat_mid', :'sam_id', 'ended', 29, 'USD', now() - interval '44 days', now() - interval '30 days')
on conflict do nothing;

-- ############################################################
-- CLUBS DATA: quotas, contents, events, RSVPs, vouches,
--             admissions, activity
-- ############################################################

-- ============================================================
-- DogClub contents
-- ============================================================

-- dog_post1: "Annual Dog Show 2026 Recap" by Alice
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'alice_id', now() - interval '14 days', now() - interval '14 days')
returning id as dog_post1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'post', :'alice_id', :'dog_post1_thread', now() - interval '14 days')
returning id as dog_post1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_post1', 1, 'published',
  'Annual Dog Show 2026 Recap',
  'Highlights and winners from this year''s spectacular show',
  'The annual dog show was a tremendous success this year with over 200 entries across 45 breeds. Best in Show went to a magnificent Irish Wolfhound named Thunder. The agility competition was fierce, with our own club member Charlie''s husky placing third. Next year we''re expanding to include a rescue dog showcase — stay tuned for volunteer opportunities!',
  now() - interval '14 days', now() - interval '14 days', :'alice_id');

-- dog_post2: "Best Dog-Friendly Hiking Trails" by Charlie
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'charlie_id', now() - interval '7 days', now() - interval '7 days')
returning id as dog_post2_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'post', :'charlie_id', :'dog_post2_thread', now() - interval '7 days')
returning id as dog_post2 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_post2', 1, 'published',
  'Best Dog-Friendly Hiking Trails',
  'My top 5 trails tested with three huskies',
  'After years of trail running with my pack, here are the five best dog-friendly trails in our area: 1) Riverside Loop — wide paths, water access, moderate difficulty. 2) Pine Ridge Trail — shaded, great in summer, off-leash section. 3) Summit View — challenging but worth it, bring extra water. 4) Meadow Walk — flat and easy, perfect for puppies. 5) Canyon Creek — advanced only, steep switchbacks but amazing views. Always check seasonal closures and leash requirements!',
  now() - interval '7 days', now() - interval '7 days', :'charlie_id');

-- dog_opp1: "Dog Walking Business Partnership" by Morgan
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'founder_id', now() - interval '10 days', now() - interval '10 days')
returning id as dog_opp1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'dogclub_id', 'opportunity', :'founder_id', :'dog_opp1_thread', true, now() - interval '10 days')
returning id as dog_opp1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, expires_at, created_at, created_by_member_id)
values (:'dog_opp1', 1, 'published',
  'Dog Walking Business Partnership',
  'Looking for a partner to co-run a premium dog walking service',
  'I''m exploring launching a premium dog walking service in the downtown area. Looking for someone with professional dog handling experience to partner on this. We would split the business 50/50. Initial investment is minimal — mainly insurance and marketing. Ideal partner has flexible schedule and genuine love for dogs.',
  now() - interval '10 days', now() + interval '50 days',
  now() - interval '10 days', :'founder_id');

-- dog_svc1: "Professional Obedience Training" by Alice
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'alice_id', now() - interval '21 days', now() - interval '21 days')
returning id as dog_svc1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'dogclub_id', 'service', :'alice_id', :'dog_svc1_thread', true, now() - interval '21 days')
returning id as dog_svc1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_svc1', 1, 'published',
  'Professional Obedience Training',
  'Private and group sessions for dogs of all ages',
  'Offering professional obedience training using positive reinforcement methods. Private sessions: 1 hour, tailored to your dog''s specific needs. Group classes: 6-week programs for puppies, adolescents, and adults. Specializing in rescue dog rehabilitation — fearful and reactive dogs welcome. First consultation is free for club members.',
  now() - interval '21 days', now() - interval '21 days', :'alice_id');

-- dog_ask1: "Vet Recommendations Near Downtown?" by Charlie
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'charlie_id', now() - interval '3 days', now() - interval '3 days')
returning id as dog_ask1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'dogclub_id', 'ask', :'charlie_id', :'dog_ask1_thread', true, now() - interval '3 days')
returning id as dog_ask1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, expires_at, created_at, created_by_member_id)
values (:'dog_ask1', 1, 'published',
  'Vet Recommendations Near Downtown?',
  'Need a new vet for my three huskies',
  'My previous vet retired and I need to find a new one that can handle three large, energetic huskies. Requirements: experience with northern breeds, weekend availability, ideally within 20 minutes of downtown. Bonus points if they do house calls. Any recommendations from fellow club members?',
  now() - interval '3 days', now() + interval '27 days',
  now() - interval '3 days', :'charlie_id');

-- dog_evt1: "DogClub Monthly Meetup - April" by Morgan (future)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'founder_id', now() - interval '8 days', now() - interval '8 days')
returning id as dog_evt1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'event', :'founder_id', :'dog_evt1_thread', now() - interval '8 days')
returning id as dog_evt1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_evt1', 1, 'published',
  'DogClub Monthly Meetup - April',
  'Our regular monthly gathering at Riverside Park',
  'Join us for the April edition of our monthly meetup! We''ll have an off-leash play session followed by a brief club business discussion. New members especially welcome. Please bring water for your dogs and clean up after them.',
  now() - interval '8 days', now() - interval '8 days', :'founder_id')
returning id as dog_evt1_v \gset

insert into event_version_details (content_version_id, location, starts_at, ends_at, timezone, capacity)
values (:'dog_evt1_v', 'Riverside Park, Shelter #3',
  now() + interval '5 days' + interval '10 hours',
  now() + interval '5 days' + interval '13 hours',
  'America/New_York', 20);

-- dog_evt2: "Puppy Socialization Workshop" by Alice (past)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'alice_id', now() - interval '20 days', now() - interval '20 days')
returning id as dog_evt2_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'event', :'alice_id', :'dog_evt2_thread', now() - interval '20 days')
returning id as dog_evt2 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_evt2', 1, 'published',
  'Puppy Socialization Workshop',
  'Controlled introduction sessions for puppies under 6 months',
  'A structured socialization workshop for puppies. We''ll cover: proper greeting behavior, handling exercises, exposure to new surfaces and sounds, and supervised play. Limited to 8 puppies to ensure quality interactions.',
  now() - interval '20 days', now() - interval '20 days', :'alice_id')
returning id as dog_evt2_v \gset

insert into event_version_details (content_version_id, location, starts_at, ends_at, timezone, capacity)
values (:'dog_evt2_v', 'Alice''s Training Center, 42 Oak Street',
  now() - interval '10 days' + interval '9 hours',
  now() - interval '10 days' + interval '12 hours',
  'America/New_York', 8);

-- dog_post3: "Training Tips for Stubborn Breeds" by Ivan
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'dogclub_id', :'ivan_id', now() - interval '2 days', now() - interval '2 days')
returning id as dog_post3_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'post', :'ivan_id', :'dog_post3_thread', now() - interval '2 days')
returning id as dog_post3 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_post3', 1, 'published',
  'Training Tips for Stubborn Breeds',
  'What I learned photographing working dogs',
  'After spending hundreds of hours photographing working dogs on farms and in the field, I''ve picked up some training insights. Stubborn breeds aren''t actually stubborn — they''re independent thinkers bred for autonomous decision-making. Key tips: 1) Make training worth their while with high-value rewards. 2) Keep sessions short and varied. 3) Never repeat commands — say it once and wait. 4) Channel their drive into structured activities.',
  now() - interval '2 days', now() - interval '2 days', :'ivan_id');

-- Comments on dog_post1 (replies in dog_post1's thread)
insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'post', :'charlie_id', :'dog_post1_thread', now() - interval '13 days')
returning id as dog_cmt1 \gset

update content_threads set last_activity_at = now() - interval '13 days' where id = :'dog_post1_thread';

insert into content_versions (content_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'dog_cmt1', 1, 'published',
  'Great recap Alice! My husky Blizzard had such a blast in the agility ring. Third place felt like a win — those border collies are impossibly fast. Already training for next year!',
  now() - interval '13 days', now() - interval '13 days', :'charlie_id');

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'dogclub_id', 'post', :'founder_id', :'dog_post1_thread', now() - interval '13 days' + interval '2 hours')
returning id as dog_cmt2 \gset

update content_threads set last_activity_at = now() - interval '13 days' + interval '2 hours' where id = :'dog_post1_thread';

insert into content_versions (content_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'dog_cmt2', 1, 'published',
  'Fantastic write-up! The rescue dog showcase idea is brilliant. I''ll set up a planning thread — let''s make it happen for next year.',
  now() - interval '13 days' + interval '2 hours', now() - interval '13 days' + interval '2 hours', :'founder_id');

-- ============================================================
-- CatClub contents
-- ============================================================

-- cat_post1: "Understanding Feline Body Language" by Alice
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'alice_id', now() - interval '20 days', now() - interval '20 days')
returning id as cat_post1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'catclub_id', 'post', :'alice_id', :'cat_post1_thread', now() - interval '20 days')
returning id as cat_post1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_post1', 1, 'published',
  'Understanding Feline Body Language',
  'A dog trainer''s journey into decoding cat signals',
  'As a dog trainer who also loves cats, I''ve been studying feline body language. Key signals: slow blinks = trust and affection. Tail straight up = happy greeting. Ears back + dilated pupils = fear or aggression. Belly exposure does NOT always mean "pet me" unlike dogs. Tail twitching = overstimulation or hunting focus. Understanding these signals has transformed my relationship with my two rescue cats.',
  now() - interval '20 days', now() - interval '20 days', :'alice_id');

-- cat_post2: "Top Cat Toys of 2026" by Bob
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'bob_id', now() - interval '12 days', now() - interval '12 days')
returning id as cat_post2_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'catclub_id', 'post', :'bob_id', :'cat_post2_thread', now() - interval '12 days')
returning id as cat_post2 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_post2', 1, 'published',
  'Top Cat Toys of 2026',
  'Tested by 30+ shelter cats — here are the winners',
  'I''ve been testing toys at the shelter with our residents to find the best options. Top picks: 1) The Ripple Wand — irresistible to every cat. 2) Puzzle Feeder Pro — keeps them engaged for hours. 3) Crinkle Tunnel XL — even shy cats come out. 4) Solar Butterfly — autonomous toy that works when you''re away. 5) Catnip Kicker Deluxe — sturdy enough for the most aggressive bunny-kickers.',
  now() - interval '12 days', now() - interval '12 days', :'bob_id');

-- cat_opp1: "Cat Cafe Opening" by Diana
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'diana_id', now() - interval '8 days', now() - interval '8 days')
returning id as cat_opp1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'catclub_id', 'opportunity', :'diana_id', :'cat_opp1_thread', true, now() - interval '8 days')
returning id as cat_opp1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, expires_at, created_at, created_by_member_id)
values (:'cat_opp1', 1, 'published',
  'Cat Cafe Opening — Seeking Partners',
  'Looking for collaborators to open a rescue cat cafe downtown',
  'Planning to open a cat cafe that doubles as an adoption center. Looking for partners: 1) Business ops — food service or retail experience. 2) Cat welfare — a certified behaviorist to ensure cats thrive. 3) Marketing — social media is everything for cat cafes. Revenue model: cafe operations fund the rescue program.',
  now() - interval '8 days', now() + interval '52 days',
  now() - interval '8 days', :'diana_id');

-- cat_svc1: "Cat Sitting & Pet Care" by Bob
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'bob_id', now() - interval '15 days', now() - interval '15 days')
returning id as cat_svc1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'catclub_id', 'service', :'bob_id', :'cat_svc1_thread', true, now() - interval '15 days')
returning id as cat_svc1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_svc1', 1, 'published',
  'Cat Sitting & Pet Care',
  'Experienced cat care for when you''re away',
  'Offering reliable cat sitting for club members. Services: daily visits (feeding, litter, play), overnight stays, medication administration, multi-cat household management. Experience with special needs cats, seniors, and anxious cats. Club member discount: 15% off regular rates.',
  now() - interval '15 days', now() - interval '15 days', :'bob_id');

-- cat_ask1: "Help with a Shy Rescue Cat" by Julia
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'julia_id', now() - interval '4 days', now() - interval '4 days')
returning id as cat_ask1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'catclub_id', 'ask', :'julia_id', :'cat_ask1_thread', true, now() - interval '4 days')
returning id as cat_ask1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_ask1', 1, 'published',
  'Help with a Shy Rescue Cat',
  'New rescue cat hiding under the bed for two weeks straight',
  'I adopted a 3-year-old tabby two weeks ago and she hasn''t come out from under the bed except to eat when I''m not in the room. I''ve tried Feliway diffusers, leaving treats, sitting quietly nearby, and slow blinking. She doesn''t hiss but won''t make eye contact. Any behaviorists or experienced rescue parents have advice?',
  now() - interval '4 days', now() - interval '4 days', :'julia_id');

-- cat_evt1: "CatClub Virtual Q&A with a Vet" by Diana (future)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'diana_id', now() - interval '6 days', now() - interval '6 days')
returning id as cat_evt1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'catclub_id', 'event', :'diana_id', :'cat_evt1_thread', now() - interval '6 days')
returning id as cat_evt1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_evt1', 1, 'published',
  'CatClub Virtual Q&A with a Vet',
  'Live Q&A session — bring your cat health questions',
  'I''ll be hosting a live virtual Q&A covering common cat health concerns: dental health, weight management, senior cat care, and when to seek emergency care. Submit questions in advance or ask live.',
  now() - interval '6 days', now() - interval '6 days', :'diana_id')
returning id as cat_evt1_v \gset

insert into event_version_details (content_version_id, location, starts_at, ends_at, timezone)
values (:'cat_evt1_v', 'Zoom (link sent day of event)',
  now() + interval '3 days' + interval '19 hours',
  now() + interval '3 days' + interval '20 hours' + interval '30 minutes',
  'America/New_York');

-- Comment on cat_post1 by Bob (reply in cat_post1's thread)
insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'catclub_id', 'post', :'bob_id', :'cat_post1_thread', now() - interval '19 days')
returning id as cat_cmt1 \gset

update content_threads set last_activity_at = now() - interval '19 days' where id = :'cat_post1_thread';

insert into content_versions (content_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'cat_cmt1', 1, 'published',
  'The belly trap is so real! Our shelter cats teach new volunteers this lesson on day one. Great overview Alice — I''m sharing this with our foster families.',
  now() - interval '19 days', now() - interval '19 days', :'bob_id');

-- cat_spam: spam post by George (published then removed by admin Diana)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'catclub_id', :'george_id', now() - interval '16 days', now() - interval '16 days')
returning id as cat_spam_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'catclub_id', 'post', :'george_id', :'cat_spam_thread', now() - interval '16 days')
returning id as cat_spam \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_spam', 1, 'published',
  'CHECK OUT MY BIRD FEEDER STORE!!!',
  'Best bird feeders at unbeatable prices',
  'Visit my online store for amazing bird feeders! 50% off all models this week only! Free shipping! Buy now!',
  now() - interval '16 days', now() - interval '16 days', :'george_id');

-- Removal version (by admin Diana)
insert into content_versions (content_id, version_no, state, reason, effective_at, created_at, created_by_member_id)
values (:'cat_spam', 2, 'removed',
  'Promotional spam unrelated to the club. Please review our posting guidelines.',
  now() - interval '15 days', now() - interval '15 days', :'diana_id');

-- ============================================================
-- FoxClub contents
-- ============================================================

-- fox_post1: "Fox Conservation Update Q1 2026" by Bob
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'bob_id', now() - interval '18 days', now() - interval '18 days')
returning id as fox_post1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'post', :'bob_id', :'fox_post1_thread', now() - interval '18 days')
returning id as fox_post1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_post1', 1, 'published',
  'Fox Conservation Update Q1 2026',
  'Population trends, new research, and policy developments',
  'Quarterly conservation update. Urban fox populations remain stable. Key findings: 1) New denning sites in the industrial district — habitat corridors working. 2) Mange vaccination pilot shows 40% case reduction. 3) City council approved the green corridor extension. 4) Fiona''s PhD research cited in the new conservation policy draft. Full report attached to the activity feed.',
  now() - interval '18 days', now() - interval '18 days', :'bob_id');

-- fox_post2: "Wildlife Photography Tips & Tricks" by Charlie
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'charlie_id', now() - interval '9 days', now() - interval '9 days')
returning id as fox_post2_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'post', :'charlie_id', :'fox_post2_thread', now() - interval '9 days')
returning id as fox_post2 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_post2', 1, 'published',
  'Wildlife Photography Tips & Tricks',
  'Lessons from an amateur who learned from Ivan',
  'Ivan gave me some photography coaching during our fox census work and it changed everything. Tips for beginners: 1) Patience > equipment. 2) Learn the golden hour for your area. 3) Shoot from the animal''s eye level. 4) Use burst mode for action shots. 5) Don''t chase — let them come to you.',
  now() - interval '9 days', now() - interval '9 days', :'charlie_id');

-- fox_opp1: "Fox Sanctuary Volunteer Positions" by Morgan
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'founder_id', now() - interval '6 days', now() - interval '6 days')
returning id as fox_opp1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'foxclub_id', 'opportunity', :'founder_id', :'fox_opp1_thread', true, now() - interval '6 days')
returning id as fox_opp1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, expires_at, created_at, created_by_member_id)
values (:'fox_opp1', 1, 'published',
  'Fox Sanctuary Volunteer Positions',
  'Help at the local fox rescue and rehabilitation center',
  'The Woodland Fox Sanctuary needs volunteers. Roles: feeding and enrichment (mornings), enclosure maintenance (weekends), educational tour guides (Saturdays), transport for vet visits. Commitment: minimum 4 hours/week for 3 months. Training provided.',
  now() - interval '6 days', now() + interval '54 days',
  now() - interval '6 days', :'founder_id');

-- fox_svc1: "Wildlife Photography Workshops" by Charlie
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'charlie_id', now() - interval '14 days', now() - interval '14 days')
returning id as fox_svc1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'foxclub_id', 'service', :'charlie_id', :'fox_svc1_thread', true, now() - interval '14 days')
returning id as fox_svc1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_svc1', 1, 'published',
  'Wildlife Photography Workshops',
  'Field workshops in partnership with Ivan Tusks',
  'Hands-on wildlife photography workshops with professional photographer Ivan Tusks. Includes: dawn fox photography sessions, gear and settings masterclass, post-processing walkthrough, and ethical wildlife photography guidelines. Small groups of 4-6, all skill levels.',
  now() - interval '14 days', now() - interval '14 days', :'charlie_id');

-- fox_ask1: "Fox Sighting Tracking Apps?" by Ivan
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'ivan_id', now() - interval '5 days', now() - interval '5 days')
returning id as fox_ask1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, open_loop, created_at)
values (:'foxclub_id', 'ask', :'ivan_id', :'fox_ask1_thread', true, now() - interval '5 days')
returning id as fox_ask1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_ask1', 1, 'published',
  'Fox Sighting Tracking Apps?',
  'Looking for the best app to log and share fox sightings',
  'I want to systematically log fox sightings with GPS, timestamps, and photos. Ideally something that exports in a research-friendly format. I''ve tried iNaturalist but it''s too general. Anyone used something more specialized? Bonus if it supports collaborative mapping.',
  now() - interval '5 days', now() - interval '5 days', :'ivan_id');

-- fox_evt1: "Fox Watch Night Walk" by Morgan (future, capacity-limited)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'founder_id', now() - interval '5 days', now() - interval '5 days')
returning id as fox_evt1_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'event', :'founder_id', :'fox_evt1_thread', now() - interval '5 days')
returning id as fox_evt1 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_evt1', 1, 'published',
  'Fox Watch Night Walk',
  'Guided evening walk to observe urban foxes',
  'Guided night walk through the green corridor to observe urban foxes. We''ll cover fox behavior, identification, and ethical observation. Bring: quiet shoes, dark clothing, a red-light torch, and binoculars. Strictly limited to 10 people to minimize disturbance.',
  now() - interval '5 days', now() - interval '5 days', :'founder_id')
returning id as fox_evt1_v \gset

insert into event_version_details (content_version_id, location, starts_at, ends_at, timezone, capacity)
values (:'fox_evt1_v', 'Green Corridor Trailhead, North Entrance',
  now() + interval '7 days' + interval '20 hours',
  now() + interval '7 days' + interval '23 hours',
  'Europe/London', 10);

-- fox_evt2: "Annual Fox Census" by Bob (past)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'bob_id', now() - interval '30 days', now() - interval '30 days')
returning id as fox_evt2_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'event', :'bob_id', :'fox_evt2_thread', now() - interval '30 days')
returning id as fox_evt2 \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_evt2', 1, 'published',
  'Annual Fox Census Volunteer Day',
  'Help us count and map the local fox population',
  'Our annual census is the most important data event of the year. Volunteers split into teams of 2-3 and survey assigned quadrants. Training at 7am, field work 8am-4pm. All data feeds into the regional conservation database. Lunch provided. Last year: 47 individuals across 12 territories!',
  now() - interval '30 days', now() - interval '30 days', :'bob_id')
returning id as fox_evt2_v \gset

insert into event_version_details (content_version_id, location, starts_at, ends_at, timezone)
values (:'fox_evt2_v', 'Woodland Community Center',
  now() - interval '20 days' + interval '7 hours',
  now() - interval '20 days' + interval '16 hours',
  'Europe/London');

-- Comment on fox_post1 by Ivan (reply in fox_post1's thread)
insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'post', :'ivan_id', :'fox_post1_thread', now() - interval '17 days')
returning id as fox_cmt1 \gset

update content_threads set last_activity_at = now() - interval '17 days' where id = :'fox_post1_thread';

insert into content_versions (content_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'fox_cmt1', 1, 'published',
  'The mange vaccination results are incredible — 40% reduction is better than anyone predicted. I have photos showing the recovery of a vixen I''ve been tracking for two years. Happy to share at the next meetup.',
  now() - interval '17 days', now() - interval '17 days', :'ivan_id');

-- fox_draft: draft post by Ivan (unpublished)
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'ivan_id', now() - interval '1 day', now() - interval '1 day')
returning id as fox_draft_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'post', :'ivan_id', :'fox_draft_thread', now() - interval '1 day')
returning id as fox_draft \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_draft', 1, 'draft',
  'Preliminary Fox Migration Data — Spring 2026',
  'Early patterns from GPS collar tracking',
  'DRAFT — still compiling data from the last three collar downloads. Initial patterns suggest a shift in denning preference toward...',
  now() - interval '1 day', now() - interval '1 day', :'ivan_id');

-- fox_complaint: complaint by Fiona
insert into content_threads (club_id, created_by_member_id, last_activity_at, created_at)
values (:'foxclub_id', :'fiona_id', now() - interval '2 days', now() - interval '2 days')
returning id as fox_complaint_thread \gset

insert into contents (club_id, kind, author_member_id, thread_id, created_at)
values (:'foxclub_id', 'post', :'fiona_id', :'fox_complaint_thread', now() - interval '2 days')
returning id as fox_complaint \gset

insert into content_versions (content_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_complaint', 1, 'published',
  'Trail Damage from Last Census Event',
  'Some volunteer teams left marked trails through sensitive habitat',
  'During the last fox census, at least two volunteer teams went off designated paths and left visible trails through the denning area near quadrant 7. This could disturb vixens during cubbing season. Can we add a briefing about staying on paths and add GPS geofencing to the survey app?',
  now() - interval '2 days', now() - interval '2 days', :'fiona_id');

-- ============================================================
-- Event RSVPs
-- ============================================================

-- DogClub Monthly Meetup (dog_evt1)
insert into event_rsvps (event_content_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'dog_evt1', :'alice_dog_mid',   'yes',   1, :'alice_id',   now() - interval '6 days'),
  (:'dog_evt1', :'charlie_dog_mid', 'yes',   1, :'charlie_id', now() - interval '5 days'),
  (:'dog_evt1', :'eddie_dog_mid',   'maybe', 1, :'eddie_id',   now() - interval '4 days'),
  (:'dog_evt1', :'ivan_dog_mid',    'yes',   1, :'ivan_id',    now() - interval '3 days'),
  (:'dog_evt1', :'kevin_dog_mid',   'yes',   1, :'kevin_id',   now() - interval '2 days')
on conflict do nothing;

-- Puppy Socialization (dog_evt2) — past event
insert into event_rsvps (event_content_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'dog_evt2', :'alice_dog_mid',   'yes', 1, :'alice_id',   now() - interval '15 days'),
  (:'dog_evt2', :'charlie_dog_mid', 'no',  1, :'charlie_id', now() - interval '14 days')
on conflict do nothing;

-- CatClub Virtual Q&A (cat_evt1)
insert into event_rsvps (event_content_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'cat_evt1', :'alice_cat_mid',  'yes',   1, :'alice_id',  now() - interval '4 days'),
  (:'cat_evt1', :'bob_cat_mid',    'yes',   1, :'bob_id',    now() - interval '3 days'),
  (:'cat_evt1', :'julia_cat_mid',  'maybe', 1, :'julia_id',  now() - interval '2 days'),
  (:'cat_evt1', :'george_cat_mid', 'yes',   1, :'george_id', now() - interval '2 days')
on conflict do nothing;

-- Fox Watch Night Walk (fox_evt1) — capacity 10
insert into event_rsvps (event_content_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'fox_evt1', :'bob_fox_mid',     'yes',   1, :'bob_id',    now() - interval '4 days'),
  (:'fox_evt1', :'charlie_fox_mid', 'yes',   1, :'charlie_id', now() - interval '3 days'),
  (:'fox_evt1', :'fiona_fox_mid',   'yes',   1, :'fiona_id',  now() - interval '3 days'),
  (:'fox_evt1', :'ivan_fox_mid',    'maybe', 1, :'ivan_id',   now() - interval '2 days')
on conflict do nothing;

-- Fox Census (fox_evt2) — past event
insert into event_rsvps (event_content_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'fox_evt2', :'bob_fox_mid',     'yes', 1, :'bob_id',     now() - interval '25 days'),
  (:'fox_evt2', :'charlie_fox_mid', 'yes', 1, :'charlie_id', now() - interval '24 days'),
  (:'fox_evt2', :'ivan_fox_mid',    'yes', 1, :'ivan_id',    now() - interval '23 days')
on conflict do nothing;

-- ============================================================
-- Vouches (edges with kind='vouched_for')
-- ============================================================

insert into club_edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, created_at) values
  -- DogClub vouches
  (:'dogclub_id', 'vouched_for', :'alice_id',   :'charlie_id', 'Charlie is an incredible dog handler and trail guide. His huskies are the best-trained dogs I''ve seen.',             :'alice_id',   now() - interval '40 days'),
  (:'dogclub_id', 'vouched_for', :'charlie_id', :'alice_id',   'Alice transformed my reactive husky into a confident dog. Her training methods are outstanding.',                      :'charlie_id', now() - interval '40 days'),
  (:'dogclub_id', 'vouched_for', :'founder_id',    :'alice_id',   'Alice''s dedication to rescue dog rehabilitation is extraordinary. An invaluable member of our community.',              :'founder_id',    now() - interval '45 days'),
  (:'dogclub_id', 'vouched_for', :'founder_id',    :'ivan_id',    'Ivan''s wildlife photography gives us a unique perspective. Great addition to the club.',                                :'founder_id',    now() - interval '15 days'),
  (:'dogclub_id', 'vouched_for', :'alice_id',   :'kevin_id',   'Kevin runs an ethical breeding program. His Dalmatians are healthy and well-socialized.',                                :'alice_id',   now() - interval '4 days'),
  -- CatClub vouches
  (:'catclub_id', 'vouched_for', :'bob_id',     :'alice_id',   'Alice brings a refreshing dog-trainer perspective to cat behavior. Her cross-species insights are valuable.',            :'bob_id',     now() - interval '35 days'),
  (:'catclub_id', 'vouched_for', :'alice_id',   :'bob_id',     'Bob is the heart of the local rescue community. His shelter photography has helped hundreds of cats find homes.',         :'alice_id',   now() - interval '35 days'),
  (:'catclub_id', 'vouched_for', :'diana_id',   :'julia_id',   'Julia is a certified feline behaviorist with exceptional expertise in multi-cat dynamics.',                               :'diana_id',   now() - interval '14 days'),
  (:'catclub_id', 'vouched_for', :'alice_id',   :'diana_id',   'Diana''s free community vet clinics have helped so many pet owners. She''s an asset to every club she''s in.',             :'alice_id',   now() - interval '30 days'),
  (:'catclub_id', 'vouched_for', :'bob_id',     :'julia_id',   'Julia resolved a conflict between three cats in our shelter that had stumped everyone.',                                  :'bob_id',     now() - interval '12 days'),
  -- FoxClub vouches
  (:'foxclub_id', 'vouched_for', :'bob_id',     :'charlie_id', 'Charlie''s dedication to the fox census and trail maintenance makes him a cornerstone of our conservation efforts.',       :'bob_id',     now() - interval '30 days'),
  (:'foxclub_id', 'vouched_for', :'charlie_id', :'bob_id',     'Bob coordinates our conservation updates and keeps the entire club informed. Essential contributor.',                      :'charlie_id', now() - interval '30 days'),
  (:'foxclub_id', 'vouched_for', :'founder_id',    :'ivan_id',    'Ivan''s fox photography is published nationally. His visual documentation of our local population is vital.',               :'founder_id',    now() - interval '15 days'),
  (:'foxclub_id', 'vouched_for', :'bob_id',     :'fiona_id',   'Fiona''s PhD research on urban fox populations is groundbreaking. She brings real scientific rigor to our club.',           :'bob_id',     now() - interval '20 days'),
  (:'foxclub_id', 'vouched_for', :'charlie_id', :'ivan_id',    'Ivan taught me wildlife photography and his patience in the field is remarkable. Dedicated conservationist.',                :'charlie_id', now() - interval '10 days')
on conflict do nothing;

select set_config('app.allow_membership_state_sync', '1', true);

select set_config('app.allow_membership_state_sync', '', true);

-- ============================================================
-- Club activity log
-- ============================================================

insert into club_activity (club_id, topic, audience, payload, content_id, created_by_member_id, created_at) values
  -- DogClub
  (:'dogclub_id', 'content.version.published', 'members',    '{"kind":"service","title":"Professional Obedience Training"}'::jsonb,  :'dog_svc1',  :'alice_id',   now() - interval '21 days'),
  (:'dogclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Annual Dog Show 2026 Recap"}'::jsonb,          :'dog_post1', :'alice_id',   now() - interval '14 days'),
  (:'dogclub_id', 'content.version.published', 'members',    '{"kind":"opportunity","title":"Dog Walking Business Partnership"}'::jsonb, :'dog_opp1', :'founder_id',  now() - interval '10 days'),
  (:'dogclub_id', 'content.version.published', 'members',    '{"kind":"event","title":"DogClub Monthly Meetup - April"}'::jsonb,     :'dog_evt1',  :'founder_id',    now() - interval '8 days'),
  (:'dogclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Best Dog-Friendly Hiking Trails"}'::jsonb,     :'dog_post2', :'charlie_id', now() - interval '7 days'),
  (:'dogclub_id', 'membership.activated',     'clubadmins', '{"publicName":"Kevin Spots"}'::jsonb,                                    null,         :'founder_id',    now() - interval '5 days'),
  (:'dogclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Training Tips for Stubborn Breeds"}'::jsonb,    :'dog_post3', :'ivan_id',    now() - interval '2 days'),
  -- CatClub
  (:'catclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Understanding Feline Body Language"}'::jsonb,   :'cat_post1', :'alice_id',   now() - interval '20 days'),
  (:'catclub_id', 'content.removed',           'members',    '{"kind":"post","title":"CHECK OUT MY BIRD FEEDER STORE!!!","reason":"Promotional spam"}'::jsonb, :'cat_spam', :'diana_id', now() - interval '15 days'),
  (:'catclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Top Cat Toys of 2026"}'::jsonb,                 :'cat_post2', :'bob_id',     now() - interval '12 days'),
  (:'catclub_id', 'content.version.published', 'members',    '{"kind":"event","title":"CatClub Virtual Q&A with a Vet"}'::jsonb,     :'cat_evt1',  :'diana_id',   now() - interval '6 days'),
  -- FoxClub
  (:'foxclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Fox Conservation Update Q1 2026"}'::jsonb,      :'fox_post1', :'bob_id',     now() - interval '18 days'),
  (:'foxclub_id', 'content.version.published', 'members',    '{"kind":"service","title":"Wildlife Photography Workshops"}'::jsonb,    :'fox_svc1',  :'charlie_id', now() - interval '14 days'),
  (:'foxclub_id', 'content.version.published', 'members',    '{"kind":"post","title":"Wildlife Photography Tips & Tricks"}'::jsonb,   :'fox_post2', :'charlie_id', now() - interval '9 days'),
  (:'foxclub_id', 'content.version.published', 'members',    '{"kind":"event","title":"Fox Watch Night Walk"}'::jsonb,                :'fox_evt1',  :'founder_id',    now() - interval '5 days')
on conflict do nothing;

-- ============================================================
-- LLM usage log (content gate records)
-- ============================================================

insert into ai_llm_usage_log (member_id, requested_club_id, action_name, artifact_kind, provider, model, gate_status, prompt_tokens, completion_tokens, created_at) values
  (:'alice_id',   :'dogclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 320, 45, now() - interval '21 days'),
  (:'alice_id',   :'dogclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 410, 38, now() - interval '14 days'),
  (:'charlie_id', :'dogclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 350, 42, now() - interval '7 days'),
  (:'founder_id',    :'dogclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 290, 40, now() - interval '8 days'),
  (:'alice_id',   :'catclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 380, 44, now() - interval '20 days'),
  (:'bob_id',     :'catclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 340, 41, now() - interval '12 days'),
  (:'diana_id',   :'catclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 400, 48, now() - interval '8 days'),
  (:'bob_id',     :'foxclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 420, 50, now() - interval '18 days'),
  (:'ivan_id',    :'foxclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 260, 36, now() - interval '5 days'),
  (:'founder_id',    :'foxclub_id', 'content.create', 'content', 'openai', 'gpt-5.4-nano', 'passed', 310, 41, now() - interval '5 days'),
  (:'alice_id',   null,          'profile.update', 'profile', 'openai', 'gpt-5.4-nano', 'passed', 480, 55, now() - interval '25 days'),
  (:'founder_id',    null,          'profile.update', 'profile', 'openai', 'gpt-5.4-nano', 'passed', 520, 60, now() - interval '30 days')
on conflict do nothing;

-- ============================================================
-- API request log (authenticated POST /api telemetry)
-- ============================================================

insert into api_request_log (member_id, action_name, ip_address, created_at) values
  (:'alice_id', 'session.getContext', '203.0.113.10', now() - interval '6 days'),
  (:'alice_id', 'content.list',       '203.0.113.10', now() - interval '3 days'),
  (:'founder_id',  'clubadmin.members.list', '2001:db8::42', now() - interval '1 day')
on conflict do nothing;

-- ############################################################
-- MESSAGING DATA: threads, messages, inbox entries
-- ############################################################

-- ============================================================
-- Thread 1: Alice <-> Bob (6 messages about cat care)
-- Shared clubs: CatClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'alice_id',
  least(:'alice_id', :'bob_id'),
  greatest(:'alice_id', :'bob_id'),
  now() - interval '10 days')
returning id as t_alice_bob \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_alice_bob', :'alice_id', now() - interval '10 days'),
  (:'t_alice_bob', :'bob_id',   now() - interval '10 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'alice_id', 'member', 'Hey Bob! Have you tried that new grain-free cat food from the local co-op? My cats seem to love it.', now() - interval '10 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'bob_id', :'t_alice_bob', id, true, now() - interval '10 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'bob_id', 'member', 'Yes! We switched the shelter cats over last month. The coat quality improvement has been noticeable. Which variety are you using?', now() - interval '10 days' + interval '30 minutes')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'alice_id', :'t_alice_bob', id, true, now() - interval '10 days' + interval '30 minutes' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'alice_id', 'member', 'The salmon and sweet potato one. My older cat was a bit picky at first but came around after a few days.', now() - interval '9 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'bob_id', :'t_alice_bob', id, true, now() - interval '9 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'bob_id', 'member', 'Good to know. We''ve been using the turkey formula mostly. By the way, did you see Julia''s post about the shy rescue cat? Sounds like she could use some advice.', now() - interval '8 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'alice_id', :'t_alice_bob', id, true, now() - interval '8 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'alice_id', 'member', 'Yes, I commented on it. From my training experience, the key is patience and creating positive associations. Two weeks is still early for a fearful rescue cat.', now() - interval '7 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'bob_id', :'t_alice_bob', id, true, now() - interval '7 days' from msg;

-- Last message from Bob — unread by Alice
with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'bob_id', 'member', 'Totally agree. I was thinking we could offer to do a home visit together — your training eye plus my shelter experience might help Julia feel more confident. Want to reach out to her?', now() - interval '1 day')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'alice_id', :'t_alice_bob', id, false, now() - interval '1 day' from msg;

-- ============================================================
-- Thread 2: Alice <-> Charlie (3 messages about dog meetup)
-- Shared clubs: DogClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'alice_id',
  least(:'alice_id', :'charlie_id'),
  greatest(:'alice_id', :'charlie_id'),
  now() - interval '6 days')
returning id as t_alice_charlie \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_alice_charlie', :'alice_id',   now() - interval '6 days'),
  (:'t_alice_charlie', :'charlie_id', now() - interval '6 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_charlie', :'alice_id', 'member', 'Charlie, are you bringing all three huskies to the April meetup? I want to make sure we have enough space in the off-leash area.', now() - interval '6 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'charlie_id', :'t_alice_charlie', id, true, now() - interval '6 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_charlie', :'charlie_id', 'member', 'Yep, all three! Blizzard, Storm, and Aurora. They''ve been cooped up all week so they''ll be extra energetic. Should I bring the portable agility set?', now() - interval '5 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'alice_id', :'t_alice_charlie', id, true, now() - interval '5 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_charlie', :'alice_id', 'member', 'That would be perfect! Let''s set it up in the flat area near the picnic tables. See you there!', now() - interval '5 days' + interval '1 hour')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'charlie_id', :'t_alice_charlie', id, true, now() - interval '5 days' + interval '1 hour' from msg;

-- ============================================================
-- Thread 3: Bob <-> Charlie (1 message about fox sighting)
-- Shared clubs: FoxClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'bob_id',
  least(:'bob_id', :'charlie_id'),
  greatest(:'bob_id', :'charlie_id'),
  now() - interval '4 days')
returning id as t_bob_charlie \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_bob_charlie', :'bob_id',     now() - interval '4 days'),
  (:'t_bob_charlie', :'charlie_id', now() - interval '4 days');

-- Unread by Charlie
with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_bob_charlie', :'bob_id', 'member', 'Charlie, I spotted a vixen with three cubs near the old railway bridge this morning! First sighting in that area in two years. Might be worth checking with Ivan if he can get photos before the den gets disturbed.', now() - interval '4 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'charlie_id', :'t_bob_charlie', id, false, now() - interval '4 days' from msg;

-- ============================================================
-- Thread 4: Morgan <-> Alice (4 messages about club admin)
-- Shared clubs: DogClub, CatClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'founder_id',
  least(:'founder_id', :'alice_id'),
  greatest(:'founder_id', :'alice_id'),
  now() - interval '12 days')
returning id as t_founder_alice \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_founder_alice', :'founder_id',  now() - interval '12 days'),
  (:'t_founder_alice', :'alice_id', now() - interval '12 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_alice', :'founder_id', 'member', 'Alice, I''m thinking about making you a co-admin for DogClub. You''re already doing so much for the community. Would you be up for it?', now() - interval '12 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'alice_id', :'t_founder_alice', id, true, now() - interval '12 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_alice', :'alice_id', 'member', 'Morgan that''s really kind of you! I''d love to help out more. What would the responsibilities look like?', now() - interval '11 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'founder_id', :'t_founder_alice', id, true, now() - interval '11 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_alice', :'founder_id', 'member', 'Mainly reviewing new member applications and helping moderate content. You''d also be able to manage events and approve posts. I''ll handle the technical side.', now() - interval '11 days' + interval '2 hours')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'alice_id', :'t_founder_alice', id, true, now() - interval '11 days' + interval '2 hours' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_alice', :'alice_id', 'member', 'Sounds great, count me in! I''ll start by reviewing the pending applications this week.', now() - interval '10 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'founder_id', :'t_founder_alice', id, true, now() - interval '10 days' from msg;

-- ============================================================
-- Thread 5: Morgan <-> Bob (2 messages about fox conservation)
-- Shared clubs: CatClub, FoxClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'founder_id',
  least(:'founder_id', :'bob_id'),
  greatest(:'founder_id', :'bob_id'),
  now() - interval '7 days')
returning id as t_founder_bob \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_founder_bob', :'founder_id', now() - interval '7 days'),
  (:'t_founder_bob', :'bob_id',  now() - interval '7 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_bob', :'founder_id', 'member', 'Bob, that Q1 conservation update was excellent. Have you considered writing a monthly newsletter for the club? I think it would keep engagement up.', now() - interval '7 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'bob_id', :'t_founder_bob', id, true, now() - interval '7 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_bob', :'bob_id', 'member', 'Thanks Morgan! A monthly newsletter is a great idea. I could include sighting reports, conservation news, and member spotlights. Let me draft a template.', now() - interval '6 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'founder_id', :'t_founder_bob', id, true, now() - interval '6 days' from msg;

-- ============================================================
-- Thread 6: Diana <-> Julia (4 messages about cat rescue)
-- Shared clubs: CatClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'diana_id',
  least(:'diana_id', :'julia_id'),
  greatest(:'diana_id', :'julia_id'),
  now() - interval '5 days')
returning id as t_diana_julia \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_diana_julia', :'diana_id', now() - interval '5 days'),
  (:'t_diana_julia', :'julia_id', now() - interval '5 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'diana_id', 'member', 'Julia, I saw your post about the shy rescue cat. I''d be happy to do a free health check if you think stress might be a factor. Sometimes underlying pain makes cats hide.', now() - interval '5 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'julia_id', :'t_diana_julia', id, true, now() - interval '5 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'julia_id', 'member', 'That''s so generous, thank you Diana! The shelter said she was healthy but they were quite busy. I''d feel much better with a proper check from you.', now() - interval '4 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'diana_id', :'t_diana_julia', id, true, now() - interval '4 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'diana_id', 'member', 'Of course! I can come by this Saturday morning. In the meantime, try placing a worn t-shirt near her hiding spot — your scent helps build familiarity.', now() - interval '3 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'julia_id', :'t_diana_julia', id, true, now() - interval '3 days' from msg;

-- Unread by Diana
with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'julia_id', 'member', 'Saturday works perfectly! And I tried the t-shirt trick — she actually sniffed it this morning instead of running away. Small progress!', now() - interval '2 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'diana_id', :'t_diana_julia', id, false, now() - interval '2 days' from msg;

-- ============================================================
-- Thread 7: Ivan <-> Charlie (3 messages about wildlife photography)
-- Shared clubs: DogClub, FoxClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'ivan_id',
  least(:'ivan_id', :'charlie_id'),
  greatest(:'ivan_id', :'charlie_id'),
  now() - interval '8 days')
returning id as t_ivan_charlie \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_ivan_charlie', :'ivan_id',    now() - interval '8 days'),
  (:'t_ivan_charlie', :'charlie_id', now() - interval '8 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_ivan_charlie', :'ivan_id', 'member', 'Charlie, loved your photography tips post! You''re really progressing fast. Want to do a dawn session at the meadow this weekend? The foxes have been active there.', now() - interval '8 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'charlie_id', :'t_ivan_charlie', id, true, now() - interval '8 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_ivan_charlie', :'charlie_id', 'member', 'I''d love that! What time should I be there? And should I bring the 200mm or the 400mm?', now() - interval '7 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'ivan_id', :'t_ivan_charlie', id, true, now() - interval '7 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_ivan_charlie', :'ivan_id', 'member', 'Meet at 5:15am — we want to be set up before first light. Bring the 400mm, the foxes keep their distance at that spot. I''ll bring a hide cloth.', now() - interval '7 days' + interval '3 hours')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'charlie_id', :'t_ivan_charlie', id, true, now() - interval '7 days' + interval '3 hours' from msg;

-- ============================================================
-- Thread 8: Morgan <-> Diana (5 messages, one removed)
-- Shared clubs: DogClub, CatClub, FoxClub
-- ============================================================

insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'founder_id',
  least(:'founder_id', :'diana_id'),
  greatest(:'founder_id', :'diana_id'),
  now() - interval '9 days')
returning id as t_founder_diana \gset

insert into dm_thread_participants (thread_id, member_id, joined_at) values
  (:'t_founder_diana', :'founder_id',  now() - interval '9 days'),
  (:'t_founder_diana', :'diana_id', now() - interval '9 days');

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_diana', :'founder_id', 'member', 'Diana, thanks for handling the spam post removal so quickly. George seems like a good person but he needs to understand that CatClub isn''t a marketplace.', now() - interval '9 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'diana_id', :'t_founder_diana', id, true, now() - interval '9 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_diana', :'diana_id', 'member', 'Agreed. I sent him a friendly DM explaining the guidelines. He was apologetic. I think it was a genuine mistake — he''s very enthusiastic about his bird feeder business.', now() - interval '8 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'founder_id', :'t_founder_diana', id, true, now() - interval '8 days' from msg;

with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_diana', :'founder_id', 'member', 'Good call. On another topic — the cat cafe partnership you posted about sounds amazing. I might be interested in the vet welfare side. Can we chat about it?', now() - interval '7 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'diana_id', :'t_founder_diana', id, true, now() - interval '7 days' from msg;

-- This message will be removed
insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
values (:'t_founder_diana', :'founder_id', 'member', 'Oops, sent this to the wrong thread — ignore!', now() - interval '6 days')
returning id as removed_msg \gset

insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
values (:'diana_id', :'t_founder_diana', :'removed_msg', true, now() - interval '6 days');

insert into dm_message_removals (message_id, removed_by_member_id, reason, removed_at)
values (:'removed_msg', :'founder_id', 'Sent to wrong thread', now() - interval '6 days' + interval '1 minute');

-- Last message — unread by Morgan
with msg as (
  insert into dm_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_founder_diana', :'diana_id', 'member', 'Absolutely! I''d love to discuss the welfare protocols. I have some ideas about stress-free rotation schedules for the cats. Free Saturday afternoon?', now() - interval '3 days')
  returning id
)
insert into dm_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'founder_id', :'t_founder_diana', id, false, now() - interval '3 days' from msg;

commit;
