alter table public.members
  add column registered_via_invite_request_id public.short_id
    references public.invite_requests(id) on delete set null;

create index members_registered_via_invite_request_idx
  on public.members (registered_via_invite_request_id)
  where registered_via_invite_request_id is not null;

create or replace view producer_contract.member_identity as
 select id as member_id,
    public_name,
    state
   from public.members m;
