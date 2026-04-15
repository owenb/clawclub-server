# Strict wire inputs and full handles purge — revision 2

**Status:** Revised after first investigation. Direction unchanged, details corrected. Investigate again before implementing and push back on anything that doesn't match what you see in the code.
**Supersedes:** the first revision of this same file.
**Blocks:** nothing. Schema cleanup commits `ab972fe` and `9fd2c57` are already live in prod. This is the next side quest on top of that.
**Side quest:** Yes. The main thread we're protecting is the content quality/legality gate redesign in `plans/content-quality-gate-redesign.md`. That work resumes after this lands. Do not touch the gate plan or gate code.

## What changed from revision 1

The first revision pointed in the right direction but was wrong on three substantive details and incomplete on a fourth. Your prior investigation caught all of them. Summary of the corrections now baked into this revision:

1. **`src/schema-endpoint.ts` is part of the fix, not a side note.** That file currently calls `relaxInputSchema(...)` on every action input at line 63 and explicitly strips `additionalProperties: false` at lines 72 and 168. Registry-side strictness fixes *runtime* behavior, but `/api/schema` will still lie to agents about input shape unless the endpoint stops relaxing. Both halves have to land in the same commit or the API contract stays inconsistent.

2. **The `.refine()` refactor precaution is gone.** In this repo's Zod version, `.refine()` on a `ZodObject` preserves the object type — it does NOT wrap in `ZodEffects`. Central `schema.strict()` applied at registration preserves the refines on the two refined inputs (`content.update` parse at `src/schemas/entities.ts:287` and `content.getThread` parse at `src/schemas/entities.ts:430`) with no refactor needed. Drop the "throw on ZodEffects-wrapped objects" rule from rev 1 entirely.

3. **Nested object strictness is explicitly in scope.** Root-level enforcement is not enough. Nested helpers like `parseEventFieldsCreate` at `src/schemas/fields.ts:307` are still permissive, and `content.create` currently accepts `event: { location, startsAt, junk: 1 }` successfully. If the product rule is "every member-writable field has a complete contract," nested objects are member-writable fields too.

4. **The handles purge scope was incomplete.** Additional broken scripts, additional dead harness params, and additional stale fixture files were all missed in rev 1. The expanded list is below. Confirmed from investigation: the dead TS `handle` types in `src/clubs/entities.ts:73` and `src/postgres.ts:385` are genuinely harmless — the SQL at `src/clubs/entities.ts:396, 410` and `src/postgres.ts:424` does not actually select them. No hidden P0. Still dead type cruft that gets removed.

5. **Minor:** rev 1's verification example used `events.create`, which isn't a real action. The actual path is `content.create(kind='event')`. Fixed below.

## Why this exists

**Problem 1.** Action wire inputs do not reject unknown keys at runtime. Sending `content.create` with a `content: {...}` field (dropped by the recent cleanup) returns `ok: true` and silently strips it. An agent pasting a removed field gets zero signal that anything is wrong.

**Problem 2.** `/api/schema` does not advertise strictness on the input side. Response-side schemas emit `additionalProperties: false`; input-side schemas don't — even when the underlying Zod *could* be strict — because `relaxInputSchema` strips it. Agents reading the schema can't predict rejection and only learn via 400s.

**Problem 3.** Migration 011 removed `members.handle` but the surrounding code was never fully swept. Two operational scripts reference the dead column and would fail on first invocation. A regex constant kept its `HANDLE_*` name after being repurposed for slug validation. Several test fixtures carry `handle: '...'` literals that propagate the dead concept. Dead TS field declarations remain in two repository row types.

Underneath all three: the platform's "every member-writable field has a complete contract" principle is enforced inconsistently, and the recent schema cleanup exposed exactly where the holes are. This commit closes the holes.

## Scope

In:
1. Strict-by-default at every level of action inputs — root AND nested.
2. Matching fix in `src/schema-endpoint.ts` so `/api/schema` advertises input strictness.
3. Full handle remnant purge: scripts, TS types, regex rename, stale comments, test fixtures.
4. Delete `scripts/backfill-mentions.ts` outright (obsolete, tied to removed identity model).
5. Single commit on top of the plans checkpoint. Bump `0.2.61` → `0.2.62`. Commit locally. Do not push.

Out:
- Content quality/legality gate code or plan. Paused. Not touched.
- Internal audit/workflow `jsonb` columns on non-public tables (`club_memberships.metadata`, `member_bearer_tokens.metadata`, `entity_embeddings.metadata`, etc.). Server-set, not member-writable, not in scope.
- Historical files: migration files, `db/init.sql` ledger, `plans/`, `docs/`, `company/`. Frozen records.
- The `handle` JSON key reference inside migration 012's link normalization function — that's social-media `@handle`, a completely different concept from the removed user identity handle.

