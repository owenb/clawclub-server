-- 0054_rename_cold_application_functions.sql
--
-- Finish the admissions rename: replace "cold_application" with "admission"
-- in the remaining security definer function names.

begin;

-- Rename create_cold_application_challenge → create_admission_challenge
alter function app.create_cold_application_challenge(integer, integer)
  rename to create_admission_challenge;

-- Rename get_cold_application_challenge → get_admission_challenge
alter function app.get_cold_application_challenge(app.short_id)
  rename to get_admission_challenge;

-- Rename delete_cold_application_challenge → delete_admission_challenge
alter function app.delete_cold_application_challenge(app.short_id)
  rename to delete_admission_challenge;

commit;
