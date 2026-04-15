do $$
declare
  unexpected_views text[];
begin
  select array_agg(viewname order by viewname)
    into unexpected_views
  from pg_catalog.pg_views
  where schemaname = 'public'
    and viewname in (
      select distinct dependent.relname
      from pg_catalog.pg_depend dep
      join pg_catalog.pg_rewrite rw
        on rw.oid = dep.objid
      join pg_catalog.pg_class dependent
        on dependent.oid = rw.ev_class
      join pg_catalog.pg_class referenced
        on referenced.oid = dep.refobjid
      join pg_catalog.pg_attribute attr
        on attr.attrelid = referenced.oid
       and attr.attnum = dep.refobjsubid
      where dependent.relkind = 'v'
        and referenced.relname in ('entities', 'entity_versions')
        and attr.attname in ('parent_entity_id', 'content')
    )
    and viewname not in (
      'current_entity_versions',
      'published_entity_versions',
      'current_event_versions',
      'live_entities',
      'live_events'
    );

  if unexpected_views is not null then
    raise exception 'unexpected dependent views on entities.parent_entity_id / entity_versions.content: %', array_to_string(unexpected_views, ', ');
  end if;
end
$$;

do $$
declare
  unexpected_profile_views text[];
begin
  select array_agg(viewname order by viewname)
    into unexpected_profile_views
  from pg_catalog.pg_views
  where schemaname = 'public'
    and viewname in (
      select distinct dependent.relname
      from pg_catalog.pg_depend dep
      join pg_catalog.pg_rewrite rw
        on rw.oid = dep.objid
      join pg_catalog.pg_class dependent
        on dependent.oid = rw.ev_class
      join pg_catalog.pg_class referenced
        on referenced.oid = dep.refobjid
      join pg_catalog.pg_attribute attr
        on attr.attrelid = referenced.oid
       and attr.attnum = dep.refobjsubid
      where dependent.relkind = 'v'
        and referenced.relname = 'member_club_profile_versions'
        and attr.attname = 'profile'
    )
    and viewname not in ('current_member_club_profiles');

  if unexpected_profile_views is not null then
    raise exception 'unexpected dependent views on member_club_profile_versions.profile: %', array_to_string(unexpected_profile_views, ', ');
  end if;
end
$$;

drop view public.live_events;
drop view public.live_entities;
drop view public.current_event_versions;
drop view public.published_entity_versions;
drop view public.current_entity_versions;
drop view public.current_member_club_profiles;

drop trigger member_club_profile_versions_immutable on public.member_club_profile_versions;

create function public._normalize_profile_link_item(item jsonb)
returns jsonb
language plpgsql
as $$
declare
  url_text text;
  label_text text;
begin
  case jsonb_typeof(item)
    when 'string' then
      return jsonb_build_object(
        'url', item #>> '{}',
        'label', null
      );
    when 'object' then
      if not (item ? 'url') then
        raise exception 'links item missing url: %', item::text;
      end if;
      if jsonb_typeof(item->'url') <> 'string' then
        raise exception 'links item url must be a string: %', item::text;
      end if;

      url_text := item->>'url';

      if item ? 'handle' then
        if jsonb_typeof(item->'handle') <> 'string' then
          raise exception 'links item handle must be a string when present: %', item::text;
        end if;
        label_text := item->>'handle';
      elsif item ? 'type' then
        if jsonb_typeof(item->'type') <> 'string' then
          raise exception 'links item type must be a string when present: %', item::text;
        end if;
        label_text := item->>'type';
      elsif item ? 'label' then
        if jsonb_typeof(item->'label') not in ('string', 'null') then
          raise exception 'links item label must be a string or null when present: %', item::text;
        end if;
        if jsonb_typeof(item->'label') = 'string' then
          label_text := item->>'label';
        else
          label_text := null;
        end if;
      else
        label_text := null;
      end if;

      return jsonb_build_object(
        'url', url_text,
        'label', label_text
      );
    else
      raise exception 'unsupported links item type (%): %', jsonb_typeof(item), item::text;
  end case;
end
$$;

create function public._normalize_profile_links_array(input jsonb)
returns jsonb
language plpgsql
as $$
declare
  output jsonb;
