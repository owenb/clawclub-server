-- Club database seed for local dev.
-- Run as superuser against clawclub_clubs_dev.
-- Expects psql variables for cross-database IDs (member_*, club_*, mid_*).

begin;

-- ============================================================
-- Quota policies
-- ============================================================

insert into app.club_quota_policies (club_id, action_name, max_per_day) values
  (:'club_dogclub', 'entities.create', 20),
  (:'club_dogclub', 'events.create',   5),
  (:'club_catclub', 'entities.create', 15),
  (:'club_catclub', 'events.create',   5),
  (:'club_foxclub', 'entities.create', 10),
  (:'club_foxclub', 'events.create',   3)
on conflict do nothing;

-- ============================================================
-- DogClub entities
-- ============================================================

-- dog_post1: "Annual Dog Show 2026 Recap" by Alice
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'post', :'member_alice_hound', now() - interval '14 days')
returning id as dog_post1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_post1', 1, 'published',
  'Annual Dog Show 2026 Recap',
  'Highlights and winners from this year''s spectacular show',
  'The annual dog show was a tremendous success this year with over 200 entries across 45 breeds. Best in Show went to a magnificent Irish Wolfhound named Thunder. The agility competition was fierce, with our own club member Charlie''s husky placing third. Next year we''re expanding to include a rescue dog showcase — stay tuned for volunteer opportunities!',
  now() - interval '14 days', now() - interval '14 days', :'member_alice_hound');

-- dog_post2: "Best Dog-Friendly Hiking Trails" by Charlie
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'post', :'member_charlie_paws', now() - interval '7 days')
returning id as dog_post2 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_post2', 1, 'published',
  'Best Dog-Friendly Hiking Trails',
  'My top 5 trails tested with three huskies',
  'After years of trail running with my pack, here are the five best dog-friendly trails in our area: 1) Riverside Loop — wide paths, water access, moderate difficulty. 2) Pine Ridge Trail — shaded, great in summer, off-leash section. 3) Summit View — challenging but worth it, bring extra water. 4) Meadow Walk — flat and easy, perfect for puppies. 5) Canyon Creek — advanced only, steep switchbacks but amazing views. Always check seasonal closures and leash requirements!',
  now() - interval '7 days', now() - interval '7 days', :'member_charlie_paws');

-- dog_opp1: "Dog Walking Business Partnership" by Owen
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'opportunity', :'member_owen_barnes', now() - interval '10 days')
returning id as dog_opp1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, work_mode, compensation, effective_at, expires_at, created_at, created_by_member_id)
values (:'dog_opp1', 1, 'published',
  'Dog Walking Business Partnership',
  'Looking for a partner to co-run a premium dog walking service',
  'I''m exploring launching a premium dog walking service in the downtown area. Looking for someone with professional dog handling experience to partner on this. We would split the business 50/50. Initial investment is minimal — mainly insurance and marketing. Ideal partner has flexible schedule and genuine love for dogs.',
  'hybrid', 'paid',
  now() - interval '10 days', now() + interval '50 days',
  now() - interval '10 days', :'member_owen_barnes');

-- dog_svc1: "Professional Obedience Training" by Alice
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'service', :'member_alice_hound', now() - interval '21 days')
returning id as dog_svc1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, compensation, effective_at, created_at, created_by_member_id)
values (:'dog_svc1', 1, 'published',
  'Professional Obedience Training',
  'Private and group sessions for dogs of all ages',
  'Offering professional obedience training using positive reinforcement methods. Private sessions: 1 hour, tailored to your dog''s specific needs. Group classes: 6-week programs for puppies, adolescents, and adults. Specializing in rescue dog rehabilitation — fearful and reactive dogs welcome. First consultation is free for club members.',
  'paid',
  now() - interval '21 days', now() - interval '21 days', :'member_alice_hound');

-- dog_ask1: "Vet Recommendations Near Downtown?" by Charlie
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'ask', :'member_charlie_paws', now() - interval '3 days')
returning id as dog_ask1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, expires_at, created_at, created_by_member_id)
values (:'dog_ask1', 1, 'published',
  'Vet Recommendations Near Downtown?',
  'Need a new vet for my three huskies',
  'My previous vet retired and I need to find a new one that can handle three large, energetic huskies. Requirements: experience with northern breeds, weekend availability, ideally within 20 minutes of downtown. Bonus points if they do house calls. Any recommendations from fellow club members?',
  now() - interval '3 days', now() + interval '27 days',
  now() - interval '3 days', :'member_charlie_paws');

-- dog_evt1: "DogClub Monthly Meetup - April" by Owen (future)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'event', :'member_owen_barnes', now() - interval '8 days')
returning id as dog_evt1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, location, starts_at, ends_at, timezone, capacity, effective_at, created_at, created_by_member_id)
values (:'dog_evt1', 1, 'published',
  'DogClub Monthly Meetup - April',
  'Our regular monthly gathering at Riverside Park',
  'Join us for the April edition of our monthly meetup! We''ll have an off-leash play session followed by a brief club business discussion. New members especially welcome. Please bring water for your dogs and clean up after them.',
  'Riverside Park, Shelter #3',
  now() + interval '5 days' + interval '10 hours',
  now() + interval '5 days' + interval '13 hours',
  'America/New_York', 20,
  now() - interval '8 days', now() - interval '8 days', :'member_owen_barnes');

