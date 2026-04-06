-- Messaging database seed for local dev.
-- Run as superuser against clawclub_messaging_dev.
-- Expects psql variables for cross-database member IDs (member_*).

begin;

-- ============================================================
-- Thread 1: Alice <-> Bob (6 messages about cat care)
-- Shared clubs: CatClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_alice_hound',
  least(:'member_alice_hound', :'member_bob_whiskers'),
  greatest(:'member_alice_hound', :'member_bob_whiskers'),
  now() - interval '10 days')
returning id as t_alice_bob \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_alice_bob', :'member_alice_hound',  now() - interval '10 days'),
  (:'t_alice_bob', :'member_bob_whiskers', now() - interval '10 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'member_alice_hound', 'member', 'Hey Bob! Have you tried that new grain-free cat food from the local co-op? My cats seem to love it.', now() - interval '10 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_bob_whiskers', :'t_alice_bob', id, true, now() - interval '10 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'member_bob_whiskers', 'member', 'Yes! We switched the shelter cats over last month. The coat quality improvement has been noticeable. Which variety are you using?', now() - interval '10 days' + interval '30 minutes')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_alice_hound', :'t_alice_bob', id, true, now() - interval '10 days' + interval '30 minutes' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'member_alice_hound', 'member', 'The salmon and sweet potato one. My older cat was a bit picky at first but came around after a few days.', now() - interval '9 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_bob_whiskers', :'t_alice_bob', id, true, now() - interval '9 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'member_bob_whiskers', 'member', 'Good to know. We''ve been using the turkey formula mostly. By the way, did you see Julia''s post about the shy rescue cat? Sounds like she could use some advice.', now() - interval '8 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_alice_hound', :'t_alice_bob', id, true, now() - interval '8 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'member_alice_hound', 'member', 'Yes, I commented on it. From my training experience, the key is patience and creating positive associations. Two weeks is still early for a fearful rescue cat.', now() - interval '7 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_bob_whiskers', :'t_alice_bob', id, true, now() - interval '7 days' from msg;

-- Last message from Bob — unread by Alice
with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_bob', :'member_bob_whiskers', 'member', 'Totally agree. I was thinking we could offer to do a home visit together — your training eye plus my shelter experience might help Julia feel more confident. Want to reach out to her?', now() - interval '1 day')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_alice_hound', :'t_alice_bob', id, false, now() - interval '1 day' from msg;

-- ============================================================
-- Thread 2: Alice <-> Charlie (3 messages about dog meetup)
-- Shared clubs: DogClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_alice_hound',
  least(:'member_alice_hound', :'member_charlie_paws'),
  greatest(:'member_alice_hound', :'member_charlie_paws'),
  now() - interval '6 days')
returning id as t_alice_charlie \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_alice_charlie', :'member_alice_hound',  now() - interval '6 days'),
  (:'t_alice_charlie', :'member_charlie_paws', now() - interval '6 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_charlie', :'member_alice_hound', 'member', 'Charlie, are you bringing all three huskies to the April meetup? I want to make sure we have enough space in the off-leash area.', now() - interval '6 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_charlie_paws', :'t_alice_charlie', id, true, now() - interval '6 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_charlie', :'member_charlie_paws', 'member', 'Yep, all three! Blizzard, Storm, and Aurora. They''ve been cooped up all week so they''ll be extra energetic. Should I bring the portable agility set?', now() - interval '5 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_alice_hound', :'t_alice_charlie', id, true, now() - interval '5 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_alice_charlie', :'member_alice_hound', 'member', 'That would be perfect! Let''s set it up in the flat area near the picnic tables. See you there!', now() - interval '5 days' + interval '1 hour')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_charlie_paws', :'t_alice_charlie', id, true, now() - interval '5 days' + interval '1 hour' from msg;

-- ============================================================
-- Thread 3: Bob <-> Charlie (1 message about fox sighting)
-- Shared clubs: FoxClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_bob_whiskers',
  least(:'member_bob_whiskers', :'member_charlie_paws'),
  greatest(:'member_bob_whiskers', :'member_charlie_paws'),
  now() - interval '4 days')
returning id as t_bob_charlie \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_bob_charlie', :'member_bob_whiskers', now() - interval '4 days'),
  (:'t_bob_charlie', :'member_charlie_paws', now() - interval '4 days');

