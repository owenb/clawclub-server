drop view if exists public.live_events;
drop view if exists public.live_entities;
drop view if exists public.current_event_versions;
drop view if exists public.published_entity_versions;
drop view if exists public.current_event_rsvps;
drop view if exists public.current_entity_versions;

create or replace function public.new_id() returns public.short_id
    language plpgsql
as $$
declare
  alphabet constant text := '23456789abcdefghjkmnpqrstuvwxyz';
  output text := '';
  idx integer;
begin
  for idx in 1..12 loop
    output := output || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;

  return output::public.short_id;
end;
$$;

update public.entities
set kind = 'post'
where kind::text = 'complaint';

do $$
declare
  complaint_rows integer;
begin
  select count(*)
    into complaint_rows
  from public.entities
  where kind::text = 'complaint';

  if complaint_rows <> 0 then
    raise exception 'complaint rows remain after rewrite: %', complaint_rows;
  end if;
end
$$;

create type public.content_kind as enum (
  'post',
  'opportunity',
  'service',
  'ask',
  'gift',
  'event'
);

alter table public.entities
  drop constraint if exists entities_open_loop_kind_check;

alter table public.entities
  alter column kind type public.content_kind
  using kind::text::public.content_kind;

drop type public.entity_kind;

alter type public.entity_state rename to content_state;

alter table public.ai_embedding_jobs
  drop constraint if exists ai_embedding_jobs_subject_kind_check;

update public.ai_embedding_jobs
set subject_kind = 'content_version'
where subject_kind = 'entity_version';

alter table public.ai_embedding_jobs
  add constraint ai_embedding_jobs_subject_kind_check
  check (subject_kind in ('member_club_profile_version', 'content_version'));

alter table public.entities rename to contents;
alter table public.entity_versions rename to content_versions;
alter table public.entity_embeddings rename to content_embeddings;
alter table public.entity_version_mentions rename to content_version_mentions;

alter table public.contents rename column content_thread_id to thread_id;
alter table public.content_versions rename column entity_id to content_id;
alter table public.content_embeddings rename column entity_id to content_id;
alter table public.content_embeddings rename column entity_version_id to content_version_id;
alter table public.content_version_mentions rename column entity_version_id to content_version_id;
alter table public.event_version_details rename column entity_version_id to content_version_id;
alter table public.event_rsvps rename column event_entity_id to event_content_id;
alter table public.club_activity rename column entity_id to content_id;
alter table public.club_activity rename column entity_version_id to content_version_id;
alter table public.club_edges rename column from_entity_id to from_content_id;
alter table public.club_edges rename column from_entity_version_id to from_content_version_id;
alter table public.club_edges rename column to_entity_id to to_content_id;
alter table public.club_edges rename column to_entity_version_id to to_content_version_id;
alter table public.dm_threads rename column subject_entity_id to subject_content_id;
alter table public.member_notifications rename column entity_id to content_id;

alter table public.contents
  rename constraint entities_pkey to contents_pkey;
alter table public.contents
  rename constraint entities_author_fkey to contents_author_fkey;
alter table public.contents
  rename constraint entities_club_fkey to contents_club_fkey;
alter table public.contents
  rename constraint entities_content_thread_same_club_fkey to contents_thread_same_club_fkey;
alter table public.contents
  rename constraint entities_id_not_null to contents_id_not_null;
alter table public.contents
  rename constraint entities_club_id_not_null to contents_club_id_not_null;
alter table public.contents
  rename constraint entities_kind_not_null to contents_kind_not_null;
alter table public.contents
  rename constraint entities_author_member_id_not_null to contents_author_member_id_not_null;
alter table public.contents
  rename constraint entities_content_thread_id_not_null to contents_thread_id_not_null;
alter table public.contents
  rename constraint entities_created_at_not_null to contents_created_at_not_null;
alter table public.contents
  rename constraint entities_metadata_not_null to contents_metadata_not_null;

alter table public.content_versions
  rename constraint entity_versions_pkey to content_versions_pkey;
alter table public.content_versions
  rename constraint entity_versions_entity_version_unique to content_versions_content_version_unique;
alter table public.content_versions
  rename constraint entity_versions_created_by_fkey to content_versions_created_by_fkey;
alter table public.content_versions
  rename constraint entity_versions_entity_fkey to content_versions_content_fkey;
alter table public.content_versions
  rename constraint entity_versions_supersedes_fkey to content_versions_supersedes_fkey;
alter table public.content_versions
  rename constraint entity_versions_expiry_check to content_versions_expiry_check;
alter table public.content_versions
  rename constraint entity_versions_version_no_check to content_versions_version_no_check;
alter table public.content_versions
  rename constraint entity_versions_id_not_null to content_versions_id_not_null;