-- dog_evt2: "Puppy Socialization Workshop" by Alice (past)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'event', :'member_alice_hound', now() - interval '20 days')
returning id as dog_evt2 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, location, starts_at, ends_at, timezone, capacity, effective_at, created_at, created_by_member_id)
values (:'dog_evt2', 1, 'published',
  'Puppy Socialization Workshop',
  'Controlled introduction sessions for puppies under 6 months',
  'A structured socialization workshop for puppies. We''ll cover: proper greeting behavior, handling exercises, exposure to new surfaces and sounds, and supervised play. Limited to 8 puppies to ensure quality interactions.',
  'Alice''s Training Center, 42 Oak Street',
  now() - interval '10 days' + interval '9 hours',
  now() - interval '10 days' + interval '12 hours',
  'America/New_York', 8,
  now() - interval '20 days', now() - interval '20 days', :'member_alice_hound');

-- dog_post3: "Training Tips for Stubborn Breeds" by Ivan
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_dogclub', 'post', :'member_ivan_tusks', now() - interval '2 days')
returning id as dog_post3 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'dog_post3', 1, 'published',
  'Training Tips for Stubborn Breeds',
  'What I learned photographing working dogs',
  'After spending hundreds of hours photographing working dogs on farms and in the field, I''ve picked up some training insights. Stubborn breeds aren''t actually stubborn — they''re independent thinkers bred for autonomous decision-making. Key tips: 1) Make training worth their while with high-value rewards. 2) Keep sessions short and varied. 3) Never repeat commands — say it once and wait. 4) Channel their drive into structured activities.',
  now() - interval '2 days', now() - interval '2 days', :'member_ivan_tusks');

-- Comments on dog_post1
insert into app.entities (club_id, kind, author_member_id, parent_entity_id, created_at)
values (:'club_dogclub', 'comment', :'member_charlie_paws', :'dog_post1', now() - interval '13 days')
returning id as dog_cmt1 \gset

insert into app.entity_versions (entity_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'dog_cmt1', 1, 'published',
  'Great recap Alice! My husky Blizzard had such a blast in the agility ring. Third place felt like a win — those border collies are impossibly fast. Already training for next year!',
  now() - interval '13 days', now() - interval '13 days', :'member_charlie_paws');

insert into app.entities (club_id, kind, author_member_id, parent_entity_id, created_at)
values (:'club_dogclub', 'comment', :'member_owen_barnes', :'dog_post1', now() - interval '13 days' + interval '2 hours')
returning id as dog_cmt2 \gset

insert into app.entity_versions (entity_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'dog_cmt2', 1, 'published',
  'Fantastic write-up! The rescue dog showcase idea is brilliant. I''ll set up a planning thread — let''s make it happen for next year.',
  now() - interval '13 days' + interval '2 hours', now() - interval '13 days' + interval '2 hours', :'member_owen_barnes');

-- ============================================================
-- CatClub entities
-- ============================================================

-- cat_post1: "Understanding Feline Body Language" by Alice
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'post', :'member_alice_hound', now() - interval '20 days')
returning id as cat_post1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_post1', 1, 'published',
  'Understanding Feline Body Language',
  'A dog trainer''s journey into decoding cat signals',
  'As a dog trainer who also loves cats, I''ve been studying feline body language. Key signals: slow blinks = trust and affection. Tail straight up = happy greeting. Ears back + dilated pupils = fear or aggression. Belly exposure does NOT always mean "pet me" unlike dogs. Tail twitching = overstimulation or hunting focus. Understanding these signals has transformed my relationship with my two rescue cats.',
  now() - interval '20 days', now() - interval '20 days', :'member_alice_hound');

-- cat_post2: "Top Cat Toys of 2026" by Bob
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'post', :'member_bob_whiskers', now() - interval '12 days')
returning id as cat_post2 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_post2', 1, 'published',
  'Top Cat Toys of 2026',
  'Tested by 30+ shelter cats — here are the winners',
  'I''ve been testing toys at the shelter with our residents to find the best options. Top picks: 1) The Ripple Wand — irresistible to every cat. 2) Puzzle Feeder Pro — keeps them engaged for hours. 3) Crinkle Tunnel XL — even shy cats come out. 4) Solar Butterfly — autonomous toy that works when you''re away. 5) Catnip Kicker Deluxe — sturdy enough for the most aggressive bunny-kickers.',
  now() - interval '12 days', now() - interval '12 days', :'member_bob_whiskers');

-- cat_opp1: "Cat Cafe Opening" by Diana
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'opportunity', :'member_diana_feathers', now() - interval '8 days')
returning id as cat_opp1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, work_mode, compensation, effective_at, expires_at, created_at, created_by_member_id)
values (:'cat_opp1', 1, 'published',
  'Cat Cafe Opening — Seeking Partners',
  'Looking for collaborators to open a rescue cat cafe downtown',
  'Planning to open a cat cafe that doubles as an adoption center. Looking for partners: 1) Business ops — food service or retail experience. 2) Cat welfare — a certified behaviorist to ensure cats thrive. 3) Marketing — social media is everything for cat cafes. Revenue model: cafe operations fund the rescue program.',
  'in_person', 'paid',
  now() - interval '8 days', now() + interval '52 days',
  now() - interval '8 days', :'member_diana_feathers');

