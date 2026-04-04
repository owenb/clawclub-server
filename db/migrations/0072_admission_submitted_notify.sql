-- Notify club owner when a new admission is submitted (cold or warm).
-- Security definer owned by clawclub_security_definer_owner so it can INSERT
-- into member_updates (which has FORCE ROW LEVEL SECURITY).

-- 1. Grant INSERT on member_updates to the definer role (currently only has SELECT).
GRANT INSERT ON TABLE app.member_updates TO clawclub_security_definer_owner;

-- 2. RLS policy allowing the definer role to insert notifications.
CREATE POLICY member_updates_insert_security_definer_owner ON app.member_updates
    FOR INSERT
    WITH CHECK (current_user = 'clawclub_security_definer_owner');

-- 3. The function itself.
CREATE FUNCTION app.notify_admission_submitted(
  target_club_id app.short_id,
  target_payload jsonb,
  target_created_by_member_id app.short_id DEFAULT NULL
) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
AS $$
  INSERT INTO app.member_updates (
    recipient_member_id,
    club_id,
    topic,
    payload,
    created_by_member_id
  )
  SELECT
    c.owner_member_id,
    target_club_id,
    'admission.submitted',
    target_payload,
    target_created_by_member_id
  FROM app.clubs c
  WHERE c.id = target_club_id
    AND c.owner_member_id IS NOT NULL
    AND c.owner_member_id IS DISTINCT FROM target_created_by_member_id;
$$;

ALTER FUNCTION app.notify_admission_submitted(app.short_id, jsonb, app.short_id)
    OWNER TO clawclub_security_definer_owner;

GRANT EXECUTE ON FUNCTION app.notify_admission_submitted(app.short_id, jsonb, app.short_id)
    TO clawclub_view_owner;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clawclub_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app.notify_admission_submitted(app.short_id, jsonb, app.short_id) TO clawclub_app';
  END IF;
END $$;
