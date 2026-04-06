-- Local dev seed for the identity database.
-- Run as superuser (owen) against clawclub_identity_dev.
-- Tokens are created separately with src/token-cli.ts.

begin;

-- ============================================================
-- Members (12 active + 1 suspended)
-- ============================================================

insert into app.members (public_name, handle, state, created_at) values
  ('Owen Barnes',     'owen-barnes',     'active',    now() - interval '60 days'),
  ('Alice Hound',     'alice-hound',     'active',    now() - interval '50 days'),
  ('Bob Whiskers',    'bob-whiskers',    'active',    now() - interval '50 days'),
  ('Charlie Paws',    'charlie-paws',    'active',    now() - interval '50 days'),
  ('Diana Feathers',  'diana-feathers',  'active',    now() - interval '40 days'),
  ('Eddie Scales',    'eddie-scales',    'active',    now() - interval '40 days'),
  ('Fiona Hooves',    'fiona-hooves',    'active',    now() - interval '30 days'),
  ('George Wings',    'george-wings',    'active',    now() - interval '30 days'),
  ('Hannah Fins',     'hannah-fins',     'active',    now() - interval '20 days'),
  ('Ivan Tusks',      'ivan-tusks',      'active',    now() - interval '20 days'),
  ('Julia Stripes',   'julia-stripes',   'active',    now() - interval '20 days'),
  ('Kevin Spots',     'kevin-spots',     'active',    now() - interval '5 days'),
  ('Sam Shadow',      'sam-shadow',      'suspended', now() - interval '45 days')
on conflict (handle) do nothing;

select id as owen_id    from app.members where handle = 'owen-barnes' \gset
select id as alice_id   from app.members where handle = 'alice-hound' \gset
select id as bob_id     from app.members where handle = 'bob-whiskers' \gset
select id as charlie_id from app.members where handle = 'charlie-paws' \gset
select id as diana_id   from app.members where handle = 'diana-feathers' \gset
select id as eddie_id   from app.members where handle = 'eddie-scales' \gset
select id as fiona_id   from app.members where handle = 'fiona-hooves' \gset
select id as george_id  from app.members where handle = 'george-wings' \gset
select id as hannah_id  from app.members where handle = 'hannah-fins' \gset
select id as ivan_id    from app.members where handle = 'ivan-tusks' \gset
select id as julia_id   from app.members where handle = 'julia-stripes' \gset
select id as kevin_id   from app.members where handle = 'kevin-spots' \gset
select id as sam_id     from app.members where handle = 'sam-shadow' \gset

-- ============================================================
-- Member profiles (rich data for all members)
-- ============================================================

insert into app.member_profile_versions
  (member_id, version_no, display_name, tagline, summary, what_i_do, known_for, services_summary, website_url, links, created_by_member_id, created_at)
values
  -- Owen v1 (initial)
  (:'owen_id', 1, 'Owen', 'Platform founder', 'Founded ClawClub to connect animal lovers.', 'Community building', 'Starting ClawClub', null, null, '[]'::jsonb, :'owen_id', now() - interval '60 days'),
  -- Owen v2 (updated, rich profile)
  (:'owen_id', 2, 'Owen Barnes', 'Platform founder & community builder', 'Founder of ClawClub — an agent-first platform connecting animal enthusiasts. Building the future of professional communities through technology.', 'Platform architecture, community ops, partnership development', 'Creating ClawClub, pioneering agent-first community platforms', 'Platform consulting, API integrations, community strategy', 'https://owenbarnes.example.com', '[{"label":"Twitter","url":"https://twitter.com/owenbarnes"},{"label":"GitHub","url":"https://github.com/owenbarnes"},{"label":"LinkedIn","url":"https://linkedin.com/in/owenbarnes"}]'::jsonb, :'owen_id', now() - interval '30 days'),

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

-- ============================================================
-- Private contacts (emails for some members)
-- ============================================================

insert into app.member_private_contacts (member_id, email, created_at) values
  (:'owen_id',   'owen@clawclub.example.com',     now() - interval '60 days'),
  (:'alice_id',  'alice@alicehound.example.com',   now() - interval '50 days'),
  (:'diana_id',  'diana@drdianafeathers.example.com', now() - interval '40 days'),
  (:'ivan_id',   'ivan@ivantusks.example.com',     now() - interval '20 days'),
  (:'julia_id',  'julia@juliastripes.example.com', now() - interval '20 days')