-- cat_svc1: "Cat Sitting & Pet Care" by Bob
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'service', :'member_bob_whiskers', now() - interval '15 days')
returning id as cat_svc1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, compensation, effective_at, created_at, created_by_member_id)
values (:'cat_svc1', 1, 'published',
  'Cat Sitting & Pet Care',
  'Experienced cat care for when you''re away',
  'Offering reliable cat sitting for club members. Services: daily visits (feeding, litter, play), overnight stays, medication administration, multi-cat household management. Experience with special needs cats, seniors, and anxious cats. Club member discount: 15% off regular rates.',
  'paid',
  now() - interval '15 days', now() - interval '15 days', :'member_bob_whiskers');

-- cat_ask1: "Help with a Shy Rescue Cat" by Julia
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'ask', :'member_julia_stripes', now() - interval '4 days')
returning id as cat_ask1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_ask1', 1, 'published',
  'Help with a Shy Rescue Cat',
  'New rescue cat hiding under the bed for two weeks straight',
  'I adopted a 3-year-old tabby two weeks ago and she hasn''t come out from under the bed except to eat when I''m not in the room. I''ve tried Feliway diffusers, leaving treats, sitting quietly nearby, and slow blinking. She doesn''t hiss but won''t make eye contact. Any behaviorists or experienced rescue parents have advice?',
  now() - interval '4 days', now() - interval '4 days', :'member_julia_stripes');

-- cat_evt1: "CatClub Virtual Q&A with a Vet" by Diana (future)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'event', :'member_diana_feathers', now() - interval '6 days')
returning id as cat_evt1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, location, starts_at, ends_at, timezone, effective_at, created_at, created_by_member_id)
values (:'cat_evt1', 1, 'published',
  'CatClub Virtual Q&A with a Vet',
  'Live Q&A session — bring your cat health questions',
  'I''ll be hosting a live virtual Q&A covering common cat health concerns: dental health, weight management, senior cat care, and when to seek emergency care. Submit questions in advance or ask live.',
  'Zoom (link sent day of event)',
  now() + interval '3 days' + interval '19 hours',
  now() + interval '3 days' + interval '20 hours' + interval '30 minutes',
  'America/New_York',
  now() - interval '6 days', now() - interval '6 days', :'member_diana_feathers');

-- Comment on cat_post1 by Bob
insert into app.entities (club_id, kind, author_member_id, parent_entity_id, created_at)
values (:'club_catclub', 'comment', :'member_bob_whiskers', :'cat_post1', now() - interval '19 days')
returning id as cat_cmt1 \gset

insert into app.entity_versions (entity_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'cat_cmt1', 1, 'published',
  'The belly trap is so real! Our shelter cats teach new volunteers this lesson on day one. Great overview Alice — I''m sharing this with our foster families.',
  now() - interval '19 days', now() - interval '19 days', :'member_bob_whiskers');

-- cat_spam: spam post by George (published then removed by admin Diana)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_catclub', 'post', :'member_george_wings', now() - interval '16 days')
returning id as cat_spam \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'cat_spam', 1, 'published',
  'CHECK OUT MY BIRD FEEDER STORE!!!',
  'Best bird feeders at unbeatable prices',
  'Visit my online store for amazing bird feeders! 50% off all models this week only! Free shipping! Buy now!',
  now() - interval '16 days', now() - interval '16 days', :'member_george_wings');

-- Removal version (by admin Diana)
insert into app.entity_versions (entity_id, version_no, state, reason, effective_at, created_at, created_by_member_id)
values (:'cat_spam', 2, 'removed',
  'Promotional spam unrelated to the club. Please review our posting guidelines.',
  now() - interval '15 days', now() - interval '15 days', :'member_diana_feathers');

-- ============================================================
-- FoxClub entities
-- ============================================================

-- fox_post1: "Fox Conservation Update Q1 2026" by Bob
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'post', :'member_bob_whiskers', now() - interval '18 days')
returning id as fox_post1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_post1', 1, 'published',
  'Fox Conservation Update Q1 2026',
  'Population trends, new research, and policy developments',
  'Quarterly conservation update. Urban fox populations remain stable. Key findings: 1) New denning sites in the industrial district — habitat corridors working. 2) Mange vaccination pilot shows 40% case reduction. 3) City council approved the green corridor extension. 4) Fiona''s PhD research cited in the new conservation policy draft. Full report attached to the activity feed.',
  now() - interval '18 days', now() - interval '18 days', :'member_bob_whiskers');

-- fox_post2: "Wildlife Photography Tips & Tricks" by Charlie
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'post', :'member_charlie_paws', now() - interval '9 days')
returning id as fox_post2 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_post2', 1, 'published',
  'Wildlife Photography Tips & Tricks',
  'Lessons from an amateur who learned from Ivan',
  'Ivan gave me some photography coaching during our fox census work and it changed everything. Tips for beginners: 1) Patience > equipment. 2) Learn the golden hour for your area. 3) Shoot from the animal''s eye level. 4) Use burst mode for action shots. 5) Don''t chase — let them come to you.',
  now() - interval '9 days', now() - interval '9 days', :'member_charlie_paws');

