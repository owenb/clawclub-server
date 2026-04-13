insert into quota_policies (scope, club_id, action_name, max_per_day)
select 'global', null, 'content.create', 50
where not exists (
  select 1
  from quota_policies
  where scope = 'global'
    and action_name = 'content.create'
);
