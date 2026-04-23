-- One-time fix-up: transfer ownership of every public-schema object from
-- the postgres superuser to clawclub_app.
--
-- WHEN TO RUN: only if a database was bootstrapped under the old
-- multi-role model (objects owned by postgres, clawclub_app holding
-- only data grants). Fresh bootstraps using db/init.sql under the
-- single-role model already create everything as clawclub_app and do
-- NOT need this script.
--
-- USAGE (as a superuser, against the target database):
--   psql "postgresql://postgres:PASSWORD@HOST:PORT/clawclub" \
--     -v ON_ERROR_STOP=1 --single-transaction \
--     -f db/transfer-ownership-to-app-role.sql
--
-- Excludes: the vector extension and any objects it owns. The extension
-- itself stays owned by postgres because clawclub_app cannot CREATE
-- EXTENSION on its own.

DO $$
DECLARE
    target_role constant text := 'clawclub_app';
    stmt text;
    rec record;
BEGIN
    -- Tables (excludes anything owned by an extension)
    FOR rec IN
        SELECT format('ALTER TABLE %I.%I OWNER TO %I', n.nspname, c.relname, target_role) AS stmt
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.objid = c.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE rec.stmt;
    END LOOP;

    -- Views
    FOR rec IN
        SELECT format('ALTER VIEW %I.%I OWNER TO %I', n.nspname, c.relname, target_role) AS stmt
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'v'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.objid = c.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE rec.stmt;
    END LOOP;

    -- Sequences
    FOR rec IN
        SELECT format('ALTER SEQUENCE %I.%I OWNER TO %I', n.nspname, c.relname, target_role) AS stmt
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'S'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.objid = c.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE rec.stmt;
    END LOOP;

    -- Types: enums and composite/domain types defined by the schema.
    -- Excludes any type owned by an extension (vector defines several).
    FOR rec IN
        SELECT format('ALTER TYPE %I.%I OWNER TO %I', n.nspname, t.typname, target_role) AS stmt
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public'
          AND t.typtype IN ('e', 'c', 'd')
          -- Skip composite types that are auto-created for tables (relkind = 'c').
          AND NOT (t.typtype = 'c' AND EXISTS (
            SELECT 1 FROM pg_class c WHERE c.reltype = t.oid
          ))
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.objid = t.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE rec.stmt;
    END LOOP;

    -- Functions (includes the trigger functions defined in init.sql)
    FOR rec IN
        SELECT format(
            'ALTER FUNCTION %I.%I(%s) OWNER TO %I',
            n.nspname,
            p.proname,
            pg_get_function_identity_arguments(p.oid),
            target_role
        ) AS stmt
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
            WHERE d.objid = p.oid AND d.deptype = 'e'
          )
    LOOP
        EXECUTE rec.stmt;
    END LOOP;
END $$;

-- Sanity check: should report 0 if every public-schema table/view/sequence
-- is now owned by clawclub_app (excluding extension-owned objects).
SELECT count(*) AS still_not_owned_by_clawclub_app
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'v', 'S')
  AND r.rolname <> 'clawclub_app'
  AND NOT EXISTS (
    SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e'
  );
