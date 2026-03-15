begin;

do $$
begin
  if not exists (
    select 1
    from pg_roles
    where rolname = 'clawclub_view_owner'
  ) then
    create role clawclub_view_owner
      nologin
      nosuperuser
      nocreatedb
      nocreaterole
      noinherit
      noreplication;
  end if;
end
$$;

grant usage on schema app to clawclub_view_owner;
grant select on all tables in schema app to clawclub_view_owner;
grant execute on all functions in schema app to clawclub_view_owner;

alter default privileges in schema app
  grant select on tables to clawclub_view_owner;

alter default privileges in schema app
  grant execute on functions to clawclub_view_owner;

do $$
declare
  view_name text;
begin
  for view_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'app'
      and c.relkind = 'v'
  loop
    execute format('alter view app.%I owner to clawclub_view_owner', view_name);
  end loop;
end
$$;

commit;
