DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'signal_deliveries'
    ) AND NOT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'member_notifications'
    ) THEN
        ALTER TABLE public.signal_deliveries RENAME TO member_notifications;
    END IF;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_pkey') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_pkey TO member_notifications_pkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_seq_unique') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_seq_unique TO member_notifications_seq_unique;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_topic_check') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_topic_check TO member_notifications_topic_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_ack_state_check') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_ack_state_check TO member_notifications_ack_state_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_suppression_check') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_suppression_check TO member_notifications_suppression_check;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_club_fkey') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_club_fkey TO member_notifications_club_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_recipient_fkey') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_recipient_fkey TO member_notifications_recipient_fkey;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'signal_deliveries_entity_fkey') THEN
        ALTER TABLE public.member_notifications
            RENAME CONSTRAINT signal_deliveries_entity_fkey TO member_notifications_entity_fkey;
    END IF;
END;
$$;

ALTER INDEX IF EXISTS public.signal_deliveries_recipient_poll_idx
    RENAME TO member_notifications_recipient_poll_idx;
ALTER INDEX IF EXISTS public.signal_deliveries_match_unique_idx
    RENAME TO member_notifications_match_unique_idx;
ALTER SEQUENCE IF EXISTS public.signal_deliveries_seq_seq
    RENAME TO member_notifications_seq_seq;

ALTER TABLE IF EXISTS public.member_notifications
    ALTER COLUMN club_id DROP NOT NULL;

UPDATE public.member_notifications
SET topic = CASE topic
    WHEN 'signal.ask_match' THEN 'synchronicity.ask_to_member'
    WHEN 'signal.offer_match' THEN 'synchronicity.offer_to_ask'
    WHEN 'signal.introduction' THEN 'synchronicity.member_to_member'
    WHEN 'signal.event_suggestion' THEN 'synchronicity.event_to_member'
    ELSE topic
END
WHERE topic IN (
    'signal.ask_match',
    'signal.offer_match',
    'signal.introduction',
    'signal.event_suggestion'
);

DROP TRIGGER IF EXISTS member_notifications_notify ON public.member_notifications;
DROP TRIGGER IF EXISTS signal_deliveries_notify ON public.member_notifications;
DROP TRIGGER IF EXISTS club_activity_notify ON public.club_activity;
DROP TRIGGER IF EXISTS dm_inbox_entries_notify ON public.dm_inbox_entries;
DROP TRIGGER IF EXISTS admission_versions_notify ON public.admission_versions;

DROP FUNCTION IF EXISTS public.notify_member_notification();
DROP FUNCTION IF EXISTS public.notify_signal_delivery();
DROP FUNCTION IF EXISTS public.notify_club_activity();
DROP FUNCTION IF EXISTS public.notify_dm_inbox();
DROP FUNCTION IF EXISTS public.notify_admission_version();

CREATE FUNCTION public.notify_club_activity() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,
        'kind', 'activity'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER club_activity_notify
    AFTER INSERT ON public.club_activity
    FOR EACH ROW EXECUTE FUNCTION public.notify_club_activity();

CREATE FUNCTION public.notify_member_notification() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'clubId', NEW.club_id,
        'recipientMemberId', NEW.recipient_member_id,
        'kind', 'notification'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER member_notifications_notify
    AFTER INSERT ON public.member_notifications
    FOR EACH ROW EXECUTE FUNCTION public.notify_member_notification();

CREATE FUNCTION public.notify_dm_inbox() RETURNS trigger
    LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('stream', json_build_object(
        'recipientMemberId', NEW.recipient_member_id,
        'kind', 'message'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER dm_inbox_entries_notify
    AFTER INSERT ON public.dm_inbox_entries
    FOR EACH ROW EXECUTE FUNCTION public.notify_dm_inbox();

CREATE FUNCTION public.notify_admission_version() RETURNS trigger
    LANGUAGE plpgsql
AS $$
DECLARE
    v_club_id short_id;
BEGIN
    SELECT club_id INTO v_club_id
    FROM public.admissions
    WHERE id = NEW.admission_id;

    PERFORM pg_notify('stream', json_build_object(
        'clubId', v_club_id,
        'kind', 'admission_version'
    )::text);
    RETURN NEW;
END;
$$;

CREATE TRIGGER admission_versions_notify
    AFTER INSERT ON public.admission_versions
    FOR EACH ROW EXECUTE FUNCTION public.notify_admission_version();