alter table public.content_versions
  rename constraint entity_versions_entity_id_not_null to content_versions_content_id_not_null;
alter table public.content_versions
  rename constraint entity_versions_version_no_not_null to content_versions_version_no_not_null;
alter table public.content_versions
  rename constraint entity_versions_state_not_null to content_versions_state_not_null;
alter table public.content_versions
  rename constraint entity_versions_effective_at_not_null to content_versions_effective_at_not_null;
alter table public.content_versions
  rename constraint entity_versions_created_at_not_null to content_versions_created_at_not_null;

alter table public.content_embeddings
  rename constraint entity_embeddings_pkey to content_embeddings_pkey;
alter table public.content_embeddings
  rename constraint entity_embeddings_unique to content_embeddings_unique;
alter table public.content_embeddings
  rename constraint entity_embeddings_entity_fkey to content_embeddings_content_fkey;
alter table public.content_embeddings
  rename constraint entity_embeddings_version_fkey to content_embeddings_version_fkey;
alter table public.content_embeddings
  rename constraint entity_embeddings_dimensions_check to content_embeddings_dimensions_check;
alter table public.content_embeddings
  rename constraint entity_embeddings_id_not_null to content_embeddings_id_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_entity_id_not_null to content_embeddings_content_id_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_entity_version_id_not_null to content_embeddings_content_version_id_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_model_not_null to content_embeddings_model_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_dimensions_not_null to content_embeddings_dimensions_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_source_version_not_null to content_embeddings_source_version_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_chunk_index_not_null to content_embeddings_chunk_index_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_source_text_not_null to content_embeddings_source_text_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_source_hash_not_null to content_embeddings_source_hash_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_embedding_not_null to content_embeddings_embedding_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_metadata_not_null to content_embeddings_metadata_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_created_at_not_null to content_embeddings_created_at_not_null;
alter table public.content_embeddings
  rename constraint entity_embeddings_updated_at_not_null to content_embeddings_updated_at_not_null;

alter table public.content_version_mentions
  rename constraint entity_version_mentions_pkey to content_version_mentions_pkey;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_field_check to content_version_mentions_field_check;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_offset_check to content_version_mentions_offset_check;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_member_fkey to content_version_mentions_member_fkey;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_version_fkey to content_version_mentions_version_fkey;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_entity_version_id_not_null to content_version_mentions_content_version_id_not_null;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_field_not_null to content_version_mentions_field_not_null;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_start_offset_not_null to content_version_mentions_start_offset_not_null;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_end_offset_not_null to content_version_mentions_end_offset_not_null;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_mentioned_member_id_not_null to content_version_mentions_mentioned_member_id_not_null;
-- Migration 011 renamed authored_handle -> authored_label but Postgres does not
-- rename the auto-generated NOT NULL constraint when a column is renamed. So in
-- production the constraint is still named entity_version_mentions_authored_handle_not_null,
-- while in dev init.sql (regenerated via pg_dump) it appears as authored_label_not_null.
-- Rename whichever one is actually present.
do $$
declare
  existing_name text;
begin
  select conname into existing_name
  from pg_constraint
  where conrelid = 'public.content_version_mentions'::regclass
    and conname in (
      'entity_version_mentions_authored_handle_not_null',
      'entity_version_mentions_authored_label_not_null'
    );

  if existing_name is not null then
    execute format(
      'alter table public.content_version_mentions rename constraint %I to content_version_mentions_authored_label_not_null',
      existing_name
    );
  end if;
end
$$;
alter table public.content_version_mentions
  rename constraint entity_version_mentions_created_at_not_null to content_version_mentions_created_at_not_null;

alter table public.club_activity
  rename constraint club_activity_entity_fkey to club_activity_content_fkey;

alter table public.club_edges
  rename constraint club_edges_from_entity_fkey to club_edges_from_content_fkey;
alter table public.club_edges
  rename constraint club_edges_from_entity_version_fkey to club_edges_from_content_version_fkey;
alter table public.club_edges
  rename constraint club_edges_to_entity_fkey to club_edges_to_content_fkey;
alter table public.club_edges
  rename constraint club_edges_to_entity_version_fkey to club_edges_to_content_version_fkey;

alter table public.dm_threads
  rename constraint dm_threads_subject_entity_fkey to dm_threads_subject_content_fkey;

alter table public.event_rsvps
  rename constraint event_rsvps_event_fkey to event_rsvps_event_content_fkey;
alter table public.event_rsvps
  rename constraint event_rsvps_event_membership_version_unique to event_rsvps_event_content_membership_version_unique;
alter table public.event_rsvps
  rename constraint event_rsvps_event_entity_id_not_null to event_rsvps_event_content_id_not_null;

