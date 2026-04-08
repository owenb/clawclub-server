# Permissions Overhaul: Implementation Plan

## Background and motivation

ClawClub is an agent-first platform where LLM agents are the primary API consumers. We need action names and auth levels that are immediately clear to agents — no ambiguity, no magic commands that change behavior depending on who calls them.

The current system has three problems:

1. **The `owner` auth level conflates billing ownership with operational administration.** Club ownership is a billing/curation relationship (one person responsible for the club). But operational tasks like managing memberships, reviewing admissions, and moderating content should be delegable to multiple trusted members.

2. **There's no way to delegate admin powers.** The club owner is the only person who can manage memberships, review admissions, or issue access. If the owner is unavailable, the club is stuck.

3. **The `admin.*` action prefix still exists** for 9 actions that need to be resolved into either `clubadmin.*` or `superadmin.*`.

## Design decisions (already made)

- **Four auth levels on actions:** `'none' | 'member' | 'clubadmin' | 'superadmin'`. The `'owner'` auth level is eliminated entirely.
- **Club ownership stays on the clubs table** via `club_owner_versions`. One owner per club. Only superadmin can transfer ownership (`superadmin.clubs.assignOwner`).
- **Membership roles change** from `'owner' | 'admin' | 'member'` to `'clubadmin' | 'member'`. The club owner's membership role is always `'clubadmin'`.
- **The `clubadmin` auth check** means: the actor's membership role is `'clubadmin'` for the target club, OR the actor is a superadmin. Since the owner always has role `'clubadmin'`, they pass automatically.
- **Every `clubadmin.*` action requires an explicit `clubId` input.** No magic scope inference. No "search all your clubs" behavior. The caller always says which club. If an agent needs to scan multiple clubs, it calls the action once per club. This also cleanly solves superadmin access — superadmin passes a `clubId`, the auth check sees they're superadmin, they get access to that club.
- **Superadmin calling `clubadmin.*` actions**: Superadmins may not have a membership in the target club. The `requireClubAdmin()` helper handles this by loading real club metadata from the repository (not a synthetic membership). See the dispatch section below for the concrete design. Superadmins can call ALL `clubadmin.*` actions EXCEPT `clubadmin.members.promoteToAdmin` and `clubadmin.members.demoteFromAdmin`, which require the caller to be the club owner (superadmin can transfer ownership instead via `superadmin.clubs.assignOwner`).
- **Only the club owner can promote/demote admins.** Not any admin — only the owner. This prevents admin escalation.
- **Verbose action names** like `clubadmin.memberships.list` and `clubadmin.members.promoteToAdmin` are intentional. Agents benefit from clarity over brevity.
- **`session.getContext` adds `isOwner: boolean`** to each membership in the response, so agents can distinguish the owner from other admins.
- **All remaining `admin.*` actions are resolved** — moved to either `clubadmin.*` or `superadmin.*`. The `admin.ts` file is deleted.
- **Entity archiving/redaction and message redaction are NOT changed in this PR.** Those actions (`entities.archive`, `entities.redact`, `messages.redact`) still use their current owner-based auth. They will be replaced by `content.remove` / `messages.remove` (which will use `clubadmin` auth) in a follow-up content removal PR. No point fixing something we're about to replace.

## Important: read these files first

Before making any changes, read and understand these files thoroughly. The codebase has specific patterns you must follow.

**Auth and dispatch:**
- `src/schemas/registry.ts` — `ActionAuth` type (line 25), `HandlerContext` type (lines 63-77), `RepositoryCapability` type
- `src/dispatch.ts` — `createRequireMembershipOwner()` (lines 71-80), `createRequireAccessibleClub()` (lines 60-69), `createResolveScopedClubs()` (lines 90-101), `createRequireSuperadmin()` (lines 82-88), and how `HandlerContext` is assembled (lines 371-381)
- `src/contract.ts` — `MembershipSummary` type (lines 14-24, note: role is `'owner' | 'admin' | 'member'`), `ActorContext` type

**Current owner-auth actions (all 7 are in one file):**
- `src/schemas/membership.ts` — all owner-only actions: `memberships.list`, `memberships.review`, `memberships.create`, `memberships.transition`, `admissions.list`, `admissions.transition`, `admissions.issueAccess`. Pay close attention to the `resolveOwnerClubs` helper (line 35) which filters `m.role === 'owner'`.