-- fox_opp1: "Fox Sanctuary Volunteer Positions" by Owen
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'opportunity', :'member_owen_barnes', now() - interval '6 days')
returning id as fox_opp1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, work_mode, compensation, effective_at, expires_at, created_at, created_by_member_id)
values (:'fox_opp1', 1, 'published',
  'Fox Sanctuary Volunteer Positions',
  'Help at the local fox rescue and rehabilitation center',
  'The Woodland Fox Sanctuary needs volunteers. Roles: feeding and enrichment (mornings), enclosure maintenance (weekends), educational tour guides (Saturdays), transport for vet visits. Commitment: minimum 4 hours/week for 3 months. Training provided.',
  'in_person', 'unpaid',
  now() - interval '6 days', now() + interval '54 days',
  now() - interval '6 days', :'member_owen_barnes');

-- fox_svc1: "Wildlife Photography Workshops" by Charlie
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'service', :'member_charlie_paws', now() - interval '14 days')
returning id as fox_svc1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, compensation, effective_at, created_at, created_by_member_id)
values (:'fox_svc1', 1, 'published',
  'Wildlife Photography Workshops',
  'Field workshops in partnership with Ivan Tusks',
  'Hands-on wildlife photography workshops with professional photographer Ivan Tusks. Includes: dawn fox photography sessions, gear and settings masterclass, post-processing walkthrough, and ethical wildlife photography guidelines. Small groups of 4-6, all skill levels.',
  'paid',
  now() - interval '14 days', now() - interval '14 days', :'member_charlie_paws');

-- fox_ask1: "Fox Sighting Tracking Apps?" by Ivan
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'ask', :'member_ivan_tusks', now() - interval '5 days')
returning id as fox_ask1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_ask1', 1, 'published',
  'Fox Sighting Tracking Apps?',
  'Looking for the best app to log and share fox sightings',
  'I want to systematically log fox sightings with GPS, timestamps, and photos. Ideally something that exports in a research-friendly format. I''ve tried iNaturalist but it''s too general. Anyone used something more specialized? Bonus if it supports collaborative mapping.',
  now() - interval '5 days', now() - interval '5 days', :'member_ivan_tusks');

-- fox_evt1: "Fox Watch Night Walk" by Owen (future, capacity-limited)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'event', :'member_owen_barnes', now() - interval '5 days')
returning id as fox_evt1 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, location, starts_at, ends_at, timezone, capacity, effective_at, created_at, created_by_member_id)
values (:'fox_evt1', 1, 'published',
  'Fox Watch Night Walk',
  'Guided evening walk to observe urban foxes',
  'Guided night walk through the green corridor to observe urban foxes. We''ll cover fox behavior, identification, and ethical observation. Bring: quiet shoes, dark clothing, a red-light torch, and binoculars. Strictly limited to 10 people to minimize disturbance.',
  'Green Corridor Trailhead, North Entrance',
  now() + interval '7 days' + interval '20 hours',
  now() + interval '7 days' + interval '23 hours',
  'Europe/London', 10,
  now() - interval '5 days', now() - interval '5 days', :'member_owen_barnes');

-- fox_evt2: "Annual Fox Census" by Bob (past)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'event', :'member_bob_whiskers', now() - interval '30 days')
returning id as fox_evt2 \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, location, starts_at, ends_at, timezone, effective_at, created_at, created_by_member_id)
values (:'fox_evt2', 1, 'published',
  'Annual Fox Census Volunteer Day',
  'Help us count and map the local fox population',
  'Our annual census is the most important data event of the year. Volunteers split into teams of 2-3 and survey assigned quadrants. Training at 7am, field work 8am-4pm. All data feeds into the regional conservation database. Lunch provided. Last year: 47 individuals across 12 territories!',
  'Woodland Community Center',
  now() - interval '20 days' + interval '7 hours',
  now() - interval '20 days' + interval '16 hours',
  'Europe/London',
  now() - interval '30 days', now() - interval '30 days', :'member_bob_whiskers');

-- Comment on fox_post1 by Ivan
insert into app.entities (club_id, kind, author_member_id, parent_entity_id, created_at)
values (:'club_foxclub', 'comment', :'member_ivan_tusks', :'fox_post1', now() - interval '17 days')
returning id as fox_cmt1 \gset

insert into app.entity_versions (entity_id, version_no, state, body, effective_at, created_at, created_by_member_id)
values (:'fox_cmt1', 1, 'published',
  'The mange vaccination results are incredible — 40% reduction is better than anyone predicted. I have photos showing the recovery of a vixen I''ve been tracking for two years. Happy to share at the next meetup.',
  now() - interval '17 days', now() - interval '17 days', :'member_ivan_tusks');

-- fox_draft: draft post by Ivan (unpublished)
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'post', :'member_ivan_tusks', now() - interval '1 day')
returning id as fox_draft \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_draft', 1, 'draft',
  'Preliminary Fox Migration Data — Spring 2026',
  'Early patterns from GPS collar tracking',
  'DRAFT — still compiling data from the last three collar downloads. Initial patterns suggest a shift in denning preference toward...',
  now() - interval '1 day', now() - interval '1 day', :'member_ivan_tusks');

-- fox_complaint: complaint by Fiona
insert into app.entities (club_id, kind, author_member_id, created_at)
values (:'club_foxclub', 'complaint', :'member_fiona_hooves', now() - interval '2 days')
returning id as fox_complaint \gset

