alter table club_applicant_blocks
  drop constraint club_applicant_blocks_block_kind_check;

alter table club_applicant_blocks
  add column expires_at timestamptz,
  add column source text;

alter table club_applicant_blocks
  add constraint club_applicant_blocks_block_kind_check
  check (block_kind = any (array['declined'::text, 'banned'::text, 'removed'::text]));

create index club_applicant_blocks_active_lookup_idx
  on club_applicant_blocks (club_id, member_id, expires_at);

with ranked_open_invites as (
  select id,
         row_number() over (
           partition by club_id,
                        sponsor_member_id,
                        candidate_email_normalized
           order by created_at desc, id desc
         ) as rn
    from invite_requests
   where revoked_at is null
     and used_at is null
     and expired_at is null
)
update invite_requests ir
   set expired_at = coalesce(ir.expired_at, now())
  from ranked_open_invites ranked
 where ranked.id = ir.id
   and ranked.rn > 1;

drop index if exists invite_requests_open_per_sponsor_email_candidate_idx;
drop index if exists invite_requests_open_per_sponsor_member_candidate_idx;

create unique index invite_requests_open_per_sponsor_candidate_idx
  on invite_requests (
    club_id,
    sponsor_member_id,
    candidate_email_normalized
  )
  where revoked_at is null
    and used_at is null
    and expired_at is null;