**The remaining admin actions to resolve:**
- `src/schemas/admin.ts` — 9 actions with `auth: 'superadmin'` and `admin.*` prefix that all need renaming

**Database (read for understanding, migrations are in order):**
- `db/migrations/0001_init.sql`:
  - `membership_role` enum (around line 127): `'owner' | 'admin' | 'member'`
  - `club_memberships` table (lines 706-717): has `role` column and CHECK constraint that ties `role = 'owner'` to `sponsor_member_id IS NULL`
  - `accessible_club_memberships` view (line 776): filters to `role = 'owner' OR has_live_subscription`
  - `actor_has_club_access()` function (lines 224-234): checks `cm.role = 'owner'` 
  - `actor_is_club_owner()` function (lines 239-247): checks `clubs.owner_member_id`
  - `club_memberships_insert_owner_scope` RLS policy (line 2217): uses `actor_is_club_owner()`
  - `admissions_insert_owner_scope` RLS policy (line 2179): uses `actor_is_club_owner()`
  - `admissions_select_actor_scope` RLS policy (line 2185): includes club owner check
  - `admissions_update_owner_scope` RLS policy (line 2194): uses `actor_is_club_owner()`
  - `member_private_contacts_select_owner` RLS policy (line 2364): checks `role = 'owner'`

**Superadmin actions (already moved in a previous PR):**
- `src/schemas/superadmin.ts` — 8 `superadmin.*` actions already live here

**Response schemas:**
- `src/schemas/responses.ts` — `membershipSummary` Zod schema includes `role: membershipRole`
- `src/schemas/fields.ts` — `membershipRole` Zod enum definition

**Tests:**
- `test/fixtures.ts` — `makeActor()` defaults to `role: 'owner'` (line ~30). `makeAdminAuthResult()` creates superadmin actors.
- `test/integration/harness.ts` — `TestHarness` helper, `seedOwner()`, `seedClubMember()`, `seedSuperadmin()` methods
- `test/integration/admin.test.ts` — tests for all superadmin and owner actions
- `test/integration/memberships.test.ts` — membership lifecycle tests
- `test/integration/admissions.test.ts` — admission flow tests
- `test/app.test.ts` — unit tests for membership and admission actions

**Documentation:**
- `SKILL.md` — documents all actions, auth requirements, and agent behavior guidance
- `CLAUDE.md` — build commands, test commands, local dev setup

## What changes

### 1. Database migration (single new migration file)

**a. Add `'clubadmin'` to the `membership_role` enum:**
```sql
ALTER TYPE app.membership_role ADD VALUE IF NOT EXISTS 'clubadmin';
```

**b. Migrate existing role values:**
```sql
-- All current 'owner' role memberships become 'clubadmin'
-- All current 'admin' role memberships also become 'clubadmin' (admin already exists in enum but is unused)
UPDATE app.club_memberships SET role = 'clubadmin' WHERE role IN ('owner', 'admin');
```

Note: Postgres enums don't support removing values. The old `'owner'` and `'admin'` values remain in the enum but are never written. This is fine.

**c. Update the CHECK constraint on `club_memberships`:**

The current constraint is:
```sql
CHECK ((role = 'owner' AND sponsor_member_id IS NULL) OR (role != 'owner' AND sponsor_member_id IS NOT NULL))
```

This needs to change. The new rule: the club owner (identified by `clubs.owner_member_id`) has `sponsor_member_id IS NULL`. Other members (including clubadmins) have a sponsor. But since the constraint checks role, not ownership, we need to relax it:

```sql
-- Drop the old constraint
ALTER TABLE app.club_memberships DROP CONSTRAINT network_memberships_check;

-- New constraint: clubadmin role allows NULL sponsors (the owner's case).
-- Regular members must always have a sponsor.
-- When a member is promoted to clubadmin, their existing sponsor stays.
ALTER TABLE app.club_memberships ADD CONSTRAINT club_memberships_sponsor_check 
  CHECK (sponsor_member_id IS NOT NULL OR role = 'clubadmin');
```