insert into app.entity_versions (entity_id, version_no, state, title, summary, body, effective_at, created_at, created_by_member_id)
values (:'fox_complaint', 1, 'published',
  'Trail Damage from Last Census Event',
  'Some volunteer teams left marked trails through sensitive habitat',
  'During the last fox census, at least two volunteer teams went off designated paths and left visible trails through the denning area near quadrant 7. This could disturb vixens during cubbing season. Can we add a briefing about staying on paths and add GPS geofencing to the survey app?',
  now() - interval '2 days', now() - interval '2 days', :'member_fiona_hooves');

-- ============================================================
-- Event RSVPs
-- ============================================================

-- DogClub Monthly Meetup (dog_evt1)
insert into app.event_rsvps (event_entity_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'dog_evt1', :'mid_alice_hound_dogclub',   'yes',   1, :'member_alice_hound',  now() - interval '6 days'),
  (:'dog_evt1', :'mid_charlie_paws_dogclub',  'yes',   1, :'member_charlie_paws', now() - interval '5 days'),
  (:'dog_evt1', :'mid_eddie_scales_dogclub',  'maybe', 1, :'member_eddie_scales', now() - interval '4 days'),
  (:'dog_evt1', :'mid_ivan_tusks_dogclub',    'yes',   1, :'member_ivan_tusks',   now() - interval '3 days'),
  (:'dog_evt1', :'mid_kevin_spots_dogclub',   'yes',   1, :'member_kevin_spots',  now() - interval '2 days')
on conflict do nothing;

-- Puppy Socialization (dog_evt2) — past event
insert into app.event_rsvps (event_entity_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'dog_evt2', :'mid_alice_hound_dogclub',  'yes', 1, :'member_alice_hound',  now() - interval '15 days'),
  (:'dog_evt2', :'mid_charlie_paws_dogclub', 'no',  1, :'member_charlie_paws', now() - interval '14 days')
on conflict do nothing;

-- CatClub Virtual Q&A (cat_evt1)
insert into app.event_rsvps (event_entity_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'cat_evt1', :'mid_alice_hound_catclub',   'yes',   1, :'member_alice_hound',   now() - interval '4 days'),
  (:'cat_evt1', :'mid_bob_whiskers_catclub',  'yes',   1, :'member_bob_whiskers',  now() - interval '3 days'),
  (:'cat_evt1', :'mid_julia_stripes_catclub', 'maybe', 1, :'member_julia_stripes', now() - interval '2 days'),
  (:'cat_evt1', :'mid_george_wings_catclub',  'yes',   1, :'member_george_wings',  now() - interval '2 days')
on conflict do nothing;

-- Fox Watch Night Walk (fox_evt1) — capacity 10
insert into app.event_rsvps (event_entity_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'fox_evt1', :'mid_bob_whiskers_foxclub',  'yes',   1, :'member_bob_whiskers',  now() - interval '4 days'),
  (:'fox_evt1', :'mid_charlie_paws_foxclub',  'yes',   1, :'member_charlie_paws',  now() - interval '3 days'),
  (:'fox_evt1', :'mid_fiona_hooves_foxclub',  'yes',   1, :'member_fiona_hooves',  now() - interval '3 days'),
  (:'fox_evt1', :'mid_ivan_tusks_foxclub',    'maybe', 1, :'member_ivan_tusks',    now() - interval '2 days')
on conflict do nothing;

-- Fox Census (fox_evt2) — past event
insert into app.event_rsvps (event_entity_id, membership_id, response, version_no, created_by_member_id, created_at) values
  (:'fox_evt2', :'mid_bob_whiskers_foxclub',  'yes', 1, :'member_bob_whiskers',  now() - interval '25 days'),
  (:'fox_evt2', :'mid_charlie_paws_foxclub',  'yes', 1, :'member_charlie_paws',  now() - interval '24 days'),
  (:'fox_evt2', :'mid_ivan_tusks_foxclub',    'yes', 1, :'member_ivan_tusks',    now() - interval '23 days')
on conflict do nothing;

-- ============================================================
-- Vouches (edges with kind='vouched_for')
-- ============================================================