## Part 1: Strict-by-default (three layers)

Missing any single layer leaves a hole. All three have to land together.

### Layer 1 — root enforcement, centralized in the registry

Your prior investigation confirmed `src/schemas/registry.ts` is the correct interception point (actions register at line 223; parse runs against stored schemas at line 254). Modify the registration path so that when an action is stored, `.strict()` is applied at the top level of both `wire.input` and `parse.input`.

One line per schema; no recursion at this layer; no walker.

`.strict()` in this Zod version preserves refines on `ZodObject`. The two refined cases (`content.update` parse, `content.getThread` parse) do NOT need any reordering — the central strictification works on them as-is. Confirm this with a spot test before relying on it (see Pre-investigation).

### Layer 2 — explicit strictness on shared nested helpers

Central root-level strict does not recurse into nested objects. Any nested `z.object(...)` referenced by an action input stays permissive unless its own definition is strict. Fix this by adding `.strict()` directly to every shared nested helper used in action inputs.

Known helpers that need it (from prior investigation plus the audit below):
- `wireEventFieldsCreate` — `src/schemas/fields.ts:307`
- `parseEventFieldsCreate` — same file, paired
- `wireEventFieldsPatch` — same file, patch variant
- `parseEventFieldsPatch` — same file, paired

The existing `profileLink` and `parseProfileLink` helpers in `src/schemas/fields.ts` are already strict from the recent cleanup commit — keep them as the reference pattern for what good looks like.

**Audit required.** Grep `src/schemas/*.ts` for every nested `z.object({...})` that appears inside an action wire or parse input. Three cases to handle:

