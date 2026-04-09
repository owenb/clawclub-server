# Quality + Legality Gate — Implementation Plan

This is a self-contained brief for an agent picking up the next round of gate work. It assumes no prior conversation. Read top to bottom before writing any code.

## Purpose

Restore server-side quality enforcement on public content, combined with the existing legality check, in a single LLM call per submission. Owen's words:

> "It's very important that we push back on low quality posts that are missing stuff, don't say much, or are missing details like event time or location. I honestly thought we had this. I'm surprised it's out."

The cost constraint is real:

> "In order to not spend too much money on the LLMs, we need to figure out can we do one call for all public posting that does both legality and quality in the same call. If so, all public posts should go through it."

The answer is yes — one call can do both. This plan describes how.

## Historical context (so you don't repeat anyone's mistakes)

Per-action quality enforcement existed and was deliberately removed in commit `446cb71` ("Embeddings, legality gate, admission rework, and bug fixes"). Before that commit:

- `src/quality-gate.ts` loaded per-action prompts from `src/prompts/*.txt` (six files: `entities-create.txt`, `events-create.txt`, `profile-update.txt`, `vouches-create.txt`, `admissions-sponsor.txt`, `messages-send.txt`).
- Each gated action got its own prompt injected into a common wrapper. The LLM checked whether the submission met the action's quality bar and returned `PASS` or a specific complaint.
- The wrapper said *"You are a content quality gate... evaluate whether a submission meets the minimum quality bar before it is published."* Quality-only — it did not check legality.

`446cb71` ripped all of that out and replaced it with the current `GATE_WRAPPER`, which is **legality-only**. The current prompt explicitly says *"Do NOT reject content for being offensive, profane, vulgar, sexually explicit, politically extreme, low quality, vague, or in poor taste."* So the system swung from quality-only to legality-only in 24 hours.

The reason for the removal isn't in the commit message — only the *what*, not the *why*. Speculation: the per-action prompts may have been over-aggressive in practice. Mitigation: the new bars in this plan are intentionally less strict than the deleted ones, especially for gifts.

**The deleted per-action prompts are recoverable** via `git show 21fced3 -- src/prompts/`. They are genuinely well-written and should be the starting point for the new combined prompt's quality clauses. Treat them as material to crib from, not constitution.

What this plan adds that has never existed in this codebase: **a single LLM call that does legality AND quality in the same prompt.** The old gate did quality-only. The current gate does legality-only. The new gate does both.

## Gated action set

The set of actions that go through the new combined gate:

| Action | Gated? | Notes |
|---|---|---|
| `content.create` | ✅ | Per-kind quality bar (post / opportunity / service / ask / gift) |
| `content.update` | ✅ | Same per-kind bars apply to updates |
| `events.create` | ✅ | Title, start time, sufficient description, timezone if ambiguous |
| `profile.update` | ✅ | Free-text fields must be substantive and specific |
| `vouches.create` | ✅ | Firsthand observable evidence required |
| `admissions.sponsorCandidate` | ❌ | **Removed per Owen's directive.** A sponsor cannot reasonably know what the candidate brings — gating their reason is unfair. |
| `messages.send` | ❌ | DMs are sacred. No gating, ever. |
| `admissions.public.submitApplication` | ❌ | Cold admissions go through the **separate** `runAdmissionGate` (completeness only, see below). Do not touch. |
| `admissions.crossClub.submitApplication` | ❌ | Same — separate completeness-only path. |
| `content.closeLoop` / `content.reopenLoop` | ❌ | No new user-facing content, just state flips. (Per the gifts/open-loops plan.) |

The current `GATED_ACTIONS` set in `src/quality-gate.ts` already includes `admissions.sponsorCandidate`. **Remove it.**

## Architecture

**Single LLM call per submission. One system prompt. Three blocks composed at call time.**

### System prompt structure

```
[BLOCK 1: Legality framing — constant]
[BLOCK 2: Quality framing — constant]
[BLOCK 3: Action-specific quality bar — variable, looked up by action name]
[BLOCK 4: Verdict instructions — constant]
```