insert into app.edges (club_id, kind, from_member_id, to_member_id, reason, created_by_member_id, created_at) values
  -- DogClub vouches
  (:'club_dogclub', 'vouched_for', :'member_alice_hound',    :'member_charlie_paws',   'Charlie is an incredible dog handler and trail guide. His huskies are the best-trained dogs I''ve seen.',             :'member_alice_hound',    now() - interval '40 days'),
  (:'club_dogclub', 'vouched_for', :'member_charlie_paws',   :'member_alice_hound',    'Alice transformed my reactive husky into a confident dog. Her training methods are outstanding.',                      :'member_charlie_paws',   now() - interval '40 days'),
  (:'club_dogclub', 'vouched_for', :'member_owen_barnes',    :'member_alice_hound',    'Alice''s dedication to rescue dog rehabilitation is extraordinary. An invaluable member of our community.',              :'member_owen_barnes',    now() - interval '45 days'),
  (:'club_dogclub', 'vouched_for', :'member_owen_barnes',    :'member_ivan_tusks',     'Ivan''s wildlife photography gives us a unique perspective. Great addition to the club.',                                :'member_owen_barnes',    now() - interval '15 days'),
  (:'club_dogclub', 'vouched_for', :'member_alice_hound',    :'member_kevin_spots',    'Kevin runs an ethical breeding program. His Dalmatians are healthy and well-socialized.',                                :'member_alice_hound',    now() - interval '4 days'),
  -- CatClub vouches
  (:'club_catclub', 'vouched_for', :'member_bob_whiskers',   :'member_alice_hound',    'Alice brings a refreshing dog-trainer perspective to cat behavior. Her cross-species insights are valuable.',            :'member_bob_whiskers',   now() - interval '35 days'),
  (:'club_catclub', 'vouched_for', :'member_alice_hound',    :'member_bob_whiskers',   'Bob is the heart of the local rescue community. His shelter photography has helped hundreds of cats find homes.',         :'member_alice_hound',    now() - interval '35 days'),
  (:'club_catclub', 'vouched_for', :'member_diana_feathers', :'member_julia_stripes',  'Julia is a certified feline behaviorist with exceptional expertise in multi-cat dynamics.',                               :'member_diana_feathers', now() - interval '14 days'),
  (:'club_catclub', 'vouched_for', :'member_alice_hound',    :'member_diana_feathers', 'Diana''s free community vet clinics have helped so many pet owners. She''s an asset to every club she''s in.',             :'member_alice_hound',    now() - interval '30 days'),
  (:'club_catclub', 'vouched_for', :'member_bob_whiskers',   :'member_julia_stripes',  'Julia resolved a conflict between three cats in our shelter that had stumped everyone.',                                  :'member_bob_whiskers',   now() - interval '12 days'),
  -- FoxClub vouches
  (:'club_foxclub', 'vouched_for', :'member_bob_whiskers',   :'member_charlie_paws',   'Charlie''s dedication to the fox census and trail maintenance makes him a cornerstone of our conservation efforts.',       :'member_bob_whiskers',   now() - interval '30 days'),
  (:'club_foxclub', 'vouched_for', :'member_charlie_paws',   :'member_bob_whiskers',   'Bob coordinates our conservation updates and keeps the entire club informed. Essential contributor.',                      :'member_charlie_paws',   now() - interval '30 days'),
  (:'club_foxclub', 'vouched_for', :'member_owen_barnes',    :'member_ivan_tusks',     'Ivan''s fox photography is published nationally. His visual documentation of our local population is vital.',               :'member_owen_barnes',    now() - interval '15 days'),
  (:'club_foxclub', 'vouched_for', :'member_bob_whiskers',   :'member_fiona_hooves',   'Fiona''s PhD research on urban fox populations is groundbreaking. She brings real scientific rigor to our club.',           :'member_bob_whiskers',   now() - interval '20 days'),
  (:'club_foxclub', 'vouched_for', :'member_charlie_paws',   :'member_ivan_tusks',     'Ivan taught me wildlife photography and his patience in the field is remarkable. Dedicated conservationist.',                :'member_charlie_paws',   now() - interval '10 days')
on conflict do nothing;

-- ============================================================
-- Admissions (6 in various states)
-- ============================================================

-- 1. Cold application (self_applied) to DogClub — submitted, waiting for review
insert into app.admissions (club_id, origin, applicant_email, applicant_name, admission_details, created_at)
values (:'club_dogclub', 'self_applied', 'liam@example.com', 'Liam Barker',
  '{"socials":"twitter: @liambarker, linkedin: linkedin.com/in/liambarker","application":"I have been working with rescue dogs for over 5 years and would love to join a community of like-minded dog enthusiasts. I currently foster dogs through the local SPCA and organize monthly adoption events in my neighborhood. I specialize in working with large breed dogs that are often overlooked in shelters."}'::jsonb,
  now() - interval '3 days')
returning id as adm_liam \gset

insert into app.admission_versions (admission_id, status, version_no, created_at)
values (:'adm_liam', 'submitted', 1, now() - interval '3 days');

-- 2. Warm referral (member_sponsored) to CatClub — submitted by Alice
insert into app.admissions (club_id, origin, sponsor_member_id, applicant_email, applicant_name, admission_details, created_at)
values (:'club_catclub', 'member_sponsored', :'member_alice_hound', 'mia@example.com', 'Mia Purrs',
  '{"socials":"instagram: @miapurrs, tiktok: @miapurrs"}'::jsonb,
  now() - interval '4 days')
returning id as adm_mia \gset

insert into app.admission_versions (admission_id, status, notes, version_no, created_at, created_by_member_id)
values (:'adm_mia', 'submitted', 'Alice''s friend — runs a popular cat wellness account with 50k followers', 1, now() - interval '4 days', :'member_alice_hound');

-- 3. Warm referral (member_sponsored) to FoxClub — interview_scheduled
insert into app.admissions (club_id, origin, sponsor_member_id, applicant_email, applicant_name, admission_details, created_at)
values (:'club_foxclub', 'member_sponsored', :'member_bob_whiskers', 'noah@example.com', 'Noah Trails',
  '{"socials":"linkedin.com/in/noahtrails"}'::jsonb,
  now() - interval '6 days')
returning id as adm_noah \gset

insert into app.admission_versions (admission_id, status, version_no, created_at, created_by_member_id)
values (:'adm_noah', 'submitted', 1, now() - interval '6 days', :'member_bob_whiskers');