on conflict do nothing;

-- ============================================================
-- Global roles (Owen is superadmin)
-- ============================================================

insert into app.member_global_role_versions
  (member_id, role, status, version_no, created_by_member_id, created_at)
values
  (:'owen_id', 'superadmin', 'active', 1, :'owen_id', now() - interval '60 days')
on conflict do nothing;

-- ============================================================
-- Clubs (3 clubs with admission policies)
-- ============================================================

insert into app.clubs (slug, name, owner_member_id, summary, created_at) values
  ('dogclub', 'DogClub', :'owen_id', 'A club for dog lovers and canine professionals.', now() - interval '58 days'),
  ('catclub', 'CatClub', :'owen_id', 'A club for cat enthusiasts and feline experts.',   now() - interval '58 days'),
  ('foxclub', 'FoxClub', :'owen_id', 'A club for wildlife enthusiasts focused on foxes.', now() - interval '58 days')
on conflict (slug) do nothing;

select id as dogclub_id from app.clubs where slug = 'dogclub' \gset
select id as catclub_id from app.clubs where slug = 'catclub' \gset
select id as foxclub_id from app.clubs where slug = 'foxclub' \gset

-- Club versions (with admission policies)
insert into app.club_versions
  (club_id, owner_member_id, name, summary, admission_policy, version_no, created_by_member_id, created_at)
values
  (:'dogclub_id', :'owen_id', 'DogClub', 'A club for dog lovers and canine professionals.',
   'Members must demonstrate genuine passion for dogs and canine welfare. We welcome trainers, breeders, vets, groomers, and devoted dog owners. Applicants should share how they contribute to the dog community.',
   1, :'owen_id', now() - interval '58 days'),
  (:'catclub_id', :'owen_id', 'CatClub', 'A club for cat enthusiasts and feline experts.',
   'We welcome cat enthusiasts who contribute positively to feline communities. Preference given to rescue volunteers, veterinary professionals, and behaviorists. Tell us about your cats and your involvement.',
   1, :'owen_id', now() - interval '58 days'),
  (:'foxclub_id', :'owen_id', 'FoxClub', 'A club for wildlife enthusiasts focused on foxes.',
   'Open to wildlife enthusiasts with a focus on fox conservation and education. We value researchers, photographers, and conservationists. Describe your connection to wildlife and foxes specifically.',
   1, :'owen_id', now() - interval '58 days')
on conflict do nothing;

-- Club routing (all clubs → shard 1)
insert into app.club_routing (club_id) values
  (:'dogclub_id'), (:'catclub_id'), (:'foxclub_id')
on conflict do nothing;

-- ============================================================
-- Memberships
-- ============================================================

-- Owen: clubadmin of all three
insert into app.club_memberships (club_id, member_id, role, joined_at) values
  (:'dogclub_id', :'owen_id', 'clubadmin', now() - interval '58 days'),
  (:'catclub_id', :'owen_id', 'clubadmin', now() - interval '58 days'),
  (:'foxclub_id', :'owen_id', 'clubadmin', now() - interval '58 days')
on conflict (club_id, member_id) do nothing;

-- Alice: member of DogClub and CatClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'alice_id', 'member', :'owen_id', now() - interval '50 days'),
  (:'catclub_id', :'alice_id', 'member', :'owen_id', now() - interval '50 days')
on conflict (club_id, member_id) do nothing;

-- Bob: member of CatClub and FoxClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'catclub_id', :'bob_id', 'member', :'owen_id', now() - interval '50 days'),
  (:'foxclub_id', :'bob_id', 'member', :'owen_id', now() - interval '50 days')
on conflict (club_id, member_id) do nothing;

-- Charlie: member of DogClub and FoxClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'charlie_id', 'member', :'owen_id', now() - interval '50 days'),
  (:'foxclub_id', :'charlie_id', 'member', :'owen_id', now() - interval '50 days')
on conflict (club_id, member_id) do nothing;

-- Diana: member of DogClub and FoxClub, clubadmin of CatClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'diana_id', 'member', :'owen_id', now() - interval '40 days'),
  (:'foxclub_id', :'diana_id', 'member', :'owen_id', now() - interval '40 days')
on conflict (club_id, member_id) do nothing;
insert into app.club_memberships (club_id, member_id, role, joined_at) values
  (:'catclub_id', :'diana_id', 'clubadmin', now() - interval '40 days')