-- Unread by Charlie
with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_bob_charlie', :'member_bob_whiskers', 'member', 'Charlie, I spotted a vixen with three cubs near the old railway bridge this morning! First sighting in that area in two years. Might be worth checking with Ivan if he can get photos before the den gets disturbed.', now() - interval '4 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_charlie_paws', :'t_bob_charlie', id, false, now() - interval '4 days' from msg;

-- ============================================================
-- Thread 4: Owen <-> Alice (4 messages about club admin)
-- Shared clubs: DogClub, CatClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_owen_barnes',
  least(:'member_owen_barnes', :'member_alice_hound'),
  greatest(:'member_owen_barnes', :'member_alice_hound'),
  now() - interval '12 days')
returning id as t_owen_alice \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_owen_alice', :'member_owen_barnes', now() - interval '12 days'),
  (:'t_owen_alice', :'member_alice_hound', now() - interval '12 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_alice', :'member_owen_barnes', 'member', 'Alice, I''m thinking about making you a co-admin for DogClub. You''re already doing so much for the community. Would you be up for it?', now() - interval '12 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_alice_hound', :'t_owen_alice', id, true, now() - interval '12 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_alice', :'member_alice_hound', 'member', 'Owen that''s really kind of you! I''d love to help out more. What would the responsibilities look like?', now() - interval '11 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_owen_barnes', :'t_owen_alice', id, true, now() - interval '11 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_alice', :'member_owen_barnes', 'member', 'Mainly reviewing new member applications and helping moderate content. You''d also be able to manage events and approve posts. I''ll handle the technical side.', now() - interval '11 days' + interval '2 hours')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_alice_hound', :'t_owen_alice', id, true, now() - interval '11 days' + interval '2 hours' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_alice', :'member_alice_hound', 'member', 'Sounds great, count me in! I''ll start by reviewing the pending applications this week.', now() - interval '10 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_owen_barnes', :'t_owen_alice', id, true, now() - interval '10 days' from msg;

-- ============================================================
-- Thread 5: Owen <-> Bob (2 messages about fox conservation)
-- Shared clubs: CatClub, FoxClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_owen_barnes',
  least(:'member_owen_barnes', :'member_bob_whiskers'),
  greatest(:'member_owen_barnes', :'member_bob_whiskers'),
  now() - interval '7 days')
returning id as t_owen_bob \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_owen_bob', :'member_owen_barnes',  now() - interval '7 days'),
  (:'t_owen_bob', :'member_bob_whiskers', now() - interval '7 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_bob', :'member_owen_barnes', 'member', 'Bob, that Q1 conservation update was excellent. Have you considered writing a monthly newsletter for the club? I think it would keep engagement up.', now() - interval '7 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_bob_whiskers', :'t_owen_bob', id, true, now() - interval '7 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_bob', :'member_bob_whiskers', 'member', 'Thanks Owen! A monthly newsletter is a great idea. I could include sighting reports, conservation news, and member spotlights. Let me draft a template.', now() - interval '6 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_owen_barnes', :'t_owen_bob', id, true, now() - interval '6 days' from msg;

-- ============================================================
-- Thread 6: Diana <-> Julia (4 messages about cat rescue)
-- Shared clubs: CatClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_diana_feathers',
  least(:'member_diana_feathers', :'member_julia_stripes'),
  greatest(:'member_diana_feathers', :'member_julia_stripes'),
  now() - interval '5 days')
returning id as t_diana_julia \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_diana_julia', :'member_diana_feathers', now() - interval '5 days'),
  (:'t_diana_julia', :'member_julia_stripes',  now() - interval '5 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'member_diana_feathers', 'member', 'Julia, I saw your post about the shy rescue cat. I''d be happy to do a free health check if you think stress might be a factor. Sometimes underlying pain makes cats hide.', now() - interval '5 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_julia_stripes', :'t_diana_julia', id, true, now() - interval '5 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'member_julia_stripes', 'member', 'That''s so generous, thank you Diana! The shelter said she was healthy but they were quite busy. I''d feel much better with a proper check from you.', now() - interval '4 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_diana_feathers', :'t_diana_julia', id, true, now() - interval '4 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'member_diana_feathers', 'member', 'Of course! I can come by this Saturday morning. In the meantime, try placing a worn t-shirt near her hiding spot — your scent helps build familiarity.', now() - interval '3 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_julia_stripes', :'t_diana_julia', id, true, now() - interval '3 days' from msg;

-- Unread by Diana
with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_diana_julia', :'member_julia_stripes', 'member', 'Saturday works perfectly! And I tried the t-shirt trick — she actually sniffed it this morning instead of running away. Small progress!', now() - interval '2 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_diana_feathers', :'t_diana_julia', id, false, now() - interval '2 days' from msg;

-- ============================================================
-- Thread 7: Ivan <-> Charlie (3 messages about wildlife photography)
-- Shared clubs: DogClub, FoxClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_ivan_tusks',
  least(:'member_ivan_tusks', :'member_charlie_paws'),
  greatest(:'member_ivan_tusks', :'member_charlie_paws'),
  now() - interval '8 days')