alter table public.event_version_details
  rename constraint event_version_details_version_fkey to event_version_details_content_version_fkey;
alter table public.event_version_details
  rename constraint event_version_details_entity_version_id_not_null to event_version_details_content_version_id_not_null;

alter table public.member_notifications
  rename constraint member_notifications_entity_fkey to member_notifications_content_fkey;

alter index public.entities_author_idx rename to contents_author_idx;
alter index public.entities_club_kind_idx rename to contents_club_kind_idx;
alter index public.entities_idempotent_idx rename to contents_idempotent_idx;
alter index public.entities_live_idx rename to contents_live_idx;
alter index public.entities_thread_created_idx rename to contents_thread_created_idx;
alter index public.entity_embeddings_entity_idx rename to content_embeddings_content_idx;
alter index public.entity_embeddings_version_idx rename to content_embeddings_version_idx;
alter index public.entity_version_mentions_member_created_idx rename to content_version_mentions_member_created_idx;
alter index public.entity_versions_effective_idx rename to content_versions_effective_idx;
alter index public.entity_versions_entity_version_idx rename to content_versions_content_version_idx;
alter index public.entity_versions_expires_idx rename to content_versions_expires_idx;
alter index public.club_edges_to_entity_idx rename to club_edges_to_content_idx;
alter index public.event_rsvps_event_idx rename to event_rsvps_event_content_idx;
alter index public.event_rsvps_event_membership_version_idx rename to event_rsvps_event_content_membership_version_idx;

alter table public.contents
  add constraint contents_open_loop_kind_check check (
    (
      kind in ('ask', 'gift', 'service', 'opportunity')
      and open_loop is not null
    )
    or (
      kind not in ('ask', 'gift', 'service', 'opportunity')
      and open_loop is null
    )
  );

create view public.current_content_versions as
select distinct on (content_id) id,
  content_id,
  version_no,
  state,
  title,
  summary,
  body,
  effective_at,
  expires_at,
  reason,
  supersedes_version_id,
  created_at,
  created_by_member_id
from public.content_versions
order by content_id, version_no desc, created_at desc;

create view public.published_content_versions as
select id,
  content_id,
  version_no,
  state,
  title,
  summary,
  body,
  effective_at,
  expires_at,
  reason,
  supersedes_version_id,
  created_at,
  created_by_member_id
from public.current_content_versions
where state = 'published'::public.content_state;

create view public.current_event_rsvps as
select distinct on (event_content_id, membership_id) id,
  event_content_id,
  membership_id,
  response,
  note,
  client_key,
  version_no,
  supersedes_rsvp_id,
  created_at,
  created_by_member_id
from public.event_rsvps
order by event_content_id, membership_id, version_no desc, created_at desc;

create view public.current_event_versions as
select ccv.id,
  ccv.content_id,
  ccv.version_no,
  ccv.state,
  ccv.title,
  ccv.summary,
  ccv.body,
  ccv.effective_at,
  ccv.expires_at,
  ccv.reason,
  ccv.supersedes_version_id,
  ccv.created_at,
  ccv.created_by_member_id,
  evd.location,
  evd.starts_at,
  evd.ends_at,
  evd.timezone,
  evd.recurrence_rule,
  evd.capacity
from public.current_content_versions ccv
join public.event_version_details evd
  on evd.content_version_id = ccv.id;

create view public.live_content as
select c.id as content_id,
  c.club_id,
  c.kind,
  c.open_loop,
  c.author_member_id,
  c.thread_id,
  c.created_at as content_created_at,
  pcv.id as content_version_id,
  pcv.version_no,
  pcv.state,
  pcv.title,
  pcv.summary,
  pcv.body,
  pcv.effective_at,
  pcv.expires_at,
  pcv.created_at as version_created_at,
  pcv.created_by_member_id
from public.contents c
join public.published_content_versions pcv
  on pcv.content_id = c.id
where c.archived_at is null
  and c.deleted_at is null
  and (pcv.expires_at is null or pcv.expires_at > now());

create view public.live_events as
select lc.content_id,
  lc.club_id,
  lc.kind,
  lc.open_loop,
  lc.author_member_id,
  lc.thread_id,
  lc.content_created_at,
  lc.content_version_id,
  lc.version_no,
  lc.state,
  lc.title,
  lc.summary,
  lc.body,
  lc.effective_at,
  lc.expires_at,
  lc.version_created_at,
  lc.created_by_member_id,
  evd.location,
  evd.starts_at,
  evd.ends_at,
  evd.timezone,
  evd.recurrence_rule,
  evd.capacity
from public.live_content lc
join public.event_version_details evd
  on evd.content_version_id = lc.content_version_id
where lc.kind = 'event'::public.content_kind;
