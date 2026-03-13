begin;

create or replace view app.current_profile_version_embeddings as
select distinct on (e.member_profile_version_id)
  e.id,
  e.member_profile_version_id,
  e.model,
  e.dimensions,
  e.source_text,
  e.metadata,
  e.created_at
from app.embeddings e
where e.member_profile_version_id is not null
order by e.member_profile_version_id, e.created_at desc, e.id desc;

create or replace view app.current_entity_version_embeddings as
select distinct on (e.entity_version_id)
  e.id,
  e.entity_version_id,
  e.model,
  e.dimensions,
  e.source_text,
  e.metadata,
  e.created_at
from app.embeddings e
where e.entity_version_id is not null
order by e.entity_version_id, e.created_at desc, e.id desc;

commit;
