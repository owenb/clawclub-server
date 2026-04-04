CREATE UNIQUE INDEX subscriptions_active_membership_idx
    ON app.subscriptions (membership_id)
    WHERE status IN ('trialing', 'active');