insert into app.admission_versions (admission_id, status, notes, intake_kind, intake_booking_url, intake_booked_at, version_no, created_at, created_by_member_id)
values (:'adm_noah', 'interview_scheduled',
  'Scheduling a fit check call to discuss Noah''s conservation background',
  'fit_check', 'https://calendly.com/clawclub-foxclub/fit-check', now() + interval '2 days',
  2, now() - interval '2 days', :'member_owen_barnes');

-- 4. Owner-nominated to DogClub — accepted (Kevin's admission)
insert into app.admissions (club_id, origin, applicant_member_id, sponsor_member_id, membership_id, created_at)
values (:'club_dogclub', 'owner_nominated', :'member_kevin_spots', :'member_owen_barnes', :'mid_kevin_spots_dogclub',
  now() - interval '6 days')
returning id as adm_kevin \gset

insert into app.admission_versions (admission_id, status, version_no, created_at, created_by_member_id)
values (:'adm_kevin', 'submitted', 1, now() - interval '6 days', :'member_owen_barnes');

insert into app.admission_versions (admission_id, status, notes, version_no, created_at, created_by_member_id)
values (:'adm_kevin', 'accepted', 'Kevin runs an exemplary Dalmatian breeding program. Direct nomination.', 2, now() - interval '5 days', :'member_owen_barnes');

-- 5. Cold application to CatClub — declined
insert into app.admissions (club_id, origin, applicant_email, applicant_name, admission_details, created_at)
values (:'club_catclub', 'self_applied', 'olive@example.com', 'Olive Claws',
  '{"socials":"none","application":"I want to join because I like cats. I have two cats at home."}'::jsonb,
  now() - interval '10 days')
returning id as adm_olive \gset

insert into app.admission_versions (admission_id, status, version_no, created_at)
values (:'adm_olive', 'submitted', 1, now() - interval '10 days');

insert into app.admission_versions (admission_id, status, notes, version_no, created_at, created_by_member_id)
values (:'adm_olive', 'declined',
  'Application did not demonstrate sufficient involvement in cat welfare or community activities. Encouraged to reapply with more detail.',
  2, now() - interval '7 days', :'member_diana_feathers');

-- 6. Warm referral to DogClub — interview_completed, pending decision
insert into app.admissions (club_id, origin, sponsor_member_id, applicant_email, applicant_name, admission_details, created_at)
values (:'club_dogclub', 'member_sponsored', :'member_charlie_paws', 'pete@example.com', 'Pete Runner',
  '{"socials":"strava: pete-runner, instagram: @pete.runs"}'::jsonb,
  now() - interval '8 days')
returning id as adm_pete \gset

insert into app.admission_versions (admission_id, status, notes, version_no, created_at, created_by_member_id)
values (:'adm_pete', 'submitted', 'Pete is my running partner — he just adopted a rescue greyhound and wants to get involved', 1, now() - interval '8 days', :'member_charlie_paws');

insert into app.admission_versions (admission_id, status, intake_kind, intake_booking_url, intake_booked_at, version_no, created_at, created_by_member_id)
values (:'adm_pete', 'interview_scheduled', 'advice_call', 'https://calendly.com/clawclub-dogclub/intro', now() - interval '4 days', 2, now() - interval '6 days', :'member_owen_barnes');

insert into app.admission_versions (admission_id, status, notes, intake_kind, intake_completed_at, version_no, created_at, created_by_member_id)
values (:'adm_pete', 'interview_completed',
  'Great call — Pete is passionate about greyhound rescue. Recommended for acceptance.',
  'advice_call', now() - interval '4 days', 3, now() - interval '4 days', :'member_owen_barnes');

-- ============================================================
-- Admission challenges (cold application flow)
-- ============================================================

-- Active challenge for DogClub (expires in 1 hour)
insert into app.admission_challenges (difficulty, club_id, policy_snapshot, club_name, club_summary, owner_name, expires_at, created_at)
values (7, :'club_dogclub',
  'Members must demonstrate genuine passion for dogs and canine welfare.',
  'DogClub', 'A club for dog lovers and canine professionals.', 'Owen Barnes',
  now() + interval '1 hour', now());

-- Expired challenge for CatClub (with an attempt)
insert into app.admission_challenges (difficulty, club_id, policy_snapshot, club_name, club_summary, owner_name, expires_at, created_at)
values (7, :'club_catclub',
  'We welcome cat enthusiasts who contribute positively to feline communities.',
  'CatClub', 'A club for cat enthusiasts and feline experts.', 'Owen Barnes',
  now() - interval '23 hours', now() - interval '1 day')
returning id as expired_challenge \gset

insert into app.admission_attempts (challenge_id, club_id, attempt_no, applicant_name, applicant_email, payload, gate_status, policy_snapshot, created_at)
values (:'expired_challenge', :'club_catclub', 1, 'Olive Claws', 'olive@example.com',
  '{"socials":"none","application":"I want to join because I like cats. I have two cats at home."}'::jsonb,
  'passed',
  'We welcome cat enthusiasts who contribute positively to feline communities.',
  now() - interval '23 hours' + interval '5 minutes');

-- ============================================================
-- Club activity log
-- ============================================================

insert into app.club_activity (club_id, topic, audience, payload, entity_id, created_by_member_id, created_at) values
  -- DogClub
  (:'club_dogclub', 'entity.version.published', 'members',    '{"kind":"service","title":"Professional Obedience Training"}'::jsonb,  :'dog_svc1',  :'member_alice_hound',  now() - interval '21 days'),
  (:'club_dogclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Annual Dog Show 2026 Recap"}'::jsonb,          :'dog_post1', :'member_alice_hound',  now() - interval '14 days'),
  (:'club_dogclub', 'entity.version.published', 'members',    '{"kind":"opportunity","title":"Dog Walking Business Partnership"}'::jsonb, :'dog_opp1', :'member_owen_barnes', now() - interval '10 days'),
  (:'club_dogclub', 'entity.version.published', 'members',    '{"kind":"event","title":"DogClub Monthly Meetup - April"}'::jsonb,     :'dog_evt1',  :'member_owen_barnes',  now() - interval '8 days'),
  (:'club_dogclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Best Dog-Friendly Hiking Trails"}'::jsonb,     :'dog_post2', :'member_charlie_paws', now() - interval '7 days'),
  (:'club_dogclub', 'membership.activated',     'clubadmins', '{"handle":"kevin-spots","publicName":"Kevin Spots"}'::jsonb,            null,         :'member_owen_barnes',  now() - interval '5 days'),
  (:'club_dogclub', 'admission.submitted',      'clubadmins', '{"applicantName":"Liam Barker","origin":"self_applied"}'::jsonb,        null,         null,                   now() - interval '3 days'),
  (:'club_dogclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Training Tips for Stubborn Breeds"}'::jsonb,    :'dog_post3', :'member_ivan_tusks',   now() - interval '2 days'),
  -- CatClub
  (:'club_catclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Understanding Feline Body Language"}'::jsonb,   :'cat_post1', :'member_alice_hound',    now() - interval '20 days'),
  (:'club_catclub', 'entity.removed',           'members',    '{"kind":"post","title":"CHECK OUT MY BIRD FEEDER STORE!!!","reason":"Promotional spam"}'::jsonb, :'cat_spam', :'member_diana_feathers', now() - interval '15 days'),
  (:'club_catclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Top Cat Toys of 2026"}'::jsonb,                 :'cat_post2', :'member_bob_whiskers',   now() - interval '12 days'),
  (:'club_catclub', 'entity.version.published', 'members',    '{"kind":"event","title":"CatClub Virtual Q&A with a Vet"}'::jsonb,     :'cat_evt1',  :'member_diana_feathers', now() - interval '6 days'),
  (:'club_catclub', 'admission.submitted',      'clubadmins', '{"applicantName":"Mia Purrs","origin":"member_sponsored"}'::jsonb,      null,         :'member_alice_hound',    now() - interval '4 days'),
  -- FoxClub
  (:'club_foxclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Fox Conservation Update Q1 2026"}'::jsonb,      :'fox_post1', :'member_bob_whiskers',  now() - interval '18 days'),
  (:'club_foxclub', 'entity.version.published', 'members',    '{"kind":"service","title":"Wildlife Photography Workshops"}'::jsonb,    :'fox_svc1',  :'member_charlie_paws',  now() - interval '14 days'),
  (:'club_foxclub', 'entity.version.published', 'members',    '{"kind":"post","title":"Wildlife Photography Tips & Tricks"}'::jsonb,   :'fox_post2', :'member_charlie_paws',  now() - interval '9 days'),
  (:'club_foxclub', 'admission.submitted',      'clubadmins', '{"applicantName":"Noah Trails","origin":"member_sponsored"}'::jsonb,    null,         :'member_bob_whiskers',  now() - interval '6 days'),
  (:'club_foxclub', 'entity.version.published', 'members',    '{"kind":"event","title":"Fox Watch Night Walk"}'::jsonb,                :'fox_evt1',  :'member_owen_barnes',   now() - interval '5 days')
on conflict do nothing;

-- ============================================================
-- LLM usage log (quality gate records)
-- ============================================================

insert into app.llm_usage_log (member_id, requested_club_id, action_name, gate_name, provider, model, gate_status, prompt_tokens, completion_tokens, created_at) values
  (:'member_alice_hound',    :'club_dogclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 320, 45, now() - interval '21 days'),
  (:'member_alice_hound',    :'club_dogclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 410, 38, now() - interval '14 days'),
  (:'member_charlie_paws',   :'club_dogclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 350, 42, now() - interval '7 days'),
  (:'member_owen_barnes',    :'club_dogclub', 'events.create',   'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 290, 40, now() - interval '8 days'),
  (:'member_alice_hound',    :'club_catclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 380, 44, now() - interval '20 days'),
  (:'member_bob_whiskers',   :'club_catclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 340, 41, now() - interval '12 days'),
  (:'member_diana_feathers', :'club_catclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 400, 48, now() - interval '8 days'),
  (:'member_bob_whiskers',   :'club_foxclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 420, 50, now() - interval '18 days'),
  (:'member_ivan_tusks',     :'club_foxclub', 'entities.create', 'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 260, 36, now() - interval '5 days'),
  (:'member_owen_barnes',    :'club_foxclub', 'events.create',   'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 310, 41, now() - interval '5 days'),
  (:'member_alice_hound',    null,            'profile.update',  'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 480, 55, now() - interval '25 days'),
  (:'member_owen_barnes',    null,            'profile.update',  'quality_gate', 'openai', 'gpt-5.4-nano', 'passed', 520, 60, now() - interval '30 days')
on conflict do nothing;

commit;