on conflict (club_id, member_id) do nothing;

-- Eddie: member of DogClub (active) and CatClub (will be paused)
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'eddie_id', 'member', :'alice_id', now() - interval '38 days'),
  (:'catclub_id', :'eddie_id', 'member', :'alice_id', now() - interval '38 days')
on conflict (club_id, member_id) do nothing;

-- Fiona: member of FoxClub (active) and DogClub (invited, not yet accepted)
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'foxclub_id', :'fiona_id', 'member', :'bob_id',   now() - interval '28 days'),
  (:'dogclub_id', :'fiona_id', 'member', :'alice_id', now() - interval '7 days')
on conflict (club_id, member_id) do nothing;

-- George: member of CatClub (active) and FoxClub (removed)
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'catclub_id', :'george_id', 'member', :'bob_id',  now() - interval '28 days'),
  (:'foxclub_id', :'george_id', 'member', :'bob_id',  now() - interval '28 days')
on conflict (club_id, member_id) do nothing;

-- Hannah: member of DogClub (pending_review)
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'hannah_id', 'member', :'charlie_id', now() - interval '3 days')
on conflict (club_id, member_id) do nothing;

-- Ivan: member of DogClub and FoxClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'ivan_id', 'member', :'charlie_id', now() - interval '18 days'),
  (:'foxclub_id', :'ivan_id', 'member', :'charlie_id', now() - interval '18 days')
on conflict (club_id, member_id) do nothing;

-- Julia: member of CatClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'catclub_id', :'julia_id', 'member', :'diana_id', now() - interval '15 days')
on conflict (club_id, member_id) do nothing;

-- Kevin: member of DogClub (recently accepted via admission)
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'kevin_id', 'member', :'owen_id', now() - interval '5 days')
on conflict (club_id, member_id) do nothing;

-- Sam: member of DogClub and CatClub (both will be revoked)
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, joined_at) values
  (:'dogclub_id', :'sam_id', 'member', :'owen_id', now() - interval '44 days'),
  (:'catclub_id', :'sam_id', 'member', :'owen_id', now() - interval '44 days')
on conflict (club_id, member_id) do nothing;

-- Capture all membership IDs
select id as owen_dog_mid    from app.club_memberships where club_id = :'dogclub_id' and member_id = :'owen_id' \gset
select id as owen_cat_mid    from app.club_memberships where club_id = :'catclub_id' and member_id = :'owen_id' \gset
select id as owen_fox_mid    from app.club_memberships where club_id = :'foxclub_id' and member_id = :'owen_id' \gset
select id as alice_dog_mid   from app.club_memberships where club_id = :'dogclub_id' and member_id = :'alice_id' \gset
select id as alice_cat_mid   from app.club_memberships where club_id = :'catclub_id' and member_id = :'alice_id' \gset
select id as bob_cat_mid     from app.club_memberships where club_id = :'catclub_id' and member_id = :'bob_id' \gset
select id as bob_fox_mid     from app.club_memberships where club_id = :'foxclub_id' and member_id = :'bob_id' \gset
select id as charlie_dog_mid from app.club_memberships where club_id = :'dogclub_id' and member_id = :'charlie_id' \gset
select id as charlie_fox_mid from app.club_memberships where club_id = :'foxclub_id' and member_id = :'charlie_id' \gset
select id as diana_dog_mid   from app.club_memberships where club_id = :'dogclub_id' and member_id = :'diana_id' \gset
select id as diana_cat_mid   from app.club_memberships where club_id = :'catclub_id' and member_id = :'diana_id' \gset
select id as diana_fox_mid   from app.club_memberships where club_id = :'foxclub_id' and member_id = :'diana_id' \gset
select id as eddie_dog_mid   from app.club_memberships where club_id = :'dogclub_id' and member_id = :'eddie_id' \gset
select id as eddie_cat_mid   from app.club_memberships where club_id = :'catclub_id' and member_id = :'eddie_id' \gset
select id as fiona_fox_mid   from app.club_memberships where club_id = :'foxclub_id' and member_id = :'fiona_id' \gset
select id as fiona_dog_mid   from app.club_memberships where club_id = :'dogclub_id' and member_id = :'fiona_id' \gset
select id as george_cat_mid  from app.club_memberships where club_id = :'catclub_id' and member_id = :'george_id' \gset
select id as george_fox_mid  from app.club_memberships where club_id = :'foxclub_id' and member_id = :'george_id' \gset
select id as hannah_dog_mid  from app.club_memberships where club_id = :'dogclub_id' and member_id = :'hannah_id' \gset
select id as ivan_dog_mid    from app.club_memberships where club_id = :'dogclub_id' and member_id = :'ivan_id' \gset
select id as ivan_fox_mid    from app.club_memberships where club_id = :'foxclub_id' and member_id = :'ivan_id' \gset
select id as julia_cat_mid   from app.club_memberships where club_id = :'catclub_id' and member_id = :'julia_id' \gset
select id as kevin_dog_mid   from app.club_memberships where club_id = :'dogclub_id' and member_id = :'kevin_id' \gset
select id as sam_dog_mid     from app.club_memberships where club_id = :'dogclub_id' and member_id = :'sam_id' \gset
select id as sam_cat_mid     from app.club_memberships where club_id = :'catclub_id' and member_id = :'sam_id' \gset