#### Block 1 — legality framing (constant)

Borrow from the current `GATE_WRAPPER`. Approximately:

> You are a content gate for a private members club platform. You must check submissions for two things: legality and quality.
>
> **Legality.** Reject submissions that solicit or facilitate clearly illegal activity — solicitation of violence against a person, child sexual abuse material, fraud, forgery, or trafficking of controlled substances. Do not reject content merely for being offensive, profane, vulgar, sexually explicit, politically extreme, or in poor taste. Do not reject for discussions about something that may be illegal somewhere (drug use, research links, opinions about laws). Only reject for *active* solicitation or facilitation of clearly illegal activity.

#### Block 2 — quality framing (constant)

> **Quality.** The club is a private members space. Members value substance over filler. Reject submissions that fail the per-action quality bar below. The goal is not to punish casual writing — it's to push back when the submission is missing information members would actually need, or so vague that no one could act on it. Be permissive on tone, voice, and length. Be strict on completeness and concreteness *as defined below*.

#### Block 3 — action-specific quality bar (variable)

Looked up by action name from a TypeScript constant map (see below). Injected as plain text.

#### Block 4 — verdict instructions (constant)

> Evaluate the following submission against both checks.
>
> - If it passes both, respond with exactly: `PASS`
> - If it solicits or facilitates illegal activity, respond with `ILLEGAL: <brief reason>`
> - If it fails the quality bar, respond with `LOW_QUALITY: <brief, specific list of what is missing or vague>`
>
> Do not be conversational. State the verdict and stop.

### Per-action quality bars

These live as a TypeScript constant map in `src/quality-gate.ts`, **not** as separate `.txt` files. Easier to grep, type-check, and refactor. The previous per-file approach was deleted; we're not bringing the file structure back, just the content.

```typescript
const ACTION_QUALITY_BARS: Record<string, string> = {
  'content.create': /* see content rules below */,
  'content.update': /* same as content.create */,
  'events.create':  /* events bar */,
  'profile.update': /* profile bar */,
  'vouches.create': /* vouches bar */,
};
```

#### `content.create` and `content.update`

The bar is per-kind. The prompt should branch on the `kind` field of the payload:

- **`post`** — must have a body with a clear point or takeaway. Reject empty titles or single-sentence bodies that say nothing specific.
- **`opportunity`** — must include what the role/opportunity is, who it's for, and how to engage (apply, DM, link). Reject if any of these is missing.
- **`service`** — must describe what is offered and who it's for. Reject vague placeholders ("I do consulting"). Compensation/budget should be mentioned or the post should make clear it's negotiable or voluntary.
- **`ask`** — must state what is needed and enough context for someone to know if they can help.
- **`gift`** — **lenient bar.** Must say what the gift is in a sentence or two, in concrete terms. That's it. No "who it's for," no "how to engage," no "examples." Owen's reasoning: *"Most members will struggle to think of even one, and forcing more produces filler."* (See `docs/gifts_and_open_loops_implementation_plan.md` for the wider context — gifts are free offerings, distinct from paid services.) The gift bar should explicitly say *"a single concrete sentence is enough; do not require examples, target audience, or call-to-action."*

Crib heavily from `git show 21fced3 -- src/prompts/entities-create.txt` for posts/opportunities/services/asks. The original `entities-create.txt` is a good template — but **gifts didn't exist yet**, so you're authoring the gift clause from scratch.

#### `events.create`

Crib from `git show 21fced3 -- src/prompts/events-create.txt`. The bar is essentially:

> An event must have a title, a start time, and enough description (summary or body) for someone to decide whether to attend. Reject if any of these is missing. If the time is given without a timezone and the event location is ambiguous about which timezone applies, reject and ask for the timezone.

Note: schema-level required fields (e.g. `title`, `startsAt`) are already enforced by Zod and will fail with `400 invalid_input` long before the gate runs. The events quality bar's job is the **semantic** layer — does the description actually tell a member whether to come.

#### `profile.update`

