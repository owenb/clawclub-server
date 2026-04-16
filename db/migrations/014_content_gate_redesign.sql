alter table public.ai_llm_usage_log
  drop constraint ai_llm_usage_log_skip_reason_check;

create type public.content_gate_status as enum (
  'passed',
  'rejected_illegal',
  'rejected_quality',
  'rejected_malformed',
  'skipped',
  'failed'
);

alter table public.ai_llm_usage_log
  alter column gate_status drop default,
  alter column gate_status type public.content_gate_status using (
    case gate_status::text
      when 'passed' then 'passed'::public.content_gate_status
      when 'rejected' then 'rejected_malformed'::public.content_gate_status
      when 'rejected_illegal' then 'rejected_illegal'::public.content_gate_status
      when 'skipped' then 'skipped'::public.content_gate_status
      else 'rejected_malformed'::public.content_gate_status
    end
  );

drop type public.quality_gate_status;

alter table public.ai_llm_usage_log
  rename column gate_name to artifact_kind;

alter table public.ai_llm_usage_log
  alter column artifact_kind drop default;

alter table public.ai_llm_usage_log
  add column feedback text;

alter table public.ai_llm_usage_log
  add constraint ai_llm_usage_log_skip_reason_check check (
    (gate_status = 'skipped'::public.content_gate_status and skip_reason is not null)
    or
    (gate_status <> 'skipped'::public.content_gate_status and skip_reason is null)
  );
