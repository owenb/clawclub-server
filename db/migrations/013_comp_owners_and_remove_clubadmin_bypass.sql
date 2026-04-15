UPDATE public.club_memberships cm
SET is_comped = true,
    comped_at = coalesce(cm.comped_at, now()),
    comped_by_member_id = null
FROM public.current_club_memberships ccm
JOIN public.clubs c ON c.id = ccm.club_id
WHERE cm.id = ccm.id
  AND c.owner_member_id = ccm.member_id
  AND ccm.left_at IS NULL
  AND cm.is_comped = false;

DROP VIEW public.accessible_club_memberships;

CREATE VIEW public.accessible_club_memberships AS
SELECT
  id,
  club_id,
  member_id,
  sponsor_member_id,
  role,
  status,
  joined_at,
  left_at,
  accepted_covenant_at,
  metadata,
  is_comped,
  comped_at,
  comped_by_member_id,
  approved_price_amount,
  approved_price_currency,
  application_name,
  application_email,
  application_email_normalized,
  application_socials,
  application_text,
  applied_at,
  application_submitted_at,
  submission_path,
  proof_kind,
  invitation_id,
  generated_profile_draft,
  state_version_id,
  state_reason,
  state_version_no,
  state_created_at,
  state_created_by_member_id
FROM public.current_club_memberships cm
WHERE left_at IS NULL
  AND (
    (is_comped = true AND status = 'active'::public.membership_state)
    OR (
      status = ANY (ARRAY['active'::public.membership_state, 'cancelled'::public.membership_state])
      AND EXISTS (
        SELECT 1
        FROM public.club_subscriptions s
        WHERE s.membership_id = cm.id
          AND s.status = ANY (ARRAY['trialing'::public.subscription_status, 'active'::public.subscription_status, 'past_due'::public.subscription_status])
          AND coalesce(s.ended_at, 'infinity'::timestamptz) > now()
          AND coalesce(s.current_period_end, 'infinity'::timestamptz) > now()
      )
    )
    OR (status = 'renewal_pending'::public.membership_state AND (state_created_at + '7 days'::interval) > now())
  );