Crib from `git show 21fced3 -- src/prompts/profile-update.txt`. The bar is:

> Reject free-text fields (`tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`) that are generic filler — phrases like "experienced professional," "passionate about excellence," "results-driven leader." Push back and ask the member to be concrete about what they actually do or are known for. A short concrete sentence is fine; vague-but-long is not.

Important: only check fields that the update payload **changes**. A profile update might only touch one field; the gate should only assess that one.

#### `vouches.create`

Crib from `git show 21fced3 -- src/prompts/vouches-create.txt`. The bar is:

> A vouch must contain firsthand, observable evidence — something the voucher personally witnessed or experienced. Reject vague praise ("great person," "highly recommend," "super talented") and ask for a specific example or interaction.

### Response parsing

`parseGateResponse` in `src/quality-gate.ts` currently handles `PASS`, `ILLEGAL: <reason>`, and a fallback `rejected` for anything else. It needs a new branch for `LOW_QUALITY: <reason>`.

```typescript
type ParsedGateResponse =
  | { status: 'passed' }
  | { status: 'rejected_illegal'; feedback: string }
  | { status: 'rejected_quality'; feedback: string }   // NEW
  | { status: 'rejected'; feedback: string };          // fallback for malformed LLM output
```

Match `LOW_QUALITY:` (or `LOW_QUALITY` followed by separator, mirroring the existing `ILLEGAL_RE` regex pattern). The parser should be liberal in matching the prefix (case-insensitive, allow `:`, `-`, `—`, `;` separators) because LLMs vary slightly.

### Error code

Add `low_quality_content` (422) as a new error code. The dispatch sites at `src/dispatch.ts:320` and `:389` currently translate `'rejected'` → `gate_rejected (422)` and `'rejected_illegal'` → `illegal_content (422)`. Add a third branch for `'rejected_quality'` → `low_quality_content (422)`.

The error envelope should include the LLM's `feedback` text in the `message` field so the agent can show the user *why* the submission was rejected and what to fix.

