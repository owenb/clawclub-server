begin;

create or replace function app.entity_is_currently_published(target_entity_id app.short_id)
returns boolean
language plpgsql
stable
security definer
set search_path = app, pg_temp
as $$
declare
  is_published boolean;
begin
  select exists (
    select 1
    from app.entity_versions current_ev
    where current_ev.entity_id = target_entity_id
      and current_ev.version_no = (
        select max(latest_ev.version_no)
        from app.entity_versions latest_ev
        where latest_ev.entity_id = target_entity_id
      )
      and current_ev.state = 'published'
  )
  into is_published;

  return coalesce(is_published, false);
end;
$$;

commit;
