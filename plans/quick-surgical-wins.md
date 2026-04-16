# Plan: Two quick surgical P1 fixes

One PR, two independent one-line fixes. No migrations. No schema changes.

Originally scoped as three fixes — a reviewer pass correctly pointed out that the vouch-oracle "fix" (BUGS.md #15) was cosmetic: changing the 404 error message doesn't close the oracle because the attacker reads the HTTP status code, not the message text. Dropped — the vouch oracle needs a real design pass, not a wording cleanup.

## Context

These are two P1 bugs from `plans/BUGS.md` that we can land immediately, independent of the quality-gate redesign and worker reliability program.

---

## Fix 1: Invitation cap bypass via parallel issuance (BUGS.md #1)

### The bug

`src/clubs/unified.ts:1161`. The advisory lock that serialises invitation issuance is keyed on `(clubId, sponsorId, normalizedEmail)`:

```sql
select pg_advisory_xact_lock(hashtext('invitation_issue:' || $1 || ':' || $2 || ':' || $3))
```

The third parameter is `normalizedEmail`. This means two parallel `invitations.issue` calls for **different** candidate emails each acquire their own lock, each independently read `count < 3`, and each succeed — blowing past the 3-per-30-days cap.

### The fix

Remove the email from the lock key. The lock should serialise all invitation issuance for a given sponsor in a given club, not per-email:

**File:** `src/clubs/unified.ts:1160-1163`

Change:
```typescript
await client.query(
  `select pg_advisory_xact_lock(hashtext('invitation_issue:' || $1 || ':' || $2 || ':' || $3))`,
  [input.clubId, input.actorMemberId, normalizedEmail],
);
```

To:
```typescript
await client.query(
  `select pg_advisory_xact_lock(hashtext('invitation_issue:' || $1 || ':' || $2))`,
  [input.clubId, input.actorMemberId],
);
```

The quota query at lines 1167-1177 already counts all invitations for the sponsor regardless of email — we just need the lock to cover the same scope.

### Required regression test

Add a focused parallel test to `test/integration/non-llm/joins-and-invitations.test.ts`, in the existing `describe('invitation lifecycle', ...)` block.

Use `h.api(...)` (not `h.apiOk`) so we can classify by response status — `apiOk` throws a generic `Error` that loses the structured envelope and makes `Promise.allSettled` awkward to inspect.

Also assert against the DB, not just the HTTP envelope: the cap's whole purpose is that only 3 invitation rows end up live. Proving 3 HTTP 200s + 2 HTTP 429s is necessary but not sufficient — add a SQL-level count to lock in the invariant.

```typescript
it('enforces the 3-per-30-days cap under parallel issuance for different emails', async () => {
  const owner = await h.seedOwner('invite-cap-parallel', 'Invite Cap Parallel');
  const sponsor = await h.seedCompedMember(owner.club.id, 'Parallel Sponsor');

  // Fire 5 issuance calls in parallel for 5 different emails.
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      h.api(sponsor.token, 'invitations.issue', {
        clubId: owner.club.id,
        candidateName: `Candidate ${i}`,
        candidateEmail: `cap-candidate-${i}@example.com`,
        reason: 'parallel-cap-test',
      }),
    ),
  );

  const okCount = results.filter((r) => r.status === 200 && r.body.ok).length;
  const quotaErrCount = results.filter((r) => {
    if (r.status !== 429 || r.body.ok) return false;
    const err = r.body.error as { code?: string } | undefined;
    return err?.code === 'invitation_quota_exceeded';
  }).length;

  assert.equal(okCount, 3, 'expected exactly 3 issuance calls to succeed');
  assert.equal(quotaErrCount, 2, 'expected exactly 2 issuance calls to hit the cap');

  // Independent proof at the DB level: only 3 live invitation rows exist.
  const liveCount = await h.db.query<{ count: string }>(
    `select count(*)::text as count
     from invitations
     where club_id = $1
       and sponsor_member_id = $2
       and revoked_at is null
       and used_at is null
       and expired_at is null`,
    [owner.club.id, sponsor.memberId],
  );
  assert.equal(Number(liveCount.rows[0].count), 3, 'expected exactly 3 live invitation rows after the burst');
});
```

Check the harness for the exact DB handle name (`h.db` vs `h.pool` vs similar) before writing — adjust accordingly.

This test must fail against `main` (the bug lets all 5 succeed and leaves 5 live rows) and pass after the fix. Confirm both directions before shipping — see the "prove the tests catch the bugs" step below for the safe way to do that in this repo.

---

## Fix 2: `billingBanMember` terminal-state typo (BUGS.md #14)

### The bug

`src/postgres.ts:1767`. The "non-terminal states" filter uses enum values that don't exist in the `membership_state` type:

```typescript
const terminalStates = ['banned', 'expired', 'revoked', 'rejected', 'left', 'removed'];
```

`revoked`, `rejected`, and `left` are not valid `membership_state` enum members. The actual terminal states it should skip are `banned`, `expired`, `removed`, `declined`, and `withdrawn`. Because `declined` and `withdrawn` are missing, banning a member silently rewrites their historical `declined`/`withdrawn` rows to `banned`, destroying the audit trail of the original decline/withdraw decision.

### The fix

**File:** `src/postgres.ts:1767`

Change:
```typescript
const terminalStates = ['banned', 'expired', 'revoked', 'rejected', 'left', 'removed'];
```

To:
```typescript
const terminalStates = ['banned', 'expired', 'removed', 'declined', 'withdrawn'];
```

### Required regression test

There is no existing test guarding `superadmin.billing.banMember`'s preservation of terminal memberships. Add one — without it, a future refactor can silently re-introduce the bug.

The real invariant this bug violates is **audit-trail preservation**: a `declined` or `withdrawn` decision produces a `club_membership_state_versions` row, and the ban must not rewrite that row or append extra state-version rows for terminal memberships. So assert more than "current `status` is unchanged" — assert that no new version row was appended for the terminal memberships, and that exactly one `banned` version row was appended for the formerly-active membership.

Suggested location: new file `test/integration/non-llm/billing-ban-preserves-terminal.test.ts` (or inside an existing superadmin billing test file if one lives nearby — check before creating a new file).

Shape:

```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';

let h: TestHarness;

before(async () => { h = await TestHarness.start(); }, { timeout: 60_000 });
after(async () => { await h?.stop(); }, { timeout: 15_000 });

describe('superadmin.billing.banMember preserves terminal memberships', () => {
  it('does not rewrite declined or withdrawn memberships to banned, and appends no extra history', async () => {
    // Seed:
    //   - member M with three memberships:
    //     * Club A: status = 'declined'   (terminal — must be preserved)
    //     * Club B: status = 'withdrawn'  (terminal — must be preserved)
    //     * Club C: status = 'active'     (should transition to 'banned')
    //
    // Prefer harness helpers if they cover 'declined'/'withdrawn'. Otherwise use direct
    // SQL inserts, following the pattern in test/integration/non-llm/clubadmin-access.test.ts.
    //
    // Capture state-version row counts for each of M's memberships BEFORE the ban.
    //
    // Act: superadmin calls billing.banMember for M.
    //
    // Assert:
    //   - members.state = 'banned'
    //   - Club A membership status is STILL 'declined'
    //   - Club B membership status is STILL 'withdrawn'
    //   - Club C membership status is now 'banned'
    //   - club_membership_state_versions row count for Club A membership: UNCHANGED
    //   - club_membership_state_versions row count for Club B membership: UNCHANGED
    //   - club_membership_state_versions row count for Club C membership: BEFORE + 1
    //   - the single new Club C version row has status = 'banned'
  });
});
```

The test stub above is a sketch — the implementing agent should flesh it out using the existing harness helpers. Reference `test/integration/non-llm/clubadmin-access.test.ts` for a similar direct-SQL-seed-then-API-act pattern. Prefer the harness's seeding helpers over hand-written SQL if any cover `declined` / `withdrawn` cleanly.

---

## Dropped: Vouches.create cross-club oracle (BUGS.md #15)

Previously in this plan; dropped after review.

**Why dropped:** My proposed fix was to change the error message from `"Target member was not found in this club"` to `"Member not found"`. The reviewer correctly pointed out that the attacker reads the HTTP status code, not the message text. A `404` still means "target is not in this club" and a `200`/`409` still means "they are." Renaming the string doesn't close the oracle.

A real fix needs one of:
- Removing the target-in-club check entirely and letting the DB constraint decide (changes data-model semantics — not surgical)
- Rate-limiting `vouches.create` per caller to make enumeration expensive (new subsystem — not surgical)
- Investigating whether members of Club B can already see other members of Club B through legitimate API paths — in which case the oracle leaks no new information and the audit finding is a false positive (investigation, not a fix)

Leave in BUGS.md. Revisit as part of a dedicated pass.

---

## Shared steps for the PR

1. **Type-check**: `npx tsc --noEmit` (must pass cleanly — if it still fails on unrelated code from the in-flight quality-gate work, check with the user before proceeding)
2. **Unit tests**: `npm run test:unit`
3. **Integration tests**: `npm run test:integration:non-llm` — both new regression tests must pass
4. **Prove the regression tests actually catch the bugs** — **safely**.

   The working tree of this repo is dirty with multiple concurrent workstreams, and project policy forbids destructive git commands on the working tree (no `git checkout --`, no `git stash`, no `git restore`). So "run the new tests against main" cannot mean checking out `main` in place.

   Use a temporary worktree instead:

   ```bash
   git worktree add /tmp/clawclub-main-verify main
   cd /tmp/clawclub-main-verify
   # copy only the new test files from your working branch into this worktree
   # (do NOT copy the code fixes — we want main behavior plus new tests)
   npm install
   npm run test:integration:non-llm -- --test-name-pattern '…new test names…'
   ```

   Confirm both new tests **fail** against `main` in the worktree. If either passes against `main`, the test doesn't actually catch the bug — rewrite it until it does.

   Then come back to the working branch, keep the fixes, and confirm both tests **pass**. Remove the worktree with `git worktree remove /tmp/clubclub-main-verify` once done.

   Without this step the tests are decoration — they might silently pass in both worlds.

5. **Bump version**: increment patch in `package.json`
6. **Commit** with message: `Fix invitation cap bypass and billing ban terminal states`
7. **Do not push** — wait for explicit approval

## Notes on line numbers

Line numbers in this plan reflect the tree at the time of writing. If the tree has shifted (other workstreams landing), trust the code — find the advisory-lock call, the `terminalStates` array, etc., by pattern. The fixes themselves are unambiguous.
