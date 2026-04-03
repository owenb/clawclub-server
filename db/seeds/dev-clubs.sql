-- Local dev seed: DogClub, CatClub, FoxClub
-- Run as superuser (owen) against clawclub_dev.
-- Tokens must be created separately with src/token-cli.ts.

alter table app.subscriptions disable row level security;

begin;

-- Owner
insert into app.members (public_name, handle, state) values ('Owen Barnes', 'owen-barnes', 'active')
on conflict (handle) do nothing;
select id as owen_id from app.members where handle = 'owen-barnes' \gset

-- Test members
insert into app.members (public_name, handle, state) values ('Alice Hound', 'alice-hound', 'active')
on conflict (handle) do nothing;
insert into app.members (public_name, handle, state) values ('Bob Whiskers', 'bob-whiskers', 'active')
on conflict (handle) do nothing;
insert into app.members (public_name, handle, state) values ('Charlie Paws', 'charlie-paws', 'active')
on conflict (handle) do nothing;
select id as alice_id from app.members where handle = 'alice-hound' \gset
select id as bob_id from app.members where handle = 'bob-whiskers' \gset
select id as charlie_id from app.members where handle = 'charlie-paws' \gset

-- Profiles
insert into app.member_profile_versions (member_id, version_no, display_name, created_by_member_id) values
  (:'owen_id', 1, 'Owen', :'owen_id'),
  (:'alice_id', 1, 'Alice', :'alice_id'),
  (:'bob_id', 1, 'Bob', :'bob_id'),
  (:'charlie_id', 1, 'Charlie', :'charlie_id')
on conflict do nothing;

-- Three clubs, all owned by Owen
insert into app.clubs (slug, name, owner_member_id, summary) values
  ('dogclub', 'DogClub', :'owen_id', 'A club for dog lovers.'),
  ('catclub', 'CatClub', :'owen_id', 'A club for cat lovers.'),
  ('foxclub', 'FoxClub', :'owen_id', 'A club for fox lovers.')
on conflict (slug) do nothing;
select id as dogclub_id from app.clubs where slug = 'dogclub' \gset
select id as catclub_id from app.clubs where slug = 'catclub' \gset
select id as foxclub_id from app.clubs where slug = 'foxclub' \gset

-- Owen: owner of all three
insert into app.club_memberships (club_id, member_id, role) values
  (:'dogclub_id', :'owen_id', 'owner'),
  (:'catclub_id', :'owen_id', 'owner'),
  (:'foxclub_id', :'owen_id', 'owner')
on conflict (club_id, member_id) do nothing;
select id as owen_dog_mid from app.club_memberships where club_id = :'dogclub_id' and member_id = :'owen_id' \gset
select id as owen_cat_mid from app.club_memberships where club_id = :'catclub_id' and member_id = :'owen_id' \gset
select id as owen_fox_mid from app.club_memberships where club_id = :'foxclub_id' and member_id = :'owen_id' \gset
insert into app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id) values
  (:'owen_dog_mid', 'active', 'seed', 1, :'owen_id'),
  (:'owen_cat_mid', 'active', 'seed', 1, :'owen_id'),
  (:'owen_fox_mid', 'active', 'seed', 1, :'owen_id')
on conflict do nothing;

-- Alice: member of DogClub and CatClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id) values
  (:'dogclub_id', :'alice_id', 'member', :'owen_id'),
  (:'catclub_id', :'alice_id', 'member', :'owen_id')
on conflict (club_id, member_id) do nothing;
select id as alice_dog_mid from app.club_memberships where club_id = :'dogclub_id' and member_id = :'alice_id' \gset
select id as alice_cat_mid from app.club_memberships where club_id = :'catclub_id' and member_id = :'alice_id' \gset
insert into app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id) values
  (:'alice_dog_mid', 'active', 'seed', 1, :'owen_id'),
  (:'alice_cat_mid', 'active', 'seed', 1, :'owen_id')
on conflict do nothing;
insert into app.subscriptions (membership_id, payer_member_id, status, amount, currency) values
  (:'alice_dog_mid', :'owen_id', 'active', 0, 'GBP'),
  (:'alice_cat_mid', :'owen_id', 'active', 0, 'GBP')
on conflict do nothing;

-- Bob: member of CatClub and FoxClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id) values
  (:'catclub_id', :'bob_id', 'member', :'owen_id'),
  (:'foxclub_id', :'bob_id', 'member', :'owen_id')
on conflict (club_id, member_id) do nothing;
select id as bob_cat_mid from app.club_memberships where club_id = :'catclub_id' and member_id = :'bob_id' \gset
select id as bob_fox_mid from app.club_memberships where club_id = :'foxclub_id' and member_id = :'bob_id' \gset
insert into app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id) values
  (:'bob_cat_mid', 'active', 'seed', 1, :'owen_id'),
  (:'bob_fox_mid', 'active', 'seed', 1, :'owen_id')
on conflict do nothing;
insert into app.subscriptions (membership_id, payer_member_id, status, amount, currency) values
  (:'bob_cat_mid', :'owen_id', 'active', 0, 'GBP'),
  (:'bob_fox_mid', :'owen_id', 'active', 0, 'GBP')
on conflict do nothing;

-- Charlie: member of DogClub and FoxClub
insert into app.club_memberships (club_id, member_id, role, sponsor_member_id) values
  (:'dogclub_id', :'charlie_id', 'member', :'owen_id'),
  (:'foxclub_id', :'charlie_id', 'member', :'owen_id')
on conflict (club_id, member_id) do nothing;
select id as charlie_dog_mid from app.club_memberships where club_id = :'dogclub_id' and member_id = :'charlie_id' \gset
select id as charlie_fox_mid from app.club_memberships where club_id = :'foxclub_id' and member_id = :'charlie_id' \gset
insert into app.club_membership_state_versions (membership_id, status, reason, version_no, created_by_member_id) values
  (:'charlie_dog_mid', 'active', 'seed', 1, :'owen_id'),
  (:'charlie_fox_mid', 'active', 'seed', 1, :'owen_id')
on conflict do nothing;
insert into app.subscriptions (membership_id, payer_member_id, status, amount, currency) values
  (:'charlie_dog_mid', :'owen_id', 'active', 0, 'GBP'),
  (:'charlie_fox_mid', :'owen_id', 'active', 0, 'GBP')
on conflict do nothing;

commit;

alter table app.subscriptions enable row level security;
alter table app.subscriptions force row level security;