This allows clubadmins to have NULL sponsors (the owner's case) while requiring sponsors for regular members. When a regular member is promoted to clubadmin, their existing sponsor stays.

**Ex-owner demotion edge case:** When club ownership is transferred (`superadmin.clubs.assignOwner`), the old owner keeps `role = 'clubadmin'` with `sponsor_member_id = NULL`. If the new owner later demotes the ex-owner via `clubadmin.members.demoteFromAdmin`, the role changes to `'member'` — which would violate the constraint (member role requires a sponsor). The `demoteFromAdmin` handler MUST set `sponsor_member_id` to the current club owner's member ID when demoting a member who has no sponsor. This is explicit in the demote action spec below.

**d. Update `actor_has_club_access()` security-definer function:**

Current:
```sql
WHERE cm.role = 'owner' OR app.membership_has_live_subscription(cm.id)
```

New:
```sql
WHERE cm.role = 'clubadmin' OR app.membership_has_live_subscription(cm.id)
```

Wait — this function controls basic club ACCESS, not admin powers. Currently only owners and members with live subscriptions can access a club. If we change this to `clubadmin`, then regular members without subscriptions lose access. That's wrong.

**IMPORTANT**: `actor_has_club_access()` is about ACCESS, not admin powers. The role check there is about whether the owner gets free access without a subscription. The new equivalent: clubadmins (including the owner) get free access. Regular members need a subscription. So the change is correct:

```sql
CREATE OR REPLACE FUNCTION app.actor_has_club_access(target_club_id app.short_id) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
    AS $$
  select exists (
    select 1 from app.club_memberships cm
    join app.current_club_membership_states ccms on ccms.membership_id = cm.id
    where cm.member_id = app.current_actor_member_id()
      and cm.club_id = target_club_id
      and ccms.status = 'active'
      and (cm.role = 'clubadmin' or app.membership_has_live_subscription(cm.id))
  )
$$;
```

**e. Update `accessible_club_memberships` view:**

Current filter:
```sql
WHERE ccm.status = 'active' AND ccm.left_at IS NULL AND (ccm.role = 'owner' OR app.membership_has_live_subscription(ccm.id))
```

New:
```sql
WHERE ccm.status = 'active' AND ccm.left_at IS NULL AND (ccm.role = 'clubadmin' OR app.membership_has_live_subscription(ccm.id))
```

**f. Create `actor_is_club_admin()` security-definer function:**

```sql
CREATE FUNCTION app.actor_is_club_admin(target_club_id app.short_id) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'app', 'pg_temp'
    AS $$
  select exists (
    select 1 from app.club_memberships cm
    join app.current_club_membership_states ccms on ccms.membership_id = cm.id
    where cm.member_id = app.current_actor_member_id()
      and cm.club_id = target_club_id
      and ccms.status = 'active'
      and cm.role = 'clubadmin'
  ) or app.current_actor_is_superadmin()
$$;
```

This returns true if the actor is a clubadmin in the target club OR is a superadmin. The club owner always has `role = 'clubadmin'` so they pass automatically.

**g. Update ALL RLS policies that currently use `actor_is_club_owner()` for admin operations.**

These policies currently only allow the club owner (or superadmin). They must now accept any clubadmin. Replace `actor_is_club_owner()` with `actor_is_club_admin()` in each:

**On `app.club_memberships`:**
- `club_memberships_insert_owner_scope` (line 2217) → DROP and recreate as `club_memberships_insert_admin_scope` using `actor_is_club_admin(club_id)`

**On `app.club_membership_state_versions`:**
- `club_membership_state_versions_insert_owner_scope` (line 2199) → DROP and recreate as `club_membership_state_versions_insert_admin_scope` using `actor_is_club_admin(cm.club_id)` (joins through club_memberships to get club_id)

**On `app.admissions`:**
- `admissions_insert_owner_scope` (line 2179) → DROP and recreate as `admissions_insert_admin_scope` using `actor_is_club_admin(club_id)`
- `admissions_update_owner_scope` (line 2194) → DROP and recreate as `admissions_update_admin_scope` using `actor_is_club_admin(club_id)`
- `admissions_select_actor_scope` (line 2185) → DROP and recreate, replacing the `actor_is_club_owner(club_id)` clause with `actor_is_club_admin(club_id)` (keep the applicant/sponsor clauses unchanged)

**On `app.admission_versions`:**
- `admission_versions_insert_owner_scope` (line 2164) → DROP and recreate, replacing `actor_is_club_owner(a.club_id)` with `actor_is_club_admin(a.club_id)`
- `admission_versions_select_actor_scope` (line 2169) → DROP and recreate, replacing `actor_is_club_owner(a.club_id)` with `actor_is_club_admin(a.club_id)` (keep applicant/sponsor clauses)

**On `app.member_private_contacts`:**
- `member_private_contacts_select_owner` (line 2364) → DROP and recreate, replacing the `role = 'owner'` check with `role = 'clubadmin'`. Clubadmins need to see contact info to manage memberships and admissions.

**h. Keep `actor_is_club_owner()` function unchanged.** It checks `clubs.owner_member_id` and is still needed for owner-only operations (promoting/demoting admins). Do not delete it.

**i. Update `club_memberships_select_actor_scope` policy (line 2220):**

This policy includes an `actor_is_club_owner()` check for SELECT access. Replace with `actor_is_club_admin()` so clubadmins can see all memberships in their club.

**j. Update `actor_can_access_member()` function (line 179-207):**

This function controls member/profile visibility. It has TWO `actor_is_club_owner()` calls:
- Line 194: grants access to members in clubs the actor owns
- Line 200: grants access to admission applicants/sponsors in clubs the actor owns

Both must change to `actor_is_club_admin()`. Clubadmins need to see member profiles and admission applicants to do their job. Without this change, non-owner clubadmins would get 404s when trying to view applicant profiles during admission review.

This function backs the RLS policies on `app.members` (line 2381) and `app.member_profile_versions` (line 2428), so the fix propagates to all member/profile reads.

### 2. TypeScript auth system changes

**a. `src/schemas/registry.ts`:**

Change `ActionAuth`:
```typescript
// Old:
export type ActionAuth = 'none' | 'member' | 'owner' | 'superadmin';
// New:
export type ActionAuth = 'none' | 'member' | 'clubadmin' | 'superadmin';
```

**b. `src/contract.ts`:**

Update `MembershipSummary`:
```typescript
// Old:
role: 'owner' | 'admin' | 'member';
// New:
role: 'clubadmin' | 'member';
isOwner: boolean;  // NEW: true if this member is the club owner
```

**c. `src/schemas/fields.ts`:**

Update the `membershipRole` Zod enum to match the new values (`'clubadmin' | 'member'`). Also update `membershipCreateRole` — currently allows `'member' | 'admin'`, change to only `'member'` (promotion is a separate action, not part of membership creation).

**d. `src/schemas/responses.ts`:**

Update the `membershipSummary` Zod schema to include `isOwner: z.boolean()` and update the `role` field. Also update `membershipAdminSummary` — its `role` field must match the new enum values.

**d2. `src/contract.ts` — additional types to update:**

- `MembershipSummary` (line 14): role changes to `'clubadmin' | 'member'`, add `isOwner: boolean`
- `MembershipAdminSummary` (line 39): role field must change to `'clubadmin' | 'member'`
- `CreateMembershipInput` (line 65): role field must change to just `'member'` (no admin creation via this path)
- Promote/demote repository methods should return `MembershipAdminSummary` (the existing type used by other membership actions), NOT a new `MembershipAdminResult` type. Do not invent new types.

**e. `src/dispatch.ts`:**

Replace `createRequireMembershipOwner()` with `createRequireClubAdmin()`.

Since `clubScope` is dropped from responses, handlers don't need club metadata from the auth check — they just need authorization and the `clubId` (which they already have from parsed input). So `requireClubAdmin` is a pure authorization gate:

```typescript
function createRequireClubAdmin(actor: ActorContext) {
  return (clubId: string): void => {
    // Superadmins always pass
    if (actor.globalRoles.includes('superadmin')) return;

    // Must have a clubadmin membership in the target club
    const membership = actor.memberships.find(m => m.clubId === clubId);
    if (!membership) {
      throw new AppError(403, 'forbidden', 'Requested club is outside your access scope');
    }
    if (membership.role !== 'clubadmin') {
      throw new AppError(403, 'forbidden', 'This action requires club admin role in the requested club');
    }
  };
}
```

No `ClubAdminContext` type needed. No `getClubById` repository method needed. No async. Synchronous, zero allocations, no DB call. If the club doesn't exist, repository calls downstream return empty results or null — the handler handles that naturally.

**Drop `clubScope` from clubadmin action responses entirely.** The current list actions (`memberships.list`, `memberships.review`, `admissions.list`) return `clubScope: MembershipSummary[]` echoing back the caller's membership context. With mandatory `clubId`, this is redundant — the caller already knows which club they asked about, and they have club metadata from `session.getContext`. Remove `clubScope` from the wire output schemas of all clubadmin actions. This eliminates the superadmin response-shape problem completely — no need to construct membership summaries for callers who don't have memberships.

**A simpler alternative for `requireClubAdmin()`:** If `getClubById` doesn't exist on the repository yet, you can add it — it's a trivial single-row lookup. Or: pre-populate a `clubMetadataCache` on the handler context during dispatch setup by querying the club table for the `clubId` found in the parsed input. This keeps `requireClubAdmin()` synchronous.

Update `HandlerContext`:
```typescript
export type HandlerContext = {
  actor: ActorContext;
  requestScope: RequestScope;
  sharedContext: SharedResponseContext;
  repository: Repository;
  requireAccessibleClub: (clubId: string) => MembershipSummary;
  requireClubAdmin: (clubId: string) => void;  // NEW: replaces requireMembershipOwner. Pure auth gate.
  requireClubOwner: (clubId: string) => void;  // NEW: for owner-only operations
  requireSuperadmin: () => void;
  resolveScopedClubs: (clubId?: string) => MembershipSummary[];
  requireCapability: (capability: RepositoryCapability) => void;
};
```

`requireClubOwner(clubId)` checks that the actor's member ID matches the club's `owner_member_id`. This is the `isOwner` field on the actor's membership (already loaded by `session.getContext`). If the actor is not a member of the club, or `isOwner` is false, throw 403. Superadmins do NOT bypass this check — only the actual club owner can promote/demote. Superadmins can transfer ownership via `superadmin.clubs.assignOwner` instead.

**Remove `resolveScopedClubs` from clubadmin handlers.** The current owner actions use `resolveScopedClubs()` to infer clubs when `clubId` is omitted. With the new design, all `clubadmin.*` actions require explicit `clubId`, so this helper is no longer used by clubadmin handlers (it may still be used by member-level actions like `content.list`).

**f. `src/postgres.ts` — `readActorByMemberId()`:**

The query that builds the actor context needs to populate `isOwner` on each membership. Add a join or subquery against `clubs.owner_member_id`:

```sql
-- Add to the SELECT clause:
(n.owner_member_id = m.id) as is_owner
```

The `clubs` table (`n`) is already joined in this query, and it has `owner_member_id` synced from `club_owner_versions`. The `mapActor` function then maps this to `isOwner: boolean` on each `MembershipSummary`.

### 3. Rename owner-auth actions to `clubadmin.*`

All 7 actions in `src/schemas/membership.ts` get renamed and their auth level changed:

| Old name | New name | Old auth | New auth |
|---|---|---|---|
| `memberships.list` | `clubadmin.memberships.list` | `owner` | `clubadmin` |
| `memberships.review` | `clubadmin.memberships.listForReview` | `owner` | `clubadmin` |
| `memberships.create` | `clubadmin.memberships.create` | `owner` | `clubadmin` |
| `memberships.transition` | `clubadmin.memberships.setStatus` | `owner` | `clubadmin` |
| `admissions.list` | `clubadmin.admissions.list` | `owner` | `clubadmin` |
| `admissions.transition` | `clubadmin.admissions.setStatus` | `owner` | `clubadmin` |
| `admissions.issueAccess` | `clubadmin.admissions.issueAccessToken` | `owner` | `clubadmin` |

**Move these to a new file: `src/schemas/clubadmin.ts`** (or keep in membership.ts and rename the file — your call, but a new file is cleaner).

**Update all handlers:**
- Replace `ctx.requireMembershipOwner(clubId)` with `ctx.requireClubAdmin(clubId)`
- **Delete the `resolveOwnerClubs` helper entirely.** All clubadmin actions now take explicit `clubId`. No more inferring scope from memberships.
- **Make `clubId` a required input** on every clubadmin action. Currently some of these actions have optional `clubId` and infer scope. Remove the optional behavior. The handler calls `ctx.requireClubAdmin(input.clubId)` and uses that single club.
- Any place that filters `ctx.actor.memberships.filter(m => m.role === 'owner')` must change to `m.role === 'clubadmin'`

**Update `src/dispatch.ts`:**
- Add `import './schemas/clubadmin.ts'` (if new file)
- Remove import of old file if renamed

### 3a. CRITICAL: Update repository SQL that hardcodes `role = 'owner'`

The auth changes above only fix the handler layer and RLS policies. But several repository queries ALSO hardcode `role = 'owner'` in their SQL. If these are not updated, non-owner clubadmins will get empty results or "not found" errors even after the handler/RLS changes.

**`src/postgres/membership.ts`:**
- Line 407: `createMembership` query has `and anm.role = 'owner'` in a scope CTE. Change to `and anm.role = 'clubadmin'`.
- Line 431: `createMembership` has a check `adminScopeResult.rows[0].role !== 'owner'`. Change to `!== 'clubadmin'`.
- Line 543: `transitionMembershipState` has `and owner_scope.role = 'owner'` in an owner_scope CTE. Change to `and owner_scope.role = 'clubadmin'`.

**`src/postgres/admissions.ts`:**
- Line 275: `transitionAdmission` has `and owner_scope.role = 'owner'`. Change to `and owner_scope.role = 'clubadmin'`.
- Line 894: `issueAdmissionAccess` has `and owner_scope.role = 'owner'`. Change to `and owner_scope.role = 'clubadmin'`.

**`src/postgres/platform.ts`:**
- Line 264: `assignClubOwner` upserts with `role = 'owner'`. Change to `role = 'clubadmin'`.
- Line 296: `assignClubOwner` checks `role = 'owner'` when looking up the old owner. Change to `role = 'clubadmin'`.

**`src/schemas/entities.ts`:**
- Line 246: `entities.redact` filters `m.role === 'owner'`. **Leave this for now** — it will be replaced by the content removal PR.

**`src/schemas/messages.ts`:**
- Line 286: `messages.redact` filters `m.role === 'owner'`. **Leave this for now** — same reason.

**`src/schemas/membership.ts`:**
- Lines 37, 265, 397, 518: handler code filtering `m.role === 'owner'`. All of these move to the new clubadmin handlers with `m.role === 'clubadmin'`.

### 4. New actions: promote and demote

Add two new actions (in the clubadmin schema file):

**`clubadmin.members.promoteToAdmin`:**
- `auth: 'clubadmin'`
- `safety: 'mutating'`
- Input: `{ clubId: string, memberId: string }`
- Handler: 
  1. `ctx.requireClubAdmin(clubId)` — caller must be a clubadmin
  2. Additional check: caller must be the club OWNER (not just any admin). Use `ctx.requireClubOwner(clubId)`.
  3. Verify target member exists and has an active membership in the club with `role = 'member'`
  4. Update the membership role to `'clubadmin'`
  5. Return the updated membership
- Idempotent: if target is already `'clubadmin'`, return current state
- Must NOT allow promoting someone who isn't an active member of the club
- Must NOT allow self-promotion (the owner is already clubadmin)

**`clubadmin.members.demoteFromAdmin`:**
- `auth: 'clubadmin'`
- `safety: 'mutating'`
- Input: `{ clubId: string, memberId: string }`
- Handler:
  1. `ctx.requireClubAdmin(clubId)` — caller must be a clubadmin
  2. Additional check: caller must be the club OWNER. Use `ctx.requireClubOwner(clubId)`.
  3. Verify target member has `role = 'clubadmin'` in the club
  4. **CRITICAL**: Must NOT allow demoting the club owner. Check that `memberId !== club.owner_member_id`.
  5. Update the membership role to `'member'`
  6. **If the member has `sponsor_member_id = NULL`** (ex-owner case), set `sponsor_member_id` to the current club owner's member ID. This satisfies the CHECK constraint that regular members must have a sponsor.
  7. Return the updated membership
- Idempotent: if target is already `'member'`, return current state

**Repository methods needed:**
- `promoteMemberToAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<MembershipAdminSummary | null>`
- `demoteMemberFromAdmin(input: { actorMemberId: string; clubId: string; memberId: string }): Promise<MembershipAdminSummary | null>`

Return the existing `MembershipAdminSummary` type — do not create new types. Return null if the target membership is not found.

These should UPDATE the membership role. Yes, this is a mutation (UPDATE), not an append — but membership role changes are operational, not content. The membership state machine (status transitions) is append-only via `club_membership_state_versions`, but the role column is a direct attribute of the membership.

### 5. Resolve remaining `admin.*` actions

Move all 9 remaining actions out of `src/schemas/admin.ts`:

**Move to `src/schemas/superadmin.ts` (platform-wide, cross-club):**

| Old name | New name |
|---|---|
| `admin.tokens.list` | `superadmin.accessTokens.list` |
| `admin.tokens.revoke` | `superadmin.accessTokens.revoke` |
| `admin.messages.threads` | `superadmin.messages.listThreads` |
| `admin.messages.read` | `superadmin.messages.getThread` |
| `admin.content.list` | `superadmin.content.list` |
| `admin.content.archive` | `superadmin.content.archive` |
| `admin.content.redact` | `superadmin.content.redact` |
| `admin.messages.redact` | `superadmin.messages.redact` |

**Move to clubadmin schema (club-scoped):**

| Old name | New name | Changes needed |
|---|---|---|
| `admin.clubs.stats` | `clubadmin.clubs.getStatistics` | Change `auth` from `superadmin` to `clubadmin`. Update handler to use `requireClubAdmin(clubId)` instead of `requireSuperadmin()`. The repository call already takes a `clubId`, so scoping is natural. |

**Delete `src/schemas/admin.ts`** entirely. Remove its import from `src/dispatch.ts`.

Note: `superadmin.content.archive`, `superadmin.content.redact`, and `superadmin.messages.redact` will be replaced by the content removal system in a follow-up PR. For now they just get renamed to clear the `admin.*` prefix.

### 6. Update `superadmin.clubs.assignOwner`

When club ownership is transferred, the new owner's membership role must be set to `'clubadmin'` (if it isn't already). The old owner keeps their `'clubadmin'` role — demotion from admin is a separate action.