`gate_rejected` stays as the LLM-disobeyed-the-prompt fallback (when the LLM returns something that's neither PASS, ILLEGAL, nor LOW_QUALITY). Do not repurpose it.

### What `runAdmissionGate` does and why you don't touch it

`runAdmissionGate` (also in `src/quality-gate.ts`) is a **completely separate** function with its own system prompt (`ADMISSION_GATE_SYSTEM`). It's only called from the cold and cross-club admission paths in `src/clubs/admissions.ts`. It checks **completeness only** — whether the applicant answered every explicit question in the club's admission policy. It is not about quality or legality.

This function exists because admission applications are a different problem space:

- The application text is private — only the club admin sees it, never published.
- The only thing that matters is whether the applicant answered the policy's explicit questions.
- Vague-but-friendly content can legitimately pass when the policy is vague.

**Do not touch `runAdmissionGate`. Do not touch `ADMISSION_GATE_SYSTEM`. Do not call `runAdmissionGate` from any new code path. Do not call `runQualityGate` from any admission path.**

## Files to touch

### `src/quality-gate.ts`

- Remove `admissions.sponsorCandidate` from `GATED_ACTIONS`.
- Replace `GATE_WRAPPER` with the new combined system prompt template (blocks 1, 2, 4 from the architecture above; block 3 is injected at call time).
- Add an `ACTION_QUALITY_BARS` constant map keyed by action name.
- Update `runQualityGate()` to compose the system prompt with the action-specific bar at call time. Pass the **action name** through to the prompt builder so the per-kind quality clauses for `content.create`/`content.update` know which kind they're checking.
- Extend `parseGateResponse` to recognize `LOW_QUALITY:` and return a new `'rejected_quality'` status.
- Extend the `QualityGateResult` union with `{ status: 'rejected_quality'; feedback: string; usage: LlmUsage }`.

### `src/dispatch.ts`

- At sites `:320` and `:389`, add a new branch for `'rejected_quality'` that throws `AppError(422, 'low_quality_content', gate.feedback)`.
- Leave the existing `'rejected_illegal'` and `'rejected'` branches alone.

### `src/contract.ts` (or wherever app error codes are catalogued)

- Add `low_quality_content` to the error code list. If error codes are typed via a union, extend the union. If they're listed in the `transportErrorCodes` block of `src/schema-endpoint.ts:139` — they're not, those are transport-layer codes only. Action-level error codes are documented per-action in the schema descriptions, not in a central manifest.

### `src/schemas/entities.ts`, `events.ts`, `profile.ts`, `vouches.ts`

- The action `description` strings on these gated actions should be tightened to mention the new quality bar. Approximately: *"...subject to the legality + quality gate. The gate rejects illegal content and content that fails the per-action quality bar (see `low_quality_content` error code)."* Don't go overboard; one sentence per action.
- Field descriptions can stay as-is unless they explicitly contradict the new bar.

### `test/integration/quality-gate.test.ts`

This is the biggest test surface and the one that will need the most attention. **Currently this file actively asserts that low-quality content passes** (post with no body, vague opportunity, generic filler tagline, vague vouch reason). All of those assertions need to **invert**.

Required changes:

1. **Existing "low quality passes" assertions become "low quality fails with `low_quality_content`."** Specifically:
   - Empty post body → reject
   - Single-sentence vague opportunity ("I do consulting") → reject
   - Vague service listing → reject
   - Generic filler tagline ("experienced professional, passionate about excellence") → reject
   - Vague vouch reason ("great person, highly recommend") → reject
2. **Add new "high quality passes" cases** for each action so we lock in the positive direction:
   - Concrete post with a clear takeaway → pass
   - Opportunity with what/who/how → pass
   - Specific service listing with audience and engagement → pass
   - Profile update with concrete factual fields → pass
   - Vouch with firsthand observable evidence → pass
3. **Add `gift`-specific cases**: a one-sentence concrete gift like *"Code review for early-stage engineering teams — DM me"* should **pass** under the lenient bar. A vague placeholder like *"things"* should still fail. The point of the gift cases is to lock in the lenient threshold so future tightening doesn't accidentally over-fit.
4. **Legality cases must still pass legality and quality**: e.g. legal-and-substantive content passes; legal-but-vague content fails on quality; illegal-but-substantive fails on illegality. Cover all four cells of the legality × quality matrix.
5. **Sponsor case**: assert `admissions.sponsorCandidate` no longer goes through `runQualityGate` — it should succeed regardless of vagueness in the sponsor's reason. (Or, more cleanly: assert that sponsoring with a vague reason returns success, not a `low_quality_content` error.)
6. **DM case**: assert `messages.send` continues to bypass gating entirely — vague, generic, even legitimately illegal-looking content goes through unchanged. (Don't put actual illegal content in tests; just demonstrate the gate isn't called.)

These tests cost real money — they hit the LLM. Be deliberate about test count. Aim for ~12-18 cases total across the file, not 50.

### `test/app.test.ts`

The unit-test-layer test at `:3318` ("gated actions fail with 422 gate_rejected when the gate returns a non-PASS non-ILLEGAL response") tests the LLM-disobeyed-prompt fallback. That test should **continue to work** — `gate_rejected` is unchanged. But add a parallel unit test for the new `low_quality_content` translation: when the gate returns a `'rejected_quality'` status, the dispatch layer should translate it to `low_quality_content (422)`.

### `SKILL.md`

Two sections need updating:

1. **The "Legality gate" section** (around line 394, post-cold-apply-PR — verify line numbers haven't drifted before editing). Rename the section header to **"Quality + legality gate (server-enforced)"**. Document:
   - What gets checked: legality (always) + quality (per action, see bars below).
   - The gated set, with the explicit removal of `admissions.sponsorCandidate` and the reminder that DMs and admissions are **separate paths** (DMs bypass everything; admissions go through the completeness gate at `runAdmissionGate`).
   - The new `low_quality_content` (422) error code, with guidance: *"the response includes a feedback string with what's missing — surface it to the user and ask for the missing details before resubmitting."*
   - Tighten the existing `gate_unavailable` guidance to mention it now covers both checks (one outage = no gate verdict).
2. **The "When To Clarify First" section** is no longer the canonical playbook for the quality gate — the *server now enforces it*, so the agent's job is shifted. But the patterns are still useful as **proactive** guidance: pushing back before the call avoids the round-trip cost and the user-visible rejection. Add a one-line note in `When To Clarify First`: *"These patterns are also enforced server-side via the Quality + legality gate. Catching issues here saves the LLM round-trip."*

Also fix the now-stale **agent-side quality gate** section if it was added in any earlier PR. (As of this writing, the cold-apply PR did **not** add a separate "Quality gate (agent-enforced)" section because we paused that work pending this plan. Verify the current state of `SKILL.md` first.)

### `docs/design-decisions.md`

Line ~240 currently says *"the gate is a legality boundary, not a quality suggestion."* That's now wrong. Update to reflect the combined model. Approximately:

> The server gate enforces both legality (illegal content blocked) and per-action quality (incomplete or vague content rejected with a specific feedback string). The two checks share a single LLM call to keep cost predictable. Admissions go through a separate completeness-only gate (`runAdmissionGate`) that does not enforce quality or legality. DMs bypass all gating.

### `test/snapshots/api-schema.json`

Will need regeneration only if any action `description` strings changed. Run `node --experimental-strip-types scripts/regen-schema-snapshot.ts` after the schema edits.

## Test strategy

### Unit tests

- `parseGateResponse` should be tested with `PASS`, `ILLEGAL: ...`, `LOW_QUALITY: ...`, and various malformed inputs (mixed case, alternative separators, leading/trailing whitespace). Lock in the parser's tolerance.
- The dispatch translation from `'rejected_quality'` → `low_quality_content (422)` should have a unit test parallel to the existing `gate_rejected` one in `test/app.test.ts`.

### Integration tests

`test/integration/quality-gate.test.ts` — see the file-by-file section above. This is the load-bearing test for the new behavior.

### What to NOT test

- Don't test `messages.send` with malicious payloads to prove gating is off — that just adds noise. One assertion that DMs go through the dispatch unaffected by the gate is enough.
- Don't test the admission completeness gate from this file — that's `test/integration/admissions-self.test.ts` and `test/integration/cross-apply.test.ts`. They are separate suites and should not be touched by this plan.
- Don't add tests that assert the *exact wording* of the LLM's `feedback` field. LLM output varies. Assert that a `feedback` field exists and is non-empty for rejection cases.

## Validation

After all the code lands and tests pass, run a fresh-eyes validation experiment mirroring the one done for the cold-apply PR:

1. Start the local dev server with `OPENAI_API_KEY` loaded (the dev server does **not** auto-load `.env.local`; you have to `set -a && . ./.env.local && set +a` before `npm run api:start` — or set up `.env`. The cold-apply validation hit a `gate_unavailable` cliff because of this — leave a note in the operator docs).
2. Spawn a fresh general-purpose subagent with no repo context. Give it only the local URL and a task: *"create an opportunity in DogClub. Here's the rough idea: 'Looking for someone.'"*
3. Watch whether it: (a) catches the vagueness via the When-To-Clarify-First patterns and asks the user for details before calling the action, or (b) submits anyway and gets back a `low_quality_content (422)` with feedback, or (c) misreads the situation entirely.
4. Repeat for: a profile update with generic filler, a vouch with vague praise, a gift with a one-sentence concrete description (should pass on the lenient bar), and an event with no start time (should be schema-rejected first, gate never called).

The validation succeeds if the agent (a) routinely catches issues client-side and (b) recovers gracefully from `low_quality_content` rejections by asking the user for the missing details.

## Open questions for Owen

These are decisions the implementer should NOT make alone:

1. **Should the quality bar adapt to club summary?** Some clubs are formal, some are casual. The current plan uses a uniform bar. A future enhancement could inject a club-specific tone hint into the system prompt. Probably out of scope for v1.
2. **Should `low_quality_content` rejections include a structured `missingItems` array, or just freeform `feedback` text?** Freeform is faster to ship. Structured is more useful to agents. Owen has previously deferred this kind of API ergonomic improvement until after docs/skill changes prove insufficient. Default: freeform for v1.
3. **Should the gift quality bar take the club summary into account?** A "code review" gift is concrete in a tech club but vague in a spiritual club. Probably no — keep gifts maximally permissive. If someone offers a vague gift in the wrong club, the matching engine will sort it out.
4. **Telemetry.** Should the implementation log quality rejections separately from legality rejections so we can observe the rate? Existing `ai_llm_usage_log` already records `gate_status` — extend to differentiate `'rejected_illegal'` from `'rejected_quality'`. Probably yes, but verify with Owen.

## Suggested execution order

Each step should be a clean, reviewable diff. Ship them as one PR with a clear commit-by-commit story, not as a single monolithic blob.

1. `src/quality-gate.ts` — add the new prompt structure, `ACTION_QUALITY_BARS` map, and `parseGateResponse` extension. Drop `admissions.sponsorCandidate` from `GATED_ACTIONS`. Type-check.
2. `src/dispatch.ts` — add the `'rejected_quality'` translation to `low_quality_content`. Type-check.
3. `test/app.test.ts` — add the parallel unit test for the dispatch translation. Run `npm run test:unit`.
4. `test/integration/quality-gate.test.ts` — invert the existing low-quality assertions, add new positive cases, add gift cases, add DM bypass case, add sponsor bypass case. Run `npm run test:integration:with-llm` (this costs real money, run it once when you're confident).
5. `src/schemas/*.ts` — tighten action descriptions for the gated actions. Regenerate snapshot.
6. `SKILL.md` — replace the "Legality gate" section with the combined "Quality + legality gate" section. Update `When To Clarify First` cross-reference.
7. `docs/design-decisions.md` — update line ~240.
8. Bump `package.json` patch version. Commit.
9. Run the validation experiment. If it fails in predictable ways, that informs a follow-up; do not block on perfection.

## Non-goals

Things that are explicitly **not** part of this work:

- Renaming `runQualityGate` (the function name was always misleading; it'll keep being misleading until a separate housekeeping PR).
- Touching `runAdmissionGate` or anything in the cold/cross admission flow.
- Touching DM gating (DMs stay un-gated).
- Adding a structured `missingItems` API response shape (deferred — see Open questions).
- Adding club-tone-aware quality bars (deferred — see Open questions).
- Reviving the deleted `src/prompts/*.txt` file structure (the per-action bars live as inline TypeScript constants now).
- Adding quality enforcement to `closeLoop` / `reopenLoop` (no new content).
- Adding quality enforcement to `admissions.sponsorCandidate` (Owen's call: a sponsor doesn't know what the candidate brings, gating their reason is unfair).

## Reference: where the deleted prompts live

```
git show 21fced3 -- src/prompts/entities-create.txt
git show 21fced3 -- src/prompts/events-create.txt
git show 21fced3 -- src/prompts/profile-update.txt
git show 21fced3 -- src/prompts/vouches-create.txt
git show 21fced3 -- src/prompts/admissions-sponsor.txt   # do not revive — sponsorCandidate is now ungated
git show 21fced3 -- src/prompts/messages-send.txt        # do not revive — DMs stay ungated
```

The first four are the starting material for the new `ACTION_QUALITY_BARS` constants. The last two are explicitly **not** to be revived.

## Reference: cold-apply PR context

The agent picking this up should also read the cold-apply admission tightening that just shipped (commits `ff22051` v0.2.7 and `9352cb2` v0.2.9). That PR consolidated the cold/cross admission playbook in `SKILL.md`, tightened admission schema descriptions, generalized the PoW solver, added a `scripts/regen-schema-snapshot.ts` helper, and fixed two doc gaps surfaced by a fresh-eyes validation experiment. None of that work conflicts with this plan, but knowing the structure of the consolidated `SKILL.md` will help when editing the legality-gate section.
