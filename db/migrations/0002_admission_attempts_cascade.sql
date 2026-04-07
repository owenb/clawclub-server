-- Fix FK constraint on admission_attempts: allow cascade delete when
-- the parent admission_challenge is cleaned up after being consumed.
-- Without this, deleting a challenge that has recorded attempts fails
-- with a FK violation (23503).

ALTER TABLE app.admission_attempts
  DROP CONSTRAINT admission_attempts_challenge_fkey,
  ADD CONSTRAINT admission_attempts_challenge_fkey
    FOREIGN KEY (challenge_id) REFERENCES app.admission_challenges(id) ON DELETE CASCADE;