-- ============================================================
-- Membership state versions
-- ============================================================

-- Round 1: initial states for all memberships
insert into app.club_membership_state_versions
  (membership_id, status, reason, version_no, created_by_member_id, created_at)
values
  -- Owen (clubadmin, active)
  (:'owen_dog_mid', 'active', 'founder',  1, :'owen_id', now() - interval '58 days'),
  (:'owen_cat_mid', 'active', 'founder',  1, :'owen_id', now() - interval '58 days'),
  (:'owen_fox_mid', 'active', 'founder',  1, :'owen_id', now() - interval '58 days'),
  -- Alice (active)
  (:'alice_dog_mid', 'active', 'seed',    1, :'owen_id', now() - interval '50 days'),
  (:'alice_cat_mid', 'active', 'seed',    1, :'owen_id', now() - interval '50 days'),
  -- Bob (active)
  (:'bob_cat_mid',   'active', 'seed',    1, :'owen_id', now() - interval '50 days'),
  (:'bob_fox_mid',   'active', 'seed',    1, :'owen_id', now() - interval '50 days'),
  -- Charlie (active)
  (:'charlie_dog_mid', 'active', 'seed',  1, :'owen_id', now() - interval '50 days'),
  (:'charlie_fox_mid', 'active', 'seed',  1, :'owen_id', now() - interval '50 days'),
  -- Diana (active)
  (:'diana_dog_mid', 'active', 'seed',    1, :'owen_id', now() - interval '40 days'),
  (:'diana_cat_mid', 'active', 'seed',    1, :'owen_id', now() - interval '40 days'),
  (:'diana_fox_mid', 'active', 'seed',    1, :'owen_id', now() - interval '40 days'),
  -- Eddie (both start active; CatClub will be paused in round 2)
  (:'eddie_dog_mid', 'active', 'seed',    1, :'owen_id', now() - interval '38 days'),
  (:'eddie_cat_mid', 'active', 'seed',    1, :'owen_id', now() - interval '38 days'),
  -- Fiona: FoxClub active, DogClub invited
  (:'fiona_fox_mid', 'active', 'seed',    1, :'owen_id', now() - interval '28 days'),
  (:'fiona_dog_mid', 'invited', null,     1, :'alice_id', now() - interval '7 days'),
  -- George: CatClub active, FoxClub starts active (removed in round 2)
  (:'george_cat_mid', 'active', 'seed',   1, :'owen_id', now() - interval '28 days'),
  (:'george_fox_mid', 'active', 'seed',   1, :'owen_id', now() - interval '28 days'),
  -- Hannah: pending_review
  (:'hannah_dog_mid', 'pending_review', null, 1, :'charlie_id', now() - interval '3 days'),
  -- Ivan (active)
  (:'ivan_dog_mid',  'active', 'seed',    1, :'owen_id', now() - interval '18 days'),
  (:'ivan_fox_mid',  'active', 'seed',    1, :'owen_id', now() - interval '18 days'),
  -- Julia (active)
  (:'julia_cat_mid', 'active', 'seed',    1, :'diana_id', now() - interval '15 days'),
  -- Kevin (active, admitted)
  (:'kevin_dog_mid', 'active', 'admitted via owner nomination', 1, :'owen_id', now() - interval '5 days'),
  -- Sam (both start active; revoked in round 2)
  (:'sam_dog_mid',   'active', 'seed',    1, :'owen_id', now() - interval '44 days'),
  (:'sam_cat_mid',   'active', 'seed',    1, :'owen_id', now() - interval '44 days')
