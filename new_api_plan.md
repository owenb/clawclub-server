# API Naming Overhaul — Implementation Plan

Complete, locked-down plan. **No naming decisions remain open.** Execute mechanically.

## Design rules

1. `[scope.]resource.verb` — always
2. Last segment starts with a verb (exception: `events.rsvp`)
3. camelCase within segments
4. Domain = first segment of action name, always, no exceptions
5. No implementation jargon in public names (`content` not `entities`, `accessTokens` not `tokens`)
6. Qualifiers go in the resource path, not stuffed into verbs

---

## Complete rename map

### Name changes (33 renames)

| Old name | New name |
|----------|----------|
| `session.describe` | `session.getContext` |
| `admissions.challenge` | `admissions.public.requestChallenge` |
| `admissions.apply` | `admissions.public.submitApplication` |
| `admissions.crossChallenge` | `admissions.crossClub.requestChallenge` |
| `admissions.crossApply` | `admissions.crossClub.submitApplication` |
| `admissions.sponsor` | `admissions.sponsorCandidate` |
| `entities.create` | `content.create` |
| `entities.update` | `content.update` |
| `entities.remove` | `content.remove` |
| `entities.list` | `content.list` |
| `entities.findViaEmbedding` | `content.searchBySemanticSimilarity` |
| `members.fullTextSearch` | `members.searchByFullText` |
| `members.findViaEmbedding` | `members.searchBySemanticSimilarity` |
| `messages.list` | `messages.getInbox` |
| `messages.read` | `messages.getThread` |
| `quotas.status` | `quotas.getUsage` |
| `tokens.list` | `accessTokens.list` |
| `tokens.create` | `accessTokens.create` |
| `tokens.revoke` | `accessTokens.revoke` |
| `billing.status` | `billing.getMembershipStatus` |
| `clubadmin.memberships.review` | `clubadmin.memberships.listForReview` |
| `clubadmin.memberships.transition` | `clubadmin.memberships.setStatus` |
| `clubadmin.admissions.transition` | `clubadmin.admissions.setStatus` |
| `clubadmin.admissions.issueAccess` | `clubadmin.admissions.issueAccessToken` |
| `clubadmin.clubs.stats` | `clubadmin.clubs.getStatistics` |
| `clubadmin.entities.remove` | `clubadmin.content.remove` |
| `superadmin.overview` | `superadmin.platform.getOverview` |
| `superadmin.diagnostics.health` | `superadmin.diagnostics.getHealth` |
| `superadmin.messages.threads` | `superadmin.messages.listThreads` |
| `superadmin.messages.read` | `superadmin.messages.getThread` |
| `superadmin.tokens.list` | `superadmin.accessTokens.list` |
| `superadmin.tokens.revoke` | `superadmin.accessTokens.revoke` |
| `superadmin.members.create` | `superadmin.members.createWithAccessToken` |

### Domain-only changes (6 actions — name stays, domain changes)

| Action name | Old domain | New domain |
|-------------|-----------|-----------|
| `vouches.create` | `admissions` | `vouches` |
| `vouches.list` | `admissions` | `vouches` |
| `events.create` | `content` | `events` |
| `events.list` | `content` | `events` |
| `events.rsvp` | `content` | `events` |
| `events.remove` | `content` | `events` |

### Removal (1 action)

| Removed action | Disposition |
|---------------|------------|
| `messages.inbox` | Merged into `messages.getInbox` — always return unread counts, add `unreadOnly` filter |

### Transport change

**Remove `GET /updates`** from `src/server.ts`. `updates.list` is the canonical polling action. `GET /updates/stream` (SSE) stays.