returning id as t_ivan_charlie \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_ivan_charlie', :'member_ivan_tusks',   now() - interval '8 days'),
  (:'t_ivan_charlie', :'member_charlie_paws', now() - interval '8 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_ivan_charlie', :'member_ivan_tusks', 'member', 'Charlie, loved your photography tips post! You''re really progressing fast. Want to do a dawn session at the meadow this weekend? The foxes have been active there.', now() - interval '8 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_charlie_paws', :'t_ivan_charlie', id, true, now() - interval '8 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_ivan_charlie', :'member_charlie_paws', 'member', 'I''d love that! What time should I be there? And should I bring the 200mm or the 400mm?', now() - interval '7 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_ivan_tusks', :'t_ivan_charlie', id, true, now() - interval '7 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_ivan_charlie', :'member_ivan_tusks', 'member', 'Meet at 5:15am — we want to be set up before first light. Bring the 400mm, the foxes keep their distance at that spot. I''ll bring a hide cloth.', now() - interval '7 days' + interval '3 hours')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_charlie_paws', :'t_ivan_charlie', id, true, now() - interval '7 days' + interval '3 hours' from msg;

-- ============================================================
-- Thread 8: Owen <-> Diana (5 messages, one removed)
-- Shared clubs: DogClub, CatClub, FoxClub
-- ============================================================

insert into app.messaging_threads (kind, created_by_member_id, member_a_id, member_b_id, created_at)
values ('direct', :'member_owen_barnes',
  least(:'member_owen_barnes', :'member_diana_feathers'),
  greatest(:'member_owen_barnes', :'member_diana_feathers'),
  now() - interval '9 days')
returning id as t_owen_diana \gset

insert into app.messaging_thread_participants (thread_id, member_id, joined_at) values
  (:'t_owen_diana', :'member_owen_barnes',   now() - interval '9 days'),
  (:'t_owen_diana', :'member_diana_feathers', now() - interval '9 days');

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_diana', :'member_owen_barnes', 'member', 'Diana, thanks for handling the spam post removal so quickly. George seems like a good person but he needs to understand that CatClub isn''t a marketplace.', now() - interval '9 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_diana_feathers', :'t_owen_diana', id, true, now() - interval '9 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_diana', :'member_diana_feathers', 'member', 'Agreed. I sent him a friendly DM explaining the guidelines. He was apologetic. I think it was a genuine mistake — he''s very enthusiastic about his bird feeder business.', now() - interval '8 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_owen_barnes', :'t_owen_diana', id, true, now() - interval '8 days' from msg;

with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_diana', :'member_owen_barnes', 'member', 'Good call. On another topic — the cat cafe partnership you posted about sounds amazing. I might be interested in the vet welfare side. Can we chat about it?', now() - interval '7 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_diana_feathers', :'t_owen_diana', id, true, now() - interval '7 days' from msg;

-- This message will be removed
insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
values (:'t_owen_diana', :'member_owen_barnes', 'member', 'Oops, sent this to the wrong thread — ignore!', now() - interval '6 days')
returning id as removed_msg \gset

insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
values (:'member_diana_feathers', :'t_owen_diana', :'removed_msg', true, now() - interval '6 days');

insert into app.messaging_message_removals (message_id, removed_by_member_id, reason, removed_at)
values (:'removed_msg', :'member_owen_barnes', 'Sent to wrong thread', now() - interval '6 days' + interval '1 minute');

-- Last message — unread by Owen
with msg as (
  insert into app.messaging_messages (thread_id, sender_member_id, role, message_text, created_at)
  values (:'t_owen_diana', :'member_diana_feathers', 'member', 'Absolutely! I''d love to discuss the welfare protocols. I have some ideas about stress-free rotation schedules for the cats. Free Saturday afternoon?', now() - interval '3 days')
  returning id
)
insert into app.messaging_inbox_entries (recipient_member_id, thread_id, message_id, acknowledged, created_at)
select :'member_owen_barnes', :'t_owen_diana', id, false, now() - interval '3 days' from msg;

commit;
