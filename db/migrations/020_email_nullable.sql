-- Drop the NOT NULL constraint so legacy members with no real email can be
-- represented as NULL rather than with synthetic @unknown.local addresses.
-- The application layer enforces email on account/contact creation paths that
-- require it; NULL is now the canonical representation of "no email on record."
alter table members
  alter column email drop not null;

update members
   set email = null
 where lower(email) like '%@unknown.local';
