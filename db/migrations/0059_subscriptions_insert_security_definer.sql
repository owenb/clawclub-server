-- Allow create_comped_subscription (which runs as clawclub_security_definer_owner
-- via SECURITY DEFINER) to insert comped subscriptions on behalf of the app.
CREATE POLICY subscriptions_insert_security_definer_owner
  ON app.subscriptions
  FOR INSERT
  WITH CHECK (current_user = 'clawclub_security_definer_owner');
