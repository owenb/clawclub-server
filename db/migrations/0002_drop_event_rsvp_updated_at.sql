begin;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'app'
      and table_name = 'event_rsvps'
      and column_name = 'updated_at'
  ) then
    alter table app.event_rsvps drop column updated_at;
  end if;
end
$$;

commit;
