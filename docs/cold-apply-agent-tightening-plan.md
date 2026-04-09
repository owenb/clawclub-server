# Cold Apply Agent Tightening Plan

## Goal

Make the cold-apply flow easier for general-purpose agents to execute correctly on the first try, with the fewest possible backend changes. The main gap today is not that the API is missing core data; it is that the current agent guidance does not teach agents how to use the data the server already returns.

This document is intended as a handoff brief for another agent before any edits are made.

## Trigger For This Plan

An external agent successfully completed a cold application, but only after one failed submission:

- First try returned `needs_revision` because it submitted a generic paragraph instead of directly answering the club's explicit admission questions.
- Second try succeeded once the application answered the questions directly.
- The agent noticed `expiresAt` in the challenge response, but said the current skill does not tell agents to surface it or act on it.
- The agent also called out missing guidance for progress updates during PoW and for handling `needs_revision`.

Those observations are credible and they match the codebase.

## What The Code Already Does

### Challenge data already exposed to the client

`admissions.public.requestChallenge` already returns:

- `challengeId`
- `difficulty`
- `expiresAt`
- `maxAttempts`
- `club.slug`
- `club.name`
- `club.summary`
- `club.ownerName`
- `club.admissionPolicy`

References:

- `src/schemas/responses.ts:129-135`
- `src/contract.ts:161-167`

### The challenge lifetime is one hour from challenge creation

The cold challenge TTL is currently:

- `COLD_APPLICATION_CHALLENGE_TTL_MS = 60 * 60 * 1000`

References:

- `src/clubs/admissions.ts:16-19`
- `src/clubs/admissions.ts:213-217`

Important semantic detail:

- The timer starts when `requestChallenge` creates the challenge.
- There is no separate "time between solving the puzzle and resubmitting".
- The server simply checks whether the challenge has expired when `submitApplication` runs.

References:

- `src/clubs/admissions.ts:260-264`
- `src/clubs/admissions.ts:311-314`

### The user gets five total submissions per challenge

The server enforces five attempts per challenge.

References:

- `src/clubs/admissions.ts:19`
- `db/init.sql:784`

### The admission gate is a completeness gate, not a fit or quality gate

The admission-specific gate is explicitly instructed to check only whether the applicant provided every piece of information the admission policy explicitly asks for.

This means the external agent's failure mode was expected:

- a generic paragraph can fail
- a direct answer to each explicit question should pass

References:

- `src/quality-gate.ts:80-93`

### `needs_revision` already carries the right retry signals

The cold submit result can return:

- `accepted`
- `needs_revision` with `feedback` and `attemptsRemaining`
- `attempts_exhausted`

References:

- `src/schemas/responses.ts:137-151`
- `test/cold-applications.test.ts:184-205`

### The challenge survives `needs_revision`

The challenge is deleted on:

- expiration
- attempt exhaustion
- successful admission creation

It is not deleted on `needs_revision`, so the same challenge remains usable while still valid.

References:

- `src/clubs/admissions.ts:260-264`
- `src/clubs/admissions.ts:280-284`
- `src/clubs/admissions.ts:365-367`
- `src/clubs/admissions.ts:390-393`

Inference from the submit path:

- because proof verification is deterministic on `challengeId` + `nonce`
- and because `needs_revision` does not consume the challenge
- a previously valid nonce should remain reusable for the same live challenge

This is useful agent guidance even though it is not stated anywhere today.

### The skill currently underspecifies the flow

`SKILL.md` describes cold apply in multiple places, but does not make the critical operational details explicit enough.

Current weak spots:

- It tells agents to solve the PoW and warn the user to be patient.
- It does not tell them to surface `expiresAt`.
- It does not tell them the TTL starts at challenge creation.
- It does not tell them to turn the admission policy into a checklist.
- It does not tell them what to do on `needs_revision`.
- It repeats the flow in multiple sections, which makes drift likely.

References:

- `SKILL.md:133-145`
- `SKILL.md:196-204`
- `SKILL.md:318-325`

## Diagnosis

The external agent's recommendations are mostly correct. The core problem is not backend capability. The server already exposes the important pieces:

- exact expiry
- max attempts
- admission policy
- revision feedback

The problem is that the current skill leaves too much implied. A generic agent can follow the API shape and still fail because it is not told:

- how literal the completeness gate is
- how to manage the one-hour timer
- when to solve
- how to recover from `needs_revision`

## Tightening Plan

## 1. Create one authoritative cold-apply playbook

### Change

Replace the current repeated cold-apply guidance in `SKILL.md` with one authoritative section, then cross-reference it from any summary sections.

That section should cover:

- exact challenge fields the agent must surface
- time semantics
- order of operations
- checklist drafting
- progress updates during PoW
- retry behavior
- failure handling

### Why

The current guidance is spread across multiple sections with different levels of detail. That is fragile. Any future change to TTL, difficulty, or retry semantics can drift across those copies.

### Trigger from agent report

The external agent had enough information to finish the flow, but not enough guidance to avoid a preventable first failure. That is exactly the kind of gap a canonical playbook should remove.

## 2. Make challenge timing explicit and operational

### Change

Require agents to surface these values immediately after `admissions.public.requestChallenge`:

- `difficulty`
- `expiresAt`
- `maxAttempts`

Explicitly state in the skill:

- the challenge expires one hour after creation
- the countdown starts when the challenge is issued, not when the puzzle is solved
- there is no separate post-solve resubmission window
- the agent should mention remaining time if PoW solving takes longer than about 30 to 60 seconds

Also instruct the agent to restart with a fresh challenge if the remaining time is too low to retry safely.

### Why

This directly addresses the user's confusion about "how long after solving the puzzle" and the external agent's note that expiry is only surfaced indirectly today.

### Trigger from agent report

The agent explicitly asked for better expiry visibility and better time-left updates during long solves.

## 3. Teach agents to convert the admission policy into a checklist

### Change

Add explicit instruction:

- Read the club's `admissionPolicy` before drafting.
- If it contains explicit questions or required items, convert them into a checklist.
- Draft the `application` so it answers each item directly and clearly.
- Prefer a question-and-answer structure when the policy is question-shaped.
- Do not submit a generic summary paragraph if the policy asks for specific facts.

### Why

This is the most important behavior change because it aligns the skill with the actual admission gate prompt.

The code says the gate checks completeness only. A checklist-based drafting strategy is the simplest and most reliable way to satisfy that requirement.

### Trigger from agent report

The first failure happened because the agent wrote a vibes-based paragraph instead of answering the policy's five questions directly.

## 4. Tighten the order of operations

### Change

Document the preferred sequence as:

1. Request the challenge.
2. Read the admission policy in the challenge response.
3. Draft the full application against a checklist.
4. Confirm all explicit asks are answered.
5. Tell the user PoW may take time and state the expiry.
6. Solve the PoW.
7. Submit immediately after solving.

Also add one important nuance:

- solve late, not early
- drafting and revision should happen before expensive PoW work whenever possible

### Why

This minimizes both avoidable expiry risk and avoidable failed attempts.

### Trigger from agent report

The external agent suggested a similar order, and the codebase supports it. This should be made first-class guidance.

## 5. Add a real retry protocol for `needs_revision`

### Change

Add a specific retry flow for `admissions.public.submitApplication` when the result is `needs_revision`:

1. Read the server `feedback` literally.
2. Map the feedback to the admission-policy checklist.
3. Fix only the missing items.
4. Tell the user how many attempts remain.
5. If the challenge is still live, resubmit using the same challenge.
6. If the challenge expired or attempts are exhausted, request a new challenge and restart.

Recommended guidance to include:

- do not resubmit blindly
- do not ask the user to rewrite everything if the feedback identifies a small gap
- be explicit about the missing items before retrying

### Why

This is the largest omission in the current skill. Today the API already returns the information agents need for intelligent recovery, but the skill does not tell them how to use it.

### Trigger from agent report

The external agent specifically called out retry guidance as a major omission.

## 6. Add clear failure-mode handling beyond `needs_revision`

### Change

Document the next step for each relevant cold-apply failure:

- `challenge_expired`: request a fresh challenge
- `attempts_exhausted`: request a fresh challenge and start over
- `invalid_proof`: solve again; do not change the application unless there is also revision feedback
- `challenge_consumed`: treat as a concurrency collision and request a fresh challenge
- `gate_unavailable`: retry later; avoid rewriting the application because the failure is infrastructure, not completeness

One useful backend fact to surface:

- `gate_unavailable` happens before an attempt is recorded, so it should not burn one of the five allowed submissions

This follows from the submit path ordering in `src/clubs/admissions.ts:317-345`.

### Why

Agents perform better when failure handling is operational, not descriptive.

## 7. Improve schema and contract wording around existing fields

### Change

Even if the API shape stays the same, tighten the descriptions so agents reading the schema understand:

- `expiresAt` is the exact challenge expiry
- `maxAttempts` is the total allowed submissions for that challenge
- `application` must answer the admission policy, not provide a generic "why I want to join"
- `needs_revision.feedback` should be treated as the revision brief

Potential targets later:

- `src/schemas/admissions-cold.ts`
- `src/schemas/responses.ts`
- any generated schema docs or snapshots

### Why

Some agents use schema descriptions more than freeform skill text. Tight schema wording reduces ambiguity for agents that introspect the action surface directly.

## 8. Separate durable design docs from operational agent docs

### Change

Keep these cold-apply operational details in:

- `SKILL.md`
- a dedicated runbook or playbook doc for agents

Avoid overloading `docs/design-decisions.md` with implementation-specific operational instructions like:

- exact TTL values
- progress-update behavior
- retry etiquette

### Why

`docs/design-decisions.md` is supposed to hold durable product architecture decisions. The cold-apply execution details are operational guidance and may change more frequently.

## 9. Consider optional API improvements only if docs are still not enough

### Change

If stronger guidance alone does not eliminate agent confusion, consider a second pass with API ergonomics improvements such as:

- add `issuedAt` or `expiresInSeconds` to the challenge response
- return structured `missingItems` on `needs_revision` instead of only freeform feedback
- include explicit machine-readable retry guidance in error payloads

### Why

The current API is probably sufficient, so this should be lower priority. But structured retry data would make weaker agents much more reliable.

### Caution

Do not do this first. The current evidence points to a documentation and skill problem more than a transport-shape problem.

## Recommended Edit Targets For A Follow-On Agent

If another agent picks this up, the most likely file targets are:

- `SKILL.md`
- `src/schemas/admissions-cold.ts`
- `src/schemas/responses.ts`
- optionally a new dedicated operational doc under `docs/`

## Suggested Priority Order

### P0

- Consolidate cold-apply guidance into one canonical playbook in `SKILL.md`
- Add explicit timing semantics
- Add explicit checklist drafting guidance

### P1

- Add `needs_revision` retry protocol
- Add failure-mode handling guidance
- Add progress-update guidance during long PoW solves

### P2

- Tighten action descriptions and schema wording for the existing API fields
- Add a dedicated agent-facing cold-apply runbook if `SKILL.md` becomes too dense

### P3

- Re-evaluate whether any backend/API changes are still needed after docs and skill improvements land

## Validation Plan

The changes should be considered successful only if a generic external agent can complete a cold apply without repo-specific help and without making the same class of mistake.

Validation steps:

1. Hand the updated skill and schema to an agent with no repo context.
2. Ask it to cold apply to a club whose admission policy contains multiple explicit questions.
3. Verify that it:
   - surfaces `expiresAt`, `difficulty`, and `maxAttempts`
   - explains that expiry is tied to challenge creation
   - turns the policy into a checklist
   - drafts direct answers instead of generic prose
   - gives progress updates during PoW
   - handles `needs_revision` using feedback and `attemptsRemaining`
4. Only consider API changes if that agent still fails in predictable ways.

## Short Conclusion

The external agent's complaints were useful and mostly accurate. The backend already provides the important primitives, but the current skill does not teach agents how literal the completeness gate is or how to operate safely inside the challenge lifetime.

The first pass should therefore be a tightening pass on agent guidance, not a backend rewrite.