- **Poll:** `updates.list` (action via POST /api)
- **Stream:** `GET /updates/stream` (SSE — stays, since SSE can't go through POST /api)
- **Acknowledge:** `updates.acknowledge` (action via POST /api)

---

## Final 69 actions

### Member Product API (32 actions)

| # | Name | Auth | Domain |
|---|------|------|--------|
| 1 | `session.getContext` | `member` | `session` |
| 2 | `admissions.public.requestChallenge` | `none` | `admissions` |
| 3 | `admissions.public.submitApplication` | `none` | `admissions` |
| 4 | `admissions.crossClub.requestChallenge` | `member` | `admissions` |
| 5 | `admissions.crossClub.submitApplication` | `member` | `admissions` |
| 6 | `admissions.sponsorCandidate` | `member` | `admissions` |
| 7 | `vouches.create` | `member` | `vouches` |
| 8 | `vouches.list` | `member` | `vouches` |
| 9 | `content.create` | `member` | `content` |
| 10 | `content.update` | `member` | `content` |
| 11 | `content.remove` | `member` | `content` |
| 12 | `content.list` | `member` | `content` |
| 13 | `content.searchBySemanticSimilarity` | `member` | `content` |
| 14 | `events.create` | `member` | `events` |
| 15 | `events.list` | `member` | `events` |
| 16 | `events.rsvp` | `member` | `events` |
| 17 | `events.remove` | `member` | `events` |
| 18 | `profile.get` | `member` | `profile` |
| 19 | `profile.update` | `member` | `profile` |
| 20 | `messages.send` | `member` | `messages` |
| 21 | `messages.getInbox` | `member` | `messages` |
| 22 | `messages.getThread` | `member` | `messages` |
| 23 | `messages.remove` | `member` | `messages` |
| 24 | `members.list` | `member` | `members` |
| 25 | `members.searchByFullText` | `member` | `members` |
| 26 | `members.searchBySemanticSimilarity` | `member` | `members` |
| 27 | `quotas.getUsage` | `member` | `quotas` |
| 28 | `accessTokens.list` | `member` | `accessTokens` |
| 29 | `accessTokens.create` | `member` | `accessTokens` |
| 30 | `accessTokens.revoke` | `member` | `accessTokens` |
| 31 | `updates.list` | `member` | `updates` |
| 32 | `updates.acknowledge` | `member` | `updates` |

### Club Governance API (13 actions)

| # | Name | Auth | Domain |
|---|------|------|--------|
| 33 | `billing.getMembershipStatus` | `member` | `billing` |
| 34 | `clubadmin.memberships.list` | `clubadmin` | `clubadmin` |
| 35 | `clubadmin.memberships.listForReview` | `clubadmin` | `clubadmin` |
| 36 | `clubadmin.memberships.create` | `clubadmin` | `clubadmin` |
| 37 | `clubadmin.memberships.setStatus` | `clubadmin` | `clubadmin` |
| 38 | `clubadmin.admissions.list` | `clubadmin` | `clubadmin` |
| 39 | `clubadmin.admissions.setStatus` | `clubadmin` | `clubadmin` |
| 40 | `clubadmin.admissions.issueAccessToken` | `clubadmin` | `clubadmin` |
| 41 | `clubadmin.clubs.getStatistics` | `clubadmin` | `clubadmin` |
| 42 | `clubadmin.content.remove` | `clubadmin` | `clubadmin` |
| 43 | `clubadmin.events.remove` | `clubadmin` | `clubadmin` |
| 44 | `clubowner.members.promoteToAdmin` | `clubowner` | `clubowner` |
| 45 | `clubowner.members.demoteFromAdmin` | `clubowner` | `clubowner` |

### Operator API (16 actions)

| # | Name | Auth | Domain |
|---|------|------|--------|
| 46 | `superadmin.platform.getOverview` | `superadmin` | `superadmin` |
| 47 | `superadmin.diagnostics.getHealth` | `superadmin` | `superadmin` |
| 48 | `superadmin.members.list` | `superadmin` | `superadmin` |
| 49 | `superadmin.members.get` | `superadmin` | `superadmin` |
| 50 | `superadmin.members.createWithAccessToken` | `superadmin` | `superadmin` |
| 51 | `superadmin.memberships.create` | `superadmin` | `superadmin` |
| 52 | `superadmin.clubs.list` | `superadmin` | `superadmin` |
| 53 | `superadmin.clubs.create` | `superadmin` | `superadmin` |
| 54 | `superadmin.clubs.archive` | `superadmin` | `superadmin` |
| 55 | `superadmin.clubs.assignOwner` | `superadmin` | `superadmin` |
| 56 | `superadmin.clubs.update` | `superadmin` | `superadmin` |
| 57 | `superadmin.content.list` | `superadmin` | `superadmin` |
| 58 | `superadmin.messages.listThreads` | `superadmin` | `superadmin` |
| 59 | `superadmin.messages.getThread` | `superadmin` | `superadmin` |
| 60 | `superadmin.accessTokens.list` | `superadmin` | `superadmin` |
| 61 | `superadmin.accessTokens.revoke` | `superadmin` | `superadmin` |

### Billing Sync API (8 actions)

| # | Name | Auth | Domain |
|---|------|------|--------|
| 62 | `superadmin.billing.activateMembership` | `superadmin` | `superadmin` |
| 63 | `superadmin.billing.renewMembership` | `superadmin` | `superadmin` |
| 64 | `superadmin.billing.markRenewalPending` | `superadmin` | `superadmin` |
| 65 | `superadmin.billing.expireMembership` | `superadmin` | `superadmin` |
| 66 | `superadmin.billing.cancelAtPeriodEnd` | `superadmin` | `superadmin` |
| 67 | `superadmin.billing.banMember` | `superadmin` | `superadmin` |
| 68 | `superadmin.billing.setClubPrice` | `superadmin` | `superadmin` |
| 69 | `superadmin.billing.archiveClub` | `superadmin` | `superadmin` |

---

## Implementation phases

Execute in order. Run `npx tsc --noEmit` after each phase to catch errors early.

### Phase 1: Database

The project has 3 migrations in `db/migrations/`. Since we are pre-launch with no live data, the cleanest approach is to dump the current schema into `db/init.sql` and delete the migrations.

**Step 1: Dump current schema**
```bash
pg_dump --schema-only --no-owner --no-privileges clawclub_dev > db/init.sql
```
Review the dump and clean it up to match the existing `init.sql` style.

**Step 2: Delete migrations**
```bash
rm db/migrations/*.sql
```

**Step 3: Update action names in `db/init.sql`**

The `quota_policies` table has a CHECK constraint (~line 992):
```sql
-- Change:
action_name IN ('entities.create', 'events.create')
-- To:
action_name IN ('content.create', 'events.create')
```

**Step 4: Update `db/seeds/dev.sql`**

- `quota_policies` INSERTs (~line 362): `'entities.create'` → `'content.create'`
- `llm_usage_log` INSERTs (~line 956): `'entities.create'` → `'content.create'`

### Phase 2: Runtime business logic

These files hardcode action names outside the schema layer.

**`src/clubs/index.ts` (line 101)**

The `QUOTA_ENTITY_KINDS` map hardcodes action names for quota enforcement:
```typescript
// Change:
'entities.create': ['post', 'opportunity', 'service', 'ask'],
// To:
'content.create': ['post', 'opportunity', 'service', 'ask'],
```

**`src/postgres.ts` (line 305)**

The repository's `createEntity` method calls quota enforcement with the old name:
```typescript
// Change:
await clubs.enforceQuota(input.authorMemberId, input.clubId, 'entities.create');
// To:
await clubs.enforceQuota(input.authorMemberId, input.clubId, 'content.create');
```

**`src/clubs/admissions.ts` (line 254, 257)**

Error message references old action name:
```typescript
// Change both occurrences:
'admissions.crossApply'
// To:
'admissions.crossClub.submitApplication'
```

**`src/clubs/admissions.ts` (line 383)**

LLM usage log writes old action name for cold apply:
```typescript
// Change:
'admissions.apply'
// To:
'admissions.public.submitApplication'
```

**`src/clubs/admissions.ts` (line 677)**

LLM usage log writes old action name for cross-club apply:
```typescript
// Change:
'admissions.crossApply'
// To:
'admissions.crossClub.submitApplication'
```

**`src/quality-gate.ts` (lines 6-13)**

Update the `GATED_ACTIONS` set:
```typescript
const GATED_ACTIONS = new Set([
  'content.create',
  'content.update',
  'events.create',
  'profile.update',
  'vouches.create',
  'admissions.sponsorCandidate',
]);
```

**Prompt files: `src/prompts/`**

Rename to match new action names:
- `entities-create.txt` → `content-create.txt`
- `admissions-sponsor.txt` → `admissions-sponsorCandidate.txt`
- `events-create.txt` — no change
- `profile-update.txt` — no change
- `vouches-create.txt` — no change

### Phase 3: Schema definitions

Each schema file needs action name and domain updated in its `ActionDefinition` objects.

**`src/schemas/session.ts`**
- `'session.describe'` → `'session.getContext'`
- domain: `'platform'` → `'session'`

**`src/schemas/admissions-cold.ts`**
- `'admissions.challenge'` → `'admissions.public.requestChallenge'`
- `'admissions.apply'` → `'admissions.public.submitApplication'`
- domain: `'cold-admissions'` → `'admissions'` (both actions)

**`src/schemas/admissions-cross.ts`**
- `'admissions.crossChallenge'` → `'admissions.crossClub.requestChallenge'`
- `'admissions.crossApply'` → `'admissions.crossClub.submitApplication'`
- domain stays `'admissions'`

**`src/schemas/membership.ts`**
- `'admissions.sponsor'` → `'admissions.sponsorCandidate'`
- `qualityGate: 'admissions-sponsor'` → `'admissions-sponsorCandidate'`
- `'members.fullTextSearch'` → `'members.searchByFullText'`
- `'members.findViaEmbedding'` → `'members.searchBySemanticSimilarity'`
- `vouches.create` domain: `'admissions'` → `'vouches'`
- `vouches.list` domain: `'admissions'` → `'vouches'`

**`src/schemas/entities.ts`**
- `'entities.create'` → `'content.create'`, `qualityGate: 'entities-create'` → `'content-create'`
- `'entities.update'` → `'content.update'`, `qualityGate: 'entities-create'` → `'content-create'`
- `'entities.remove'` → `'content.remove'`
- `'entities.list'` → `'content.list'`
- `'entities.findViaEmbedding'` → `'content.searchBySemanticSimilarity'`, domain: `'entities'` → `'content'`
- All other domains stay `'content'` (already correct)

**`src/schemas/events.ts`**
- domain: `'content'` → `'events'` (all 4 actions: `events.create`, `events.list`, `events.rsvp`, `events.remove`)
- No action name changes

**`src/schemas/messages.ts`**
- `'messages.list'` → `'messages.getInbox'`
- `'messages.read'` → `'messages.getThread'`
- **MERGE** `messages.inbox` into `messages.getInbox` (see Messages Merge Detail below)
- **REMOVE** the `messages.inbox` action definition and remove from `registerActions` call

**`src/schemas/platform.ts`**
- `'quotas.status'` → `'quotas.getUsage'`, domain: `'platform'` → `'quotas'`
- `'tokens.list'` → `'accessTokens.list'`, domain: `'platform'` → `'accessTokens'`
- `'tokens.create'` → `'accessTokens.create'`, domain: `'platform'` → `'accessTokens'`
- `'tokens.revoke'` → `'accessTokens.revoke'`, domain: `'platform'` → `'accessTokens'`

**`src/schemas/billing.ts`**
- `'billing.status'` → `'billing.getMembershipStatus'`

**`src/schemas/clubadmin.ts`**
- `'clubadmin.memberships.review'` → `'clubadmin.memberships.listForReview'`
- `'clubadmin.memberships.transition'` → `'clubadmin.memberships.setStatus'`
- `'clubadmin.admissions.transition'` → `'clubadmin.admissions.setStatus'`
- `'clubadmin.admissions.issueAccess'` → `'clubadmin.admissions.issueAccessToken'`
- `'clubadmin.clubs.stats'` → `'clubadmin.clubs.getStatistics'`
- `'clubadmin.entities.remove'` → `'clubadmin.content.remove'`

**`src/schemas/superadmin.ts`**
- `'superadmin.overview'` → `'superadmin.platform.getOverview'`
- `'superadmin.diagnostics.health'` → `'superadmin.diagnostics.getHealth'`
- `'superadmin.messages.threads'` → `'superadmin.messages.listThreads'`
- `'superadmin.messages.read'` → `'superadmin.messages.getThread'`
- `'superadmin.tokens.list'` → `'superadmin.accessTokens.list'`
- `'superadmin.tokens.revoke'` → `'superadmin.accessTokens.revoke'`
- `'superadmin.members.create'` → `'superadmin.members.createWithAccessToken'`

**No changes needed:**
- `src/schemas/updates.ts` — `updates.list` and `updates.acknowledge` stay as-is
- `src/schemas/clubowner.ts`
- `src/schemas/billing-sync.ts`
- `src/schemas/profile.ts`

### Phase 4: Server and transport layer

**`src/server.ts` — Remove `GET /updates` endpoint (~lines 366-423)**

Delete the entire `if (request.method === 'GET' && url.pathname === '/updates')` block. `updates.list` is the canonical polling surface. Keep `GET /updates/stream` for SSE.

**`src/server.ts` (line 36)** — Cold admission type:
```typescript
// Change:
type ColdAdmissionAction = 'admissions.challenge' | 'admissions.apply';
// To:
type ColdAdmissionAction = 'admissions.public.requestChallenge' | 'admissions.public.submitApplication';
```

**`src/server.ts` (line 239-242)** — Cold admission check function:
```typescript
// Change the hardcoded action names:
value === 'admissions.challenge' || value === 'admissions.apply'
// To:
value === 'admissions.public.requestChallenge' || value === 'admissions.public.submitApplication'
```

**`src/server.ts` (lines 354-356)** — Rate limit config:
```typescript
// Change both keys:
'admissions.challenge': ...
'admissions.apply': ...
// To:
'admissions.public.requestChallenge': ...
'admissions.public.submitApplication': ...
```

Also update `DEFAULT_COLD_APPLICATION_RATE_LIMITS` (find its definition) to use new keys.

**`src/server.ts` (line 614)** — 404 message for unsupported routes:
```
// Change:
'Only GET /, GET /skill, GET /updates, GET /updates/stream, GET /api/schema, and POST /api are supported'
// To:
'Only GET /, GET /skill, GET /updates/stream, GET /api/schema, and POST /api are supported'
```

**`src/schema-endpoint.ts` (line 94)** — Remove the `/updates` endpoint from transport docs:
```typescript
// Remove this line:
updates: { method: 'GET', path: '/updates', contentType: 'application/json' },
// Keep only:
stream: { method: 'GET', path: '/updates/stream', contentType: 'text/event-stream' },
```

**`src/schema-endpoint.ts` (line 100)** — Unauthenticated actions list:
```typescript
// Change:
unauthenticatedActions: ['admissions.challenge', 'admissions.apply'],
// To:
unauthenticatedActions: ['admissions.public.requestChallenge', 'admissions.public.submitApplication'],
```

**`src/schema-endpoint.ts` (~line 111)** — Request example uses old action name:
```typescript
// Change the example action from:
'session.describe'
// To:
'session.getContext'
```

**`src/http-smoke.ts` (~line 199)** — Update action name references:
- `'session.describe'` → `'session.getContext'`
- `'members.fullTextSearch'` → `'members.searchByFullText'`
- `'messages.inbox'` → `'messages.getInbox'`
- `'entities.list'` → `'content.list'`
- **Remove** `'GET /updates'` from the test list (endpoint removed)
- `'entities.list'` → `'content.list'` (~line 245)

### Phase 5: Test files

**IMPORTANT:** Search every test file for ALL old action names from the rename map. The entries below call out known references but each file should be grepped for any others.

**`test/integration/harness.ts` (~line 453)**

The `getUpdates()` helper currently calls `GET /updates`. Since that endpoint is being removed, **rewrite this helper** to call `updates.list` through the action dispatch (POST /api) instead. Match the response shape expected by callers — may need to unwrap the action envelope.

**`test/integration/smoke.test.ts`**
- Update action count from `70` to `69`
- `'session.describe'` → `'session.getContext'`
- Update any assertions about action name prefixes
- Update/remove references to `GET /updates` in transport schema assertions

**`test/integration/admin.test.ts`**
- This file is large and references MANY renamed actions. Search for and update:
  - `quotas.status` → `quotas.getUsage`
  - `entities.create` → `content.create` (in quota test strings)
  - `superadmin.overview` → `superadmin.platform.getOverview`
  - `superadmin.diagnostics.health` → `superadmin.diagnostics.getHealth`
  - `superadmin.tokens.list` → `superadmin.accessTokens.list`
  - `superadmin.tokens.revoke` → `superadmin.accessTokens.revoke`
  - `superadmin.members.create` → `superadmin.members.createWithAccessToken`
  - `tokens.list` → `accessTokens.list`
  - `tokens.create` → `accessTokens.create`
  - `tokens.revoke` → `accessTokens.revoke`
  - `messages.list` → `messages.getInbox`
  - `messages.read` → `messages.getThread`
  - `messages.inbox` → `messages.getInbox`
  - `clubadmin.memberships.transition` → `clubadmin.memberships.setStatus`
  - `clubadmin.admissions.transition` → `clubadmin.admissions.setStatus`
  - `clubadmin.admissions.issueAccess` → `clubadmin.admissions.issueAccessToken`
  - `clubadmin.clubs.stats` → `clubadmin.clubs.getStatistics`
  - `clubadmin.entities.remove` → `clubadmin.content.remove`
  - `billing.status` → `billing.getMembershipStatus`
  - `updates.list` — stays unchanged

**`test/integration/admissions.test.ts`**
- `'admissions.challenge'` → `'admissions.public.requestChallenge'`
- `'admissions.apply'` → `'admissions.public.submitApplication'`
- `'clubadmin.admissions.transition'` → `'clubadmin.admissions.setStatus'`
- `'clubadmin.admissions.issueAccess'` → `'clubadmin.admissions.issueAccessToken'`

**`test/integration/content.test.ts`**
- `'entities.create'` → `'content.create'`
- `'entities.update'` → `'content.update'`
- `'entities.list'` → `'content.list'`

**`test/integration/cross-apply.test.ts`**
- `'admissions.crossChallenge'` → `'admissions.crossClub.requestChallenge'`
- `'admissions.crossApply'` → `'admissions.crossClub.submitApplication'`

**`test/integration/events.test.ts`**
- Check for `'entities.create'` → `'content.create'` if referenced

**`test/integration/memberships.test.ts`**
- `'clubadmin.memberships.review'` → `'clubadmin.memberships.listForReview'`
- `'clubadmin.memberships.transition'` → `'clubadmin.memberships.setStatus'`

**`test/integration/messages.test.ts`**
- `'messages.list'` → `'messages.getInbox'`
- `'messages.read'` → `'messages.getThread'`
- `'messages.inbox'` → `'messages.getInbox'` (tests that called inbox separately now call getInbox with `unreadOnly: true`)
- `'updates.list'` references (~line 335): these stay unchanged, but check if tests were using `GET /updates` via the harness helper — those will now go through the rewritten helper

**`test/integration/signals.test.ts`** (~line 25)
- Check for `'updates.list'` references — stay unchanged
- Check for `GET /updates` via harness helper — will go through rewritten helper

**`test/integration/removal.test.ts`** (~line 129)
- `'entities.remove'` → `'content.remove'`
- `'clubadmin.entities.remove'` → `'clubadmin.content.remove'`
- Check for `'updates.list'` references — stay unchanged

**`test/integration/similarity.test.ts`**
- `'entities.findViaEmbedding'` → `'content.searchBySemanticSimilarity'`
- `'members.findViaEmbedding'` → `'members.searchBySemanticSimilarity'`

**`test/integration/llm-gated.test.ts`**
- `'entities.create'` → `'content.create'`
- `'entities.update'` → `'content.update'`
- `'admissions.sponsor'` → `'admissions.sponsorCandidate'`

**`test/integration/quality-gate.test.ts`**
- Check for action name references in gate testing

**`test/integration/billing-sync.test.ts`**
- `'billing.status'` → `'billing.getMembershipStatus'` (~line 303)

**`test/integration/superadmin-provisioning.test.ts`**
- `'superadmin.members.create'` → `'superadmin.members.createWithAccessToken'`
- `'superadmin.tokens.list'` → `'superadmin.accessTokens.list'`
- `'superadmin.tokens.revoke'` → `'superadmin.accessTokens.revoke'`

**`test/integration/matches.test.ts`**, **`test/integration/synchronicity.test.ts`**
- Grep each for old action names and update

**Root test files:**

**`test/app.test.ts`**
- Grep for ALL old action names and update
- **IMPORTANT:** The messages merge changes which repository method the handler calls. Tests at ~line 2526 and ~line 2612 mock `listDirectMessageThreads` for `messages.list`. After the merge, `messages.getInbox` will call `listDirectMessageInbox` instead. These tests need their mocks rewritten to use the inbox mock shape, not just a string rename.
- Also check for `messages.inbox` mock tests (~line 2612+) — these become `messages.getInbox` tests with `unreadOnly: true`

**`test/server.test.ts`**
- `'session.describe'` → `'session.getContext'`
- `'messages.inbox'` → `'messages.getInbox'`
- `'tokens.create'` → `'accessTokens.create'`
- `'admissions.challenge'` → `'admissions.public.requestChallenge'`
- `'admissions.apply'` → `'admissions.public.submitApplication'`
- Check for `GET /updates` references — update or remove

**`test/cold-applications.test.ts`**
- `'admissions.challenge'` → `'admissions.public.requestChallenge'`
- `'admissions.apply'` → `'admissions.public.submitApplication'`

**`test/sponsorships.test.ts`**
- `'admissions.sponsor'` → `'admissions.sponsorCandidate'`

**`test/quotas.test.ts`**
- `'quotas.status'` → `'quotas.getUsage'`
- `'entities.create'` → `'content.create'`

**`test/embeddings-v2.test.ts`**
- `'entities.findViaEmbedding'` → `'content.searchBySemanticSimilarity'`
- `'members.findViaEmbedding'` → `'members.searchBySemanticSimilarity'`

**`test/admin.test.ts`** (root) — grep for old action names

**`test/healthcheck-script.test.ts`**
- If it references `'superadmin.diagnostics.health'`, update to `'superadmin.diagnostics.getHealth'`

### Phase 6: Documentation

**`SKILL.md`**
- Update ALL action name references
- Rename "Entities" section to "Content"
- Update "Tokens" references to "Access Tokens"
- Merge `messages.inbox` into `messages.getInbox` section
- Remove `GET /updates` from transport/endpoints, note `updates.list` as canonical polling
- Update groupings to reflect new domain alignment

**`CLAUDE.md`**
- Update the With-LLM test description: `entities.create`, `entities.update`, `admissions.sponsor` → `content.create`, `content.update`, `admissions.sponsorCandidate`

**`docs/` files** — grep each for old action names and update:
- `docs/plan-permissions-overhaul.md`
- `docs/design-decisions.md` — also update `updates.list` references (~line 292)
- `docs/plan-content-removal.md`
- `docs/self-hosting.md`
- `docs/scaling-todo.md`
- `docs/billing-sync-contract.md`
- `docs/hyperscale.md`
- `docs/member-signals-plan.md`
- `docs/digest-plan.md`
- `docs/railway-guide.md`
- `docs/pre-launch-checklist.md`
- `docs/update-streams.md`

### Phase 7: Snapshot regeneration

Regenerate `test/snapshots/api-schema.json` from the running server:

1. Start the test harness or server
2. Fetch the schema and write the snapshot:
```bash
curl -s http://127.0.0.1:PORT/api/schema | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(JSON.stringify(d.data,null,2))" > test/snapshots/api-schema.json
```

### Phase 8: Validation

```bash
npx tsc --noEmit                     # Type check
npm run test:unit                    # Unit tests
npm run test:unit:db                 # DB unit tests
npm run test:integration:non-llm     # Integration tests (no LLM)
```

Expected: **69 actions** in the schema, all tests green.

---

## Messages merge detail

The `messages.inbox` action is being absorbed into `messages.getInbox` (renamed from `messages.list`).

### Current state
- `messages.list` returns `{ limit, results: directMessageThreadSummary[] }`
- `messages.inbox` returns `{ limit, unreadOnly, results: directMessageInboxSummary[] }`
- `directMessageInboxSummary` is a superset of `directMessageThreadSummary` (adds unread counts)

### Target state
- `messages.getInbox` returns `{ limit, unreadOnly, results: directMessageInboxSummary[] }`
- Always returns unread counts (uses inbox response shape)
- Supports `unreadOnly: boolean` filter (defaults to `false`)
- Handler calls the inbox repository method (`listDirectMessageInbox`) instead of the plain list method (`listDirectMessageThreads`)

### Steps
1. In `src/schemas/messages.ts`, update the `messages.list` definition:
   - Rename action to `messages.getInbox`
   - Add `unreadOnly: z.boolean().default(false)` to wire and parse input
   - Change wire output from `directMessageThreadSummary` to `directMessageInboxSummary`
   - Update handler to call the inbox repo method, passing `unreadOnly`
2. Remove the `messages.inbox` definition entirely
3. Remove it from the `registerActions` call
4. In `test/app.test.ts`, **rewrite** the `messages.list` mock tests (~line 2526) to mock `listDirectMessageInbox` instead of `listDirectMessageThreads`, and adjust the expected response shape. Merge the `messages.inbox` mock tests (~line 2612) into the same test block with `unreadOnly: true`.

---

## Execution order summary

1. **Database:** dump schema to `db/init.sql`, delete migrations, update action names in init.sql and seeds
2. **Runtime business logic:** `src/clubs/index.ts`, `src/postgres.ts`, `src/clubs/admissions.ts`, `src/quality-gate.ts`, prompt file renames
3. **Schema definitions:** all `src/schemas/*.ts` files
4. **Server/transport:** `src/server.ts` (remove `GET /updates`, update cold admission names, update 404 message), `src/schema-endpoint.ts` (update transport docs + example), `src/http-smoke.ts`
5. **Tests:** all `test/**/*.ts` files — rewrite harness `getUpdates()` helper, rewrite `messages.list`/`messages.inbox` unit test mocks
6. **Documentation:** `SKILL.md`, `CLAUDE.md`, `docs/*.md`
7. **Snapshot:** regenerate `test/snapshots/api-schema.json`
8. **Validate:** full test suite

Work through one file at a time. Run `npx tsc --noEmit` after each phase. After all changes, run the full test suite.