on conflict do nothing;

-- Round 2: state transitions
insert into app.club_membership_state_versions
  (membership_id, status, reason, version_no, created_by_member_id, created_at)
values
  -- Eddie paused in CatClub (unpaid dues)
  (:'eddie_cat_mid', 'paused', 'Membership paused due to unpaid subscription', 2, :'owen_id', now() - interval '10 days'),
  -- George removed from FoxClub (posted inappropriate content)
  (:'george_fox_mid', 'removed', 'Repeated posting of off-topic content after warnings', 2, :'owen_id', now() - interval '14 days'),
  -- Sam revoked from both clubs (suspended from platform)
  (:'sam_dog_mid', 'revoked', 'Account suspended — platform policy violation', 2, :'owen_id', now() - interval '30 days'),
  (:'sam_cat_mid', 'revoked', 'Account suspended — platform policy violation', 2, :'owen_id', now() - interval '30 days')
on conflict do nothing;

-- ============================================================
-- Subscriptions
-- ============================================================

insert into app.subscriptions
  (membership_id, payer_member_id, status, amount, currency, started_at, current_period_end)
values
  -- Alice (comped by Owen)
  (:'alice_dog_mid', :'owen_id', 'active', 0, 'USD', now() - interval '50 days', null),
  (:'alice_cat_mid', :'owen_id', 'active', 0, 'USD', now() - interval '50 days', null),
  -- Bob (self-paid, real amount)
  (:'bob_cat_mid', :'bob_id', 'active', 29, 'USD', now() - interval '50 days', now() + interval '11 days'),
  (:'bob_fox_mid', :'bob_id', 'active', 29, 'USD', now() - interval '50 days', now() + interval '11 days'),
  -- Charlie (comped by Owen)
  (:'charlie_dog_mid', :'owen_id', 'active', 0, 'USD', now() - interval '50 days', null),
  (:'charlie_fox_mid', :'owen_id', 'active', 0, 'USD', now() - interval '50 days', null),
  -- Diana: DogClub and FoxClub (self-paid)
  (:'diana_dog_mid', :'diana_id', 'active', 29, 'USD', now() - interval '40 days', now() + interval '21 days'),
  (:'diana_fox_mid', :'diana_id', 'active', 29, 'USD', now() - interval '40 days', now() + interval '21 days'),
  -- Eddie: DogClub active, CatClub past_due
  (:'eddie_dog_mid', :'eddie_id', 'active',   29, 'USD', now() - interval '38 days', now() + interval '23 days'),
  (:'eddie_cat_mid', :'eddie_id', 'past_due', 29, 'USD', now() - interval '38 days', now() - interval '3 days'),
  -- Fiona: FoxClub active (DogClub invited, no subscription)
  (:'fiona_fox_mid', :'fiona_id', 'active', 29, 'USD', now() - interval '28 days', now() + interval '2 days'),
  -- George: CatClub active, FoxClub canceled
  (:'george_cat_mid', :'george_id', 'active',   29, 'USD', now() - interval '28 days', now() + interval '2 days'),
  (:'george_fox_mid', :'george_id', 'canceled', 29, 'USD', now() - interval '28 days', now() - interval '14 days'),
  -- Ivan (comped by Owen)
  (:'ivan_dog_mid', :'owen_id', 'active', 0, 'USD', now() - interval '18 days', null),
  (:'ivan_fox_mid', :'owen_id', 'active', 0, 'USD', now() - interval '18 days', null),
  -- Julia (trialing)
  (:'julia_cat_mid', :'julia_id', 'trialing', 29, 'USD', now() - interval '15 days', now() + interval '15 days'),
  -- Kevin (comped by Owen, recently admitted)
  (:'kevin_dog_mid', :'owen_id', 'active', 0, 'USD', now() - interval '5 days', null),
  -- Sam (ended)
  (:'sam_dog_mid', :'sam_id', 'ended', 29, 'USD', now() - interval '44 days', now() - interval '30 days'),
  (:'sam_cat_mid', :'sam_id', 'ended', 29, 'USD', now() - interval '44 days', now() - interval '30 days')
on conflict do nothing;

commit;
