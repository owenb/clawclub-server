ALTER TABLE app.subscriptions ALTER COLUMN currency SET DEFAULT 'USD';

-- Update the comped subscription function to use the column default instead of hardcoded GBP.
CREATE OR REPLACE FUNCTION app.create_comped_subscription(target_membership_id app.short_id, payer_member_id app.short_id) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
    AS $$
  insert into app.subscriptions (membership_id, payer_member_id, status, amount)
  values (target_membership_id, payer_member_id, 'active', 0);
$$;
