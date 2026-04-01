begin;

-- Superadmin SELECT policies for admin dashboard access.
-- Extends the existing pattern from actor_can_access_member (0016/0037)
-- and network_memberships_select_actor_scope (0031) which already
-- grant superadmin read access to members and memberships.

-- Entities: allow superadmin to read all entities regardless of state or network
drop policy if exists entities_select_superadmin on app.entities;
create policy entities_select_superadmin on app.entities
  for select
  using (app.current_actor_is_superadmin());

-- Entity versions: allow superadmin to read all versions and insert archive versions
drop policy if exists entity_versions_select_superadmin on app.entity_versions;
create policy entity_versions_select_superadmin on app.entity_versions
  for select
  using (app.current_actor_is_superadmin());

drop policy if exists entity_versions_insert_superadmin on app.entity_versions;
create policy entity_versions_insert_superadmin on app.entity_versions
  for insert
  with check (app.current_actor_is_superadmin());

-- Transcript threads: allow superadmin to read all threads
drop policy if exists transcript_threads_select_superadmin on app.transcript_threads;
create policy transcript_threads_select_superadmin on app.transcript_threads
  for select
  using (app.current_actor_is_superadmin());

-- Transcript messages: allow superadmin to read all messages
drop policy if exists transcript_messages_select_superadmin on app.transcript_messages;
create policy transcript_messages_select_superadmin on app.transcript_messages
  for select
  using (app.current_actor_is_superadmin());

-- Bearer tokens: allow superadmin to read and revoke any member's tokens
drop policy if exists member_bearer_tokens_select_superadmin on app.member_bearer_tokens;
create policy member_bearer_tokens_select_superadmin on app.member_bearer_tokens
  for select
  using (app.current_actor_is_superadmin());

drop policy if exists member_bearer_tokens_update_superadmin on app.member_bearer_tokens;
create policy member_bearer_tokens_update_superadmin on app.member_bearer_tokens
  for update
  using (app.current_actor_is_superadmin())
  with check (app.current_actor_is_superadmin());

-- Applications: allow superadmin to read all applications
drop policy if exists applications_select_superadmin on app.applications;
create policy applications_select_superadmin on app.applications
  for select
  using (app.current_actor_is_superadmin());

-- Application versions: allow superadmin to read all application versions
drop policy if exists application_versions_select_superadmin on app.application_versions;
create policy application_versions_select_superadmin on app.application_versions
  for select
  using (app.current_actor_is_superadmin());

commit;
