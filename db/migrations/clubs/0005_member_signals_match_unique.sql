-- Upgrade member_signals.match_id index from plain to unique.
-- Prevents duplicate signals for the same match on crash-retry.
--
-- Preflight: delete any duplicate match_id rows that may exist in
-- already-migrated environments (keep the earliest signal per match_id).

DELETE FROM app.member_signals
WHERE match_id IS NOT NULL
  AND id NOT IN (
    SELECT DISTINCT ON (match_id) id
    FROM app.member_signals
    WHERE match_id IS NOT NULL
    ORDER BY match_id, seq ASC
  );

-- Drop the old non-unique index (from 0002)
DROP INDEX IF EXISTS app.member_signals_match_idx;

-- Create the unique partial index
CREATE UNIQUE INDEX member_signals_match_unique_idx
    ON app.member_signals (match_id)
    WHERE match_id IS NOT NULL;
