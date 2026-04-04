CREATE TYPE app.quality_gate_status AS ENUM ('passed', 'rejected', 'skipped');

CREATE TABLE app.llm_usage_log (
    id app.short_id DEFAULT app.new_id() NOT NULL,
    member_id app.short_id,
    requested_club_id app.short_id,
    action_name text NOT NULL,
    gate_name text NOT NULL DEFAULT 'quality_gate',
    provider text NOT NULL,
    model text NOT NULL,
    gate_status app.quality_gate_status NOT NULL,
    skip_reason text,
    prompt_tokens integer,
    completion_tokens integer,
    provider_error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT llm_usage_log_pkey PRIMARY KEY (id),
    CONSTRAINT llm_usage_log_member_id_fkey FOREIGN KEY (member_id) REFERENCES app.members(id),
    CONSTRAINT llm_usage_log_skip_reason_check CHECK (
        (gate_status = 'skipped' AND skip_reason IS NOT NULL)
        OR (gate_status <> 'skipped' AND skip_reason IS NULL)
    )
);

CREATE INDEX llm_usage_log_club_created_idx ON app.llm_usage_log (requested_club_id, created_at DESC);
CREATE INDEX llm_usage_log_member_created_idx ON app.llm_usage_log (member_id, created_at DESC);

ALTER TABLE app.llm_usage_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE ONLY app.llm_usage_log FORCE ROW LEVEL SECURITY;

-- Superadmin can read usage logs directly via actor context.
CREATE POLICY llm_usage_log_select_superadmin ON app.llm_usage_log
    FOR SELECT USING (app.current_actor_is_superadmin());

-- Allow the security definer owner role to insert (the log_llm_usage function runs as this role).
CREATE POLICY llm_usage_log_insert_security_definer_owner ON app.llm_usage_log
    FOR INSERT
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

GRANT SELECT ON TABLE app.llm_usage_log TO clawclub_view_owner;
GRANT SELECT, INSERT ON TABLE app.llm_usage_log TO clawclub_security_definer_owner;

-- Security definer function owned by the dedicated definer role, not the migrator.
CREATE FUNCTION app.log_llm_usage(
    p_member_id app.short_id,
    p_requested_club_id app.short_id,
    p_action_name text,
    p_gate_name text,
    p_provider text,
    p_model text,
    p_gate_status app.quality_gate_status,
    p_skip_reason text,
    p_prompt_tokens integer,
    p_completion_tokens integer,
    p_provider_error_code text
) RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
    INSERT INTO app.llm_usage_log (
        member_id, requested_club_id, action_name, gate_name, provider, model,
        gate_status, skip_reason, prompt_tokens, completion_tokens,
        provider_error_code
    ) VALUES (
        p_member_id, p_requested_club_id, p_action_name, p_gate_name, p_provider, p_model,
        p_gate_status, p_skip_reason, p_prompt_tokens, p_completion_tokens,
        p_provider_error_code
    );
$$;

ALTER FUNCTION app.log_llm_usage(app.short_id, app.short_id, text, text, text, text, app.quality_gate_status, text, integer, integer, text)
    OWNER TO clawclub_security_definer_owner;

-- Explicit grants so deployments that skip re-provisioning still work.
GRANT EXECUTE ON FUNCTION app.log_llm_usage(app.short_id, app.short_id, text, text, text, text, app.quality_gate_status, text, integer, integer, text)
    TO clawclub_security_definer_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.log_llm_usage(app.short_id, app.short_id, text, text, text, text, app.quality_gate_status, text, integer, integer, text) TO clawclub_app';
  END IF;
END $$;