begin
  if input is null then
    raise exception 'links unexpectedly NULL';
  end if;

  if jsonb_typeof(input) <> 'array' then
    raise exception 'links must be a JSON array, got %: %', jsonb_typeof(input), input::text;
  end if;

  select coalesce(jsonb_agg(public._normalize_profile_link_item(item) order by ordinality), '[]'::jsonb)
    into output
  from jsonb_array_elements(input) with ordinality as elems(item, ordinality);

  return output;
end
$$;

update public.member_club_profile_versions
set links = public._normalize_profile_links_array(links)
where true;

do $$
declare
  bad_count integer;
begin
  select count(*)
    into bad_count
  from public.member_club_profile_versions p,
       jsonb_array_elements(p.links) as item
  where jsonb_typeof(item) <> 'object'
     or (select count(*) from jsonb_object_keys(item)) <> 2
     or not (item ? 'url')
     or not (item ? 'label')
     or jsonb_typeof(item->'url') <> 'string'
     or jsonb_typeof(item->'label') not in ('string', 'null');

  if bad_count > 0 then
    raise exception 'links normalization left % malformed items', bad_count;
  end if;
end
$$;

drop function public._normalize_profile_links_array(jsonb);
drop function public._normalize_profile_link_item(jsonb);

create trigger member_club_profile_versions_immutable
before delete or update on public.member_club_profile_versions
for each row execute function public.reject_row_mutation();

alter table public.entity_versions
  drop column content;

alter table public.member_club_profile_versions
  drop column profile;

alter table public.entities
  drop constraint entities_parent_fkey;

drop index public.entities_parent_idx;

alter table public.entities
  drop column parent_entity_id;

create view public.current_entity_versions as
select distinct on (entity_id) id,
  entity_id,
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
from public.entity_versions
order by entity_id, version_no desc, created_at desc;

create view public.published_entity_versions as
select id,
  entity_id,
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
from public.current_entity_versions
where state = 'published'::public.entity_state;

create view public.current_event_versions as
select cev.id,
  cev.entity_id,
  cev.version_no,
  cev.state,
  cev.title,
  cev.summary,
  cev.body,
  cev.effective_at,
  cev.expires_at,
  cev.reason,
  cev.supersedes_version_id,
  cev.created_at,
  cev.created_by_member_id,
  evd.location,
  evd.starts_at,
  evd.ends_at,
  evd.timezone,
  evd.recurrence_rule,
  evd.capacity
from public.current_entity_versions cev
join public.event_version_details evd
  on evd.entity_version_id = cev.id;

create view public.live_entities as
select e.id as entity_id,
  e.club_id,
  e.kind,
  e.open_loop,
  e.author_member_id,
  e.content_thread_id,
  e.created_at as entity_created_at,
  pev.id as entity_version_id,
  pev.version_no,
  pev.state,
  pev.title,
  pev.summary,
  pev.body,
  pev.effective_at,
  pev.expires_at,
  pev.created_at as version_created_at,
  pev.created_by_member_id
from public.entities e
join public.published_entity_versions pev
  on pev.entity_id = e.id
where e.archived_at is null
  and e.deleted_at is null
  and (pev.expires_at is null or pev.expires_at > now());

create view public.live_events as
select le.entity_id,
  le.club_id,
  le.kind,
  le.open_loop,
  le.author_member_id,
  le.content_thread_id,
  le.entity_created_at,
  le.entity_version_id,
  le.version_no,
  le.state,
  le.title,
  le.summary,
  le.body,
  le.effective_at,
  le.expires_at,
  le.version_created_at,
  le.created_by_member_id,
  evd.location,
  evd.starts_at,
  evd.ends_at,
  evd.timezone,
  evd.recurrence_rule,
  evd.capacity
from public.live_entities le
join public.event_version_details evd
  on evd.entity_version_id = le.entity_version_id
where le.kind = 'event'::public.entity_kind;

create view public.current_member_club_profiles as
select distinct on (member_id, club_id) id,
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
  search_vector,
  created_at,
  created_by_member_id,
  generation_source
from public.member_club_profile_versions
order by member_id, club_id, version_no desc, created_at desc;
