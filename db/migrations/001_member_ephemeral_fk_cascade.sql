alter table only public.club_activity_cursors
  drop constraint if exists club_activity_cursors_member_fkey;

alter table only public.club_activity_cursors
  add constraint club_activity_cursors_member_fkey
  foreign key (member_id) references public.members(id) on delete cascade;

alter table only public.member_bearer_tokens
  drop constraint if exists member_bearer_tokens_member_fkey;

alter table only public.member_bearer_tokens
  add constraint member_bearer_tokens_member_fkey
  foreign key (member_id) references public.members(id) on delete cascade;

alter table only public.member_profile_embeddings
  drop constraint if exists member_profile_embeddings_member_fkey;

alter table only public.member_profile_embeddings
  add constraint member_profile_embeddings_member_fkey
  foreign key (member_id) references public.members(id) on delete cascade;
