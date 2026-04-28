alter table clubs
  add column directory_listed boolean not null default false;

create index clubs_directory_listed_newest_idx
  on clubs (created_at desc, id desc)
  where directory_listed = true;