Check `src/postgres/platform.ts` (the `assignClubOwner` implementation, around line 253) which currently upserts with `role = 'owner'`. Change to `role = 'clubadmin'`.

### 7. Update `memberships.create` (now `clubadmin.memberships.create`)

Currently this action accepts `role: 'member' | 'admin'` on input. Since `'admin'` is being replaced by `'clubadmin'` as a concept, but we don't want clubadmins to be able to create NEW members as clubadmins (promotion is separate), the input should only accept `role: 'member'`. The promotion flow is: create as member → promote to admin.

Alternatively, keep allowing `role: 'member' | 'clubadmin'` if the caller is the club owner. But this adds complexity. Simpler: always create as `'member'`, use `clubadmin.members.promoteToAdmin` to elevate.

### 8. Update SKILL.md

- Update all action names (7 owner actions → `clubadmin.*`, 9 admin actions → resolved)
- Add new actions: `clubadmin.members.promoteToAdmin`, `clubadmin.members.demoteFromAdmin`, `clubadmin.clubs.getStatistics`
- Update auth descriptions: replace "owner" with "club admin" everywhere
- Update the "Resolving club IDs" section: mention `isOwner` field
- Update membership states section: document the role values
- Add section explaining the three auth tiers: member, clubadmin, superadmin