- Shared helper in `fields.ts` already strict → leave alone.
- Shared helper in `fields.ts` not yet strict → append `.strict()` to its definition.
- Inline nested object defined in an action file (e.g. `event: z.object({...})` written directly inside the action's wire input) → either extract to a helper in `fields.ts` and strictify (preferred if reused), or apply `.strict()` inline at the definition site (acceptable for one-offs).

List every nested object you find, with its file path and which action uses it, in the handoff report.

### Layer 3 — schema endpoint export

`src/schema-endpoint.ts` currently calls `relaxInputSchema(...)` for every action input at line 63 and strips `additionalProperties: false` at lines 72 and 168. This is why `/api/schema` hides input-side strictness even when the underlying Zod schema is strict.

Before surgery: read the file end-to-end. Understand what `relaxInputSchema` does, why it exists, what else calls it, and what it's protecting against. Decide the cleanest fix based on what you actually see.

Two likely shapes for the fix:
- **Preferred if feasible:** stop calling `relaxInputSchema` on action inputs. If the function still has a legitimate role elsewhere (e.g. for response-side output), scope its application to those cases only.
- **Alternative:** teach `relaxInputSchema` to preserve `additionalProperties: false` while doing whatever else it's legitimately doing. Drop the two strip-sites at lines 72 and 168 but keep the rest.

Either way, the end state must be: `/api/schema` for `profile.update` and `content.create` includes `additionalProperties: false` on both the top-level input object AND nested objects that were strictified in Layer 2.

Report in your handoff: which shape you picked and why.

### Defense-in-depth (optional, low priority)

Consider a startup assertion that traverses every registered action's input schema tree and throws if any nested `ZodObject` is not strict. This is a READ-ONLY walker — it inspects and reports, it does NOT rebuild or mutate schemas. Lower risk than a write-walker, and it catches future drift without requiring per-helper discipline forever.

If it's cheap to implement in this Zod version, do it — it's a free safety net. If schema introspection turns fiddly, skip it. The primary enforcement is Layers 1, 2, and 3; the assertion is a belt on top.

If you skip it, note that in the handoff.

### Pre-investigation (required before writing code)

Verify these four things before touching anything:

1. **Confirm `.strict()` preserves refines in this Zod version.** Write a throwaway test: `const s = z.object({ a: z.number() }).refine(v => v.a > 0, 'a must be positive').strict();` then parse `{ a: -1, extra: 1 }` and confirm both errors fire (the refine error AND the unrecognized-key error). If only one fires, the plan's core assumption is wrong and we need to stop and discuss.

2. **Enumerate every registered action's input schemas and check the root type.** Your earlier investigation found they're all `ZodObject`. Reconfirm in one script run before proceeding. Print `schema._def.typeName` (or the equivalent in this Zod version) for each. If any action's root input is NOT a `ZodObject` — e.g. a primitive, array, union, or `ZodEffects` — surface it before touching the registry; the central helper will need to handle it or reject it.

3. **Audit nested objects.** Grep `src/schemas/*.ts` for every nested `z.object({...})` appearing in a wire or parse input. Classify each one: shared helper already strict / shared helper needs strict / inline definition. Produce the full list before writing code.

4. **Read `src/schema-endpoint.ts` end-to-end.** Understand the full role of `relaxInputSchema` before touching it. Produce a one-paragraph summary of what it does and what it's protecting against. Only then decide the surgery shape.

### Implementation steps (in order)

1. Pre-investigation complete and documented. If anything above came back unexpected, stop and report.
2. Add the central strict helper in `src/schemas/registry.ts`. Apply `.strict()` to both `wire.input` and `parse.input` at registration time.
3. Strictify every shared nested helper in `src/schemas/fields.ts` (and anywhere else the audit surfaced one). Append `.strict()` to each.
4. Extract or inline-strictify any inline nested objects identified in the audit.
5. Fix `src/schema-endpoint.ts` per the shape you chose in Layer 3.
6. (Optional) Add the read-only startup assertion.
7. Regenerate `test/snapshots/api-schema.json`. Expect `additionalProperties: false` to appear on every action input root AND on every strictified nested object.
8. Run the full test suite. Each failure of the form `Unrecognized key: "X"` is a fixture bug — fix the fixture, do NOT whitelist the field. The whole point is to surface these.

## Part 2: Handles purge (expanded scope)

### Categories

**A.** Broken operational scripts that reference the dropped `members.handle` column.
**B.** Dead TypeScript field declarations (compile clean, runtime never sees them).
**C.** Misnamed regex constant — alive, used only by slug validation, carries its old handle name.
**D.** Stale comments mentioning handles as if they exist.
**E.** Stale test fixtures passing `handle: '...'` literals.
**F.** Leave alone — history, false positives, unrelated.

### File-by-file

**Category A — broken scripts:**

- `scripts/bootstrap.sh:41, 44, 60` — INSERT into `members.handle`, SELECT WHERE handle, `token-cli.ts --handle superadmin` call. Remove the `handle` column from the INSERT, replace the SELECT's filter with whichever surviving identifier the bootstrap relies on (probably `public_name`), and remove or replace `--handle superadmin` in the token-cli invocation. Cross-reference `scripts/reset-dev.sh` for the current correct pattern.
- `scripts/add-member.sh` — new finding from your investigation. Read it, determine what it does and whether it's still used. If it has a real purpose and just references the dead handle column, fix it. If it's obsolete, delete it.
- `scripts/pressure-test.sh` — new finding from your investigation. Same treatment: read, decide, fix or delete.
- `scripts/backfill-mentions.ts` — **DELETE outright.** Confirmed obsolete from your investigation: queries `m.handle`, filters on `%@%`, expects `authoredHandle` in parser output, inserts into `authored_handle`, and references a nonexistent `plans/mentions.md`. The live mentions system in `src/mentions.ts:52` uses `[Label|memberId]` syntax plus the `authored_label` column — not handles. Nothing in this script is salvageable. `git rm` it.

**Category B — dead TypeScript types:**

- `src/clubs/entities.ts:73` — `handle: string | null` in the event RSVP attendees row type. Your investigation confirmed the actual SQL at `src/clubs/entities.ts:396, 410` does not select a `handle` column. Delete the field from the row type.
- `src/postgres.ts:385` — `counterpart_handle: string | null` in the DM thread row type. Your investigation confirmed the SQL at `src/postgres.ts:424` does not select it. Delete the field.

**Category C — regex rename:**

- `src/identity/handles.ts` → rename the file to `src/identity/slugs.ts`. Rename constants: `HANDLE_PATTERN` → `SLUG_PATTERN`, `HANDLE_REGEX` → `SLUG_REGEX`. The regex itself is unchanged — only the names.
- `src/schemas/fields.ts:11` — update the import line to the new module path and constant name.
- `src/schemas/fields.ts:386` — update the usage in `parseSlug` to reference the new name.
- `src/schemas/fields.ts:377` — the comment reads `Wire: slug format (same as handle).` Drop the parenthetical.

**Category D — stale comments:**

- `src/identity/memberships.ts:558` — comment reads `Returns the new member ID, handle, and a bearer token.` Drop "handle, ".
- `src/ai.ts:11` — comment references handle field removal in the embedding source version bump history. Acceptable to leave verbatim (it's historical context) or rewrite as `// v2: 011_delete_handles bumped this`. Your call; note which in the handoff.

**Category E — test fixtures (expanded):**

- `test/unit/admin.test.ts` — multiple fixture objects with `handle: 'alice'`, `handle: 'owner'`, etc. Your investigation found more than rev 1 listed. Delete `handle` from every fixture in this file. Verify by grepping after.
- `test/unit/app.test.ts` — your investigation found more `handle` literals than rev 1 enumerated. Delete all.
- `test/unit/fixtures.ts` — new finding. Delete stale `handle` fields.
- `test/unit/invitations.test.ts` — new finding. Delete.
- `test/unit/vouches.test.ts` — new finding. Delete.
- `test/integration/harness.ts` — SIX `handle: string` parameters to remove, not three. Full list: lines `362`, `375`, `922`, `939`, `950`, `961`. The first three were surfaced in your later investigation; the last three were in rev 1. Delete the param from each function signature, update every caller. Do the full six as one sweep — do not treat the newer three as additive to a smaller scope.
- `test/integration/non-llm/clubs-join-pow-recovery.test.ts:105, 241, 254, 268` — fixture type with `handle: string` plus three assignments (`renewal-pending-riley`, `cancelled-casey`, `banned-bailey`). Delete.
- `test/integration/non-llm/billing-sync.test.ts:11` — `admin: { id; handle; publicName; token }`. Drop `handle`.

After these edits, run a final grep: `grep -rn "handle:" test/` should return no matches that look like identity handles (only `async handle(` methods, which are unrelated).

**Category F — leave alone:**

- All migration files. Frozen history.
- `db/init.sql:3464` — `('011_delete_handles.sql')` entry in the migrations ledger. Required.
- `db/seeds/dev.sql` — every match is a verb ("dog handler", "I'll handle the technical side"). Spot-check quickly, leave.
- `plans/*.md`, `docs/*.md`, `company/*.md` — historical records. Don't touch.
- `CLAUDE.md`, `SKILL.md`, any `README.md` — already confirmed clean. Spot-check, expect no changes.
- Every `async handle(input, ctx)` method — function name, unrelated.
- Every `handler`, `handleNotification`, `handleError`, etc. — verb, unrelated.
- The `handle` JSON key inside `db/migrations/012_kill_untyped_json_surface.sql:104-108` — that's the social-link `@handle` concept from legacy profile link shapes, a completely different thing from user identity handles. Leave alone.

## Verification (required — do not skip steps)

1. `npx tsc --noEmit`
2. `npm run test:unit`
3. `DATABASE_URL='postgresql://localhost/clawclub_dev' npm run test:unit:db`
4. `./scripts/reset-dev.sh` — rebuild the dev DB. Confirm the token output and any script output no longer reference handles.
5. `DATABASE_URL='postgresql://clawclub_app:localdev@localhost/clawclub_dev' ./scripts/smoke-test.sh`
6. `set -a && . ./.env.local && set +a && DATABASE_URL='postgresql://clawclub_app:localdev@localhost/clawclub_dev' node --experimental-strip-types src/http-smoke.ts`
7. `npm run test:integration:non-llm`
8. `npm run test:integration:with-llm`
9. **Manual strict-rejection probe — root level.** Start the dev server with OPENAI_API_KEY loaded. Pick three actions (`content.create`, `profile.update`, one more of your choice) and send each with a deliberately-extra top-level key like `sneaky: "value"`. Each must return `invalid_input` with `Unrecognized key: "sneaky"`. If any returns `ok: true`, Layer 1 isn't doing its job — investigate before proceeding.
10. **Manual strict-rejection probe — nested level.** Send `content.create` with `kind: 'event'`, a valid `event` object, AND an extra key inside the event object: `event: { location: "...", startsAt: "...", junk: 1 }`. Must return `invalid_input` with an error naming the nested key. This is the exact regression your investigation identified in current code; confirm it's fixed.
11. **Snapshot diff sanity check.** After regenerating `test/snapshots/api-schema.json`, diff against the previous version. Expect `additionalProperties: false` to appear on every action input root AND on every nested helper object that was strictified. If any input-side schema still lacks it, Layer 2 or Layer 3 missed a path — investigate.
12. **Live `/api/schema` spot-check.** Hit the running dev server's `/api/schema` endpoint and confirm the input object for `profile.update` and `content.create` both include `additionalProperties: false` — at BOTH root level and inside nested objects like `event`. If any are missing, the schema-endpoint fix is incomplete.

## Commit protocol

- Single new commit on top of the plans checkpoint. Do NOT amend any existing commits.
- Commit message: `schema: strict-by-default action inputs and complete handles purge` plus a short paragraph describing the three layers and the handles sweep.
- Bump `package.json` patch version: `0.2.61` → `0.2.62`. Once, at commit time.
- Follow CLAUDE.md commit format including the `Co-Authored-By` trailer.
- Do not push. Commit locally and stop for review.
- Do not run destructive git commands on the working tree.
- Leave unrelated worktree noise alone: the plan files in `plans/` and similar non-source clutter. **Exception:** `test/snapshots/api-schema.json` WILL be regenerated and committed as part of this work — it's the primary external evidence that Layers 1–3 took effect. Treat the regenerated file as authoritative. Do not try to preserve the old one-line version-field diff from the previous run; let the regenerate overwrite it cleanly.

## Handoff report

When done, report:

1. **Pre-investigation findings.**
   - Zod refine + strict spot test: both errors fired, or which one didn't.
   - Every registered action's input root type: confirmed `ZodObject` across the board, or list exceptions.
   - Nested object audit: full list with file paths and whether each was a shared helper or inline.
   - `src/schema-endpoint.ts` paragraph summary of `relaxInputSchema`'s role and why it exists.

2. **Layer 1 landing.** Registry helper diff summary. Confirmation that `.strict()` applied to `content.update` and `content.getThread` parse inputs preserves their refines (show the test output or a manual repro where both the refine error AND the unrecognized-key error fire on a single bad input).

3. **Layer 2 landing.** List of every nested helper strictified, with file paths. List of any inline nested objects you extracted to helpers. Rationale per extraction (or per inline-strictify if you chose that path).

4. **Layer 3 landing.** What shape of fix you chose for `src/schema-endpoint.ts` and why. Before/after of the exported `profile.update` input schema from a running server, with `additionalProperties: false` newly appearing at both root and nested levels.

5. **Defense-in-depth assertion.** Implemented or skipped. If skipped, one sentence on why.

6. **Manual probe results.** Actual response text for both the root-level and nested-level strict-rejection probes. At least three probes, covering root and nested.

7. **Snapshot diff summary.** Number of new `additionalProperties: false` entries that appeared. Spread across how many actions. Sanity check: matches the size suggested by the nested audit.

8. **Part 2 per-category confirmations.** File-by-file. Especially:
   - What happened to `scripts/backfill-mentions.ts` (expected: deleted)?
   - What happened to `scripts/add-member.sh` and `scripts/pressure-test.sh` (fixed, or deleted, and why)?
   - How did the three newly-found harness param cleanups cascade through callers?
   - Did the final grep for `handle:` across `test/` come back clean?

9. **Test suite results.** All suites passed, nothing skipped. List any fixture files you had to fix because they were passing extra fields they shouldn't, and name the fields.

10. **Anything you pushed back on or did differently from this plan, and why.** Same expectation as last time — if you disagree with part of the plan, stop and report instead of improvising.

## What I want you to push back on

- If the Zod spot test (Pre-investigation item 1) comes back showing `.strict()` does NOT preserve refines in this version, stop. The entire central approach depends on that behavior.
- If `relaxInputSchema` in `src/schema-endpoint.ts` is protecting against a real Zod-to-JSONSchema bug or nullable-handling quirk that would break `/api/schema` if you left strictness in, propose the smallest surgical fix instead of naive removal. Don't break the export to fix the contract.
- If the nested-object audit finds more than ~10 inline objects needing attention, propose a walker-based approach instead of per-site discipline. I chose explicit helpers for simplicity and refine-preservation; if the inline count makes that unreasonable, the tradeoff flips and we should discuss.
- If any registered action's input root turns out to NOT be a `ZodObject` (e.g. an array, union, or effects wrapper), the central helper needs to handle it — surface it before writing the helper.
- If the dead TypeScript handle fields in `src/clubs/entities.ts:73` or `src/postgres.ts:385` turn out to actually be load-bearing — i.e. the SQL really does select them and your earlier investigation was wrong on that point — stop IMMEDIATELY. That would change this from a cleanup into an emergency and we need to discuss before touching anything.
- If you find another class of handle remnants beyond what's listed — e.g. anything in `.env.example`, CI configs, a `README.md`, or a generated file I didn't check — surface it and add to the cleanup.
- Anything else that smells wrong.

If the plan is correct as revised, say so explicitly and proceed to implementation. Otherwise stop and report before writing code.
