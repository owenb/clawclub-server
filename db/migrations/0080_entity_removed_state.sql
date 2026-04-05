-- Add 'removed' to entity_state enum.
-- Must be in a separate migration because ALTER TYPE ADD VALUE
-- cannot be used in the same transaction as DML referencing the new value.
ALTER TYPE app.entity_state ADD VALUE IF NOT EXISTS 'removed';
