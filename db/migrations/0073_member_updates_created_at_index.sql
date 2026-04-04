-- Index on member_updates(created_at) to support future retention cleanup queries.
-- Adding now while the table is small; adding later on a large table takes hours.
CREATE INDEX IF NOT EXISTS member_updates_created_at_idx
  ON app.member_updates (created_at);