### 9. Update CLAUDE.md

- Update test data section if tokens/roles change
- Dev database will need reseeding after migration

### 10. Test changes

**Fixtures (`test/fixtures.ts`):**
- `makeActor()` default role changes from `'owner'` to `'clubadmin'`
- Add `isOwner: true` to default membership
- `makeAdminAuthResult()` stays as-is (superadmin)
- Add helpers for creating clubadmin actors that are NOT owners

**Integration test harness (`test/integration/harness.ts`):**
- `seedOwner()` — still creates the club owner, but membership role is now `'clubadmin'` and response includes `isOwner: true`
- Add `seedClubAdmin()` — creates a member with `role: 'clubadmin'` who is NOT the owner. **Important:** the current harness auto-creates a comped subscription for non-owner memberships (line ~289). `seedClubAdmin()` must do the same — clubadmins get free access just like owners, so they need either `role = 'clubadmin'` in the `accessible_club_memberships` view (which we're updating) OR a comped subscription. After the migration, `role = 'clubadmin'` in the view gives free access, so the comped subscription is technically redundant for admins. But verify this works correctly in tests.
- Update all references to `role: 'owner'` in test assertions

**Unit tests (`test/app.test.ts`):**
- Update all action names in dispatch calls
- Update role values in test data
- Add tests for the new auth model: clubadmin can do what owner used to do, regular member cannot

**Integration tests:**
- `test/integration/memberships.test.ts` — update action names, add tests for clubadmin (non-owner) performing membership operations
- `test/integration/admissions.test.ts` — same
- `test/integration/admin.test.ts` — massive update: rename all action references, add clubadmin tests, verify superadmin can call clubadmin actions
- `test/integration/smoke.test.ts` — update action counts, action name assertions
- Add new test file or section for promote/demote: `test/integration/clubadmin-roles.test.ts`

**New test scenarios to cover:**
- Clubadmin (non-owner) can list memberships, review, create, transition
- Clubadmin (non-owner) can list admissions, transition, issue access
- Clubadmin (non-owner) CANNOT promote or demote (owner-only, 403)
- Superadmin CAN call clubadmin actions (list, create, transition, etc.) without being a club member
- Superadmin CANNOT promote or demote (owner-only — superadmin uses `superadmin.clubs.assignOwner` for ownership changes)
- Regular member CANNOT call clubadmin actions (403)
- Owner can promote member → clubadmin
- Owner can demote clubadmin → member
- Owner CANNOT be demoted (403 with clear message)
- Demoting an ex-owner (null sponsor) assigns current owner as sponsor
- Promoted clubadmin can immediately call clubadmin actions
- Demoted member immediately loses clubadmin access
- `clubadmin.clubs.getStatistics` returns real stats for the specified club
- All clubadmin actions reject missing `clubId` with 400

### 11. Schema snapshot

`test/snapshots/api-schema.json` will change significantly (many renamed actions, new actions, changed auth levels). Regenerate after implementation.

## What NOT to change

- **Club archiving** (`superadmin.clubs.archive`) — this is about club lifecycle, not content moderation. Stays as-is.
- **Entity archiving / redaction** — will be replaced by the content removal system in a follow-up PR. For now just rename `admin.content.archive` → `superadmin.content.archive` etc.
- **The `'owner'` and `'admin'` values in the Postgres `membership_role` enum** — leave them as unused values. Removing enum values from Postgres is painful and unnecessary.
- **`club_owner_versions` table** — ownership tracking stays exactly as-is.
- **`actor_is_club_owner()` SQL function** — still needed for owner-only operations (promote/demote).

## Verification

After all changes, run:
```bash
npm run check                     # TypeScript type check
npm run test:unit                 # Unit tests (no DB needed)
npm run test:unit:db              # Unit tests that need Postgres
npm run test:integration:non-llm  # Integration tests (no LLM)
npm run test:integration:with-llm # Integration tests (with LLM)
```

ALL must pass.

## Summary of new action surface

After this work, the full action list by auth level:

**`none` (unauthenticated):**
- `admissions.public.requestChallenge`
- `admissions.public.submitApplication`

**`member` (any authenticated member):**
- `session.getContext`
- `profile.get`, `profile.update`
- `members.list`, `members.searchByFullText`, `members.searchBySemanticSimilarity`
- `content.create`, `content.list`, `content.update`, `entities.archive`, `entities.redact`, `content.searchBySemanticSimilarity`
- `events.create`, `events.list`, `events.rsvp`
- `messages.send`, `messages.getInbox`, `messages.getThread`, `messages.redact`
- `updates.list`, `updates.acknowledge`
- `vouches.create`, `vouches.list`
- `quotas.getUsage`
- `accessTokens.list`, `accessTokens.create`, `accessTokens.revoke`
- `admissions.sponsorCandidate`

(Note: `entities.archive`, `entities.redact`, `messages.redact` will be replaced by `content.remove` / `messages.remove` in the follow-up content removal PR.)

**`clubadmin` (club admin, club owner, or superadmin):**
- `clubadmin.memberships.list`
- `clubadmin.memberships.listForReview`
- `clubadmin.memberships.create`
- `clubadmin.memberships.setStatus`
- `clubadmin.admissions.list`
- `clubadmin.admissions.setStatus`
- `clubadmin.admissions.issueAccessToken`
- `clubadmin.members.promoteToAdmin` (owner-only at handler level)
- `clubadmin.members.demoteFromAdmin` (owner-only at handler level)
- `clubadmin.clubs.getStatistics`

**`superadmin` (server operator only):**
- `superadmin.platform.getOverview`
- `superadmin.members.list`, `superadmin.members.get`
- `superadmin.clubs.list`, `superadmin.clubs.create`, `superadmin.clubs.archive`, `superadmin.clubs.assignOwner`
- `superadmin.diagnostics.getHealth`
- `superadmin.accessTokens.list`, `superadmin.accessTokens.revoke`
- `superadmin.content.list`, `superadmin.content.archive`, `superadmin.content.redact`
- `superadmin.messages.listThreads`, `superadmin.messages.getThread`, `superadmin.messages.redact`
