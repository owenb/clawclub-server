# Plan: Generated Behavior Metadata and a Thinner SKILL

## Context for the reviewing agent

This plan is intentionally additive first.

- Preserve the existing `/api/schema` contract and add new fields rather than replacing current ones in the first pass.
- Do not delete large parts of `SKILL.md` until the generated schema is already carrying the replacement guidance.
- The goal is not "less documentation". The goal is "less duplicated hand-maintained server truth".
- We are not trying to encode all conversational style into the API schema. Some guidance belongs in the skill because it is client behavior, not server behavior.

## Recommendation in one sentence

Make `/api/schema` authoritative for server-truth behavioral guidance through structured metadata owned by the action registry, then reduce `SKILL.md` to bootstrap instructions and client-side interaction posture.

## Problem

Today the system splits agent guidance across two different sources:

- the generated schema owns the wire contract: transport, auth, input fields, output shapes, and some field descriptions
- `SKILL.md` owns action menus, non-obvious behavior, retry rules, routing hints, and many workflow details

That split is brittle for three reasons.

### 1. The hand-maintained skill duplicates server truth

Sections like "Available actions", "Common surprises", "`clubId` behavior", "How someone joins a club", and "When To Clarify First" in `SKILL.md` restate facts that are really properties of the API, not properties of a specific client.

Examples:

- DMs are not club-scoped
- `clubadmin.*` actions require explicit `clubId`
- `clientKey` has global per-member scope
- `needs_revision` means the PoW already passed
- `gate_unavailable` has a specific retry policy for admissions

Those are server-authoritative behaviors. Keeping them in a hand-maintained markdown file means they can drift from the implementation.

### 2. The generated schema already proves that behavior can live there

Admissions already carry substantial guidance inside generated action and field descriptions:

- challenge responses describe how `difficulty` and `expiresAt` should be interpreted
- submit actions describe the literal completeness gate
- `feedback` and `attemptsRemaining` describe retry semantics

That is the right direction. The problem is that the public metadata surface is still too small and too prose-heavy.

### 3. Long descriptions are not enough

`src/schemas/registry.ts` currently exposes only:

- `description`
- `auth`
- `safety`
- `authorizationNote`
- `input`
- `output`

That is enough for "what this action is", but not enough for:

- when to choose this action over another one
- what must be clarified before calling it
- what common mistakes to avoid
- what action-level business errors exist
- what the retry or recovery policy is
- what workflow this action participates in

Trying to solve that by making `description` longer just turns the schema into another wall of prose. The schema needs structured behavior metadata, not only richer sentences.

## Why this design

### Server-truth guidance should live next to action definitions

If a fact is implemented in code and should be true for every client, it should be owned by the registry or schema builder rather than by `SKILL.md`.

That means:

- action selection hints that come from actual product semantics
- scope rules
- idempotency semantics
- gating behavior
- business errors and recovery
- cross-action workflows

Putting this metadata beside the action definitions makes updates local. When an action changes, its schema and its behavioral contract change in one place.

### A thinner skill reduces drift

The current skill contains an action inventory and behavior notes that are easy to forget when action surfaces change.

During review, the local checkout and the deployed schema were not perfectly aligned on the event/content action surface. Whether that specific mismatch is temporary or intentional is less important than the lesson: duplicating action-level truth in a hand-maintained skill creates drift pressure immediately.

The best guardrail is to stop duplicating what the server can generate.

### Structured metadata is better than a prose dump

Agents need to do more than read. They need to route intent, ask clarifying questions, recover from business errors, and choose follow-up actions. That works much better when the schema exposes arrays and objects like:

- `clarifyBeforeCall`
- `whenNotToUse`
- `businessErrors`
- `scopeRules`
- `workflowRefs`

instead of hiding all of that inside paragraph text.

### The admissions flow is the template

Admissions already show the correct pattern:

- short action descriptions
- field-level descriptions for important semantics
- output descriptions that explain what statuses mean

The next step is to make that style systematic and structured across the whole schema.

### The skill still has a real job

We should not try to delete `SKILL.md` completely.

Some guidance is still client-side:

- how to configure base URL and bearer token
- "treat conversation as the interface"
- brevity and response style
- privacy posture when the server does not strictly enforce presentation choices
- how to use club summaries for tone

That guidance belongs to the client skill, not the API contract.

## Durable design calls

These are the design decisions this plan makes. The implementer should not reopen them casually.

1. `SKILL.md` remains, but becomes materially thinner.
2. `/api/schema` becomes the authoritative source for server-truth behavioral guidance.
3. The first implementation pass is additive and backward-compatible for schema consumers.
4. `description` remains a short summary, not the main container for guidance.
5. Structured action metadata lives in the registry, not in a separate manually maintained markdown file.
6. Cross-action rules that apply to many actions live in top-level schema guidance, not repeated on every action.
7. Internal quality gate prompt text is not exposed directly. Public guidance should be distilled and stable.
8. The schema should expose business errors and recovery hints where they are part of the public contract.
9. `SKILL.md` should stop enumerating large action menus and detailed workflow rules once the schema carries them.
10. If a fact is server-authoritative and duplicated in both places, the schema wins and the skill should be trimmed.

## What moves to schema vs what stays in the skill

### Move to generated schema

- action inventory and action purpose
- non-obvious action semantics
- scope rules
- idempotency behavior
- action-level business errors and recovery rules
- workflow steps that reflect actual server behavior
- gating and validation expectations
- routing hints like "use `messages.send`, not `content.create`, for private 1:1 communication"

### Keep in `SKILL.md`

- bootstrap: configure base URL and bearer token
- "fetch schema first" as a client workflow requirement
- conversation style and response style
- high-level privacy posture
- club-tone usage guidance
- general client philosophy like "never expose raw CRUD to the human"

## Proposed public metadata model

The current `ActionDefinition` type in `src/schemas/registry.ts` should gain a new public metadata field instead of overloading `description`.

### Action-level guidance

Add a new type in `src/schemas/registry.ts`:

```ts
export type SchemaClarificationRule = {
  condition: string;
  ask: string;
  required?: boolean;
};

export type SchemaBusinessError = {
  code: string;
  status?: number;
  meaning: string;
  recovery: string;
  retryable?: boolean;
};

export type SchemaIdempotencyHint = {
  supported: boolean;
  keyField?: string;
  scope?: string;
  replayBehavior?: string;
  conflictCode?: string;
};

export type SchemaGateHint = {
  kind: 'legality' | 'quality' | 'admission_completeness';
  note: string;
  failureCodes: string[];
};

export type ActionGuidance = {
  whenToUse?: string[];
  whenNotToUse?: string[];
  clarifyBeforeCall?: SchemaClarificationRule[];
  pitfalls?: string[];
  scopeRules?: string[];
  relatedActions?: string[];
  workflowRefs?: string[];
  followUpActions?: string[];
  outputNotes?: string[];
  idempotency?: SchemaIdempotencyHint;
  businessErrors?: SchemaBusinessError[];
  gates?: SchemaGateHint[];
};
```

Then extend `ActionDefinition` with:

```ts
guidance?: ActionGuidance;
```

And extend the schema endpoint output so each action can include:

```json
{
  "action": "messages.send",
  "description": "...",
  "guidance": {
    "whenToUse": ["Private member-to-member communication."],
    "whenNotToUse": ["Club-wide public posts."],
    "clarifyBeforeCall": [
      {
        "condition": "The content could plausibly be either public or private.",
        "ask": "Did you want to post this publicly to the club, or send it as a private message?",
        "required": true
      }
    ],
    "scopeRules": [
      "DMs are not club-scoped.",
      "Do not ask the user to pick a club before calling messages.send."
    ]
  }
}
```

### Top-level guidance

Add a new top-level object to `/api/schema`, for example `guidance`:

```ts
export type SchemaInvariant = {
  id: string;
  statement: string;
  actions?: string[];
};

export type SchemaWorkflowStep = {
  step: number;
  instruction: string;
  action?: string;
};

export type SchemaWorkflow = {
  id: string;
  title: string;
  summary: string;
  appliesTo: string[];
  steps: SchemaWorkflowStep[];
  failureModes?: SchemaBusinessError[];
};

export type SchemaGuidance = {
  bootstrap: {
    schemaFirst: string;
    nextAuthenticatedCall: string;
  };
  invariants: SchemaInvariant[];
  workflows: SchemaWorkflow[];
};
```

This top-level guidance should hold things that span many actions:

- bootstrap flow
- "resolve club IDs from `session.getContext`"
- "DMs are not club-scoped"
- "shared club is only an eligibility check for thread creation"
- admissions self-apply workflow
- member-sponsored admissions workflow

### Field-level hints

Field-level semantics already live in Zod `.describe(...)`, which should continue.

If additional structure is needed later, add vendor-style extensions to generated JSON Schema rather than trying to parse meaning back out of prose. Example:

```json
{
  "challengeId": {
    "type": "string",
    "description": "Challenge ID from admissions.public.requestChallenge",
    "x-clawclub": {
      "role": "challenge_id",
      "workflow": "admissions.self_apply"
    }
  }
}
```

Do not make field-level extensions phase 1 unless they solve a concrete gap. Action-level and top-level guidance will provide most of the value.

## What to populate first

The first pass should focus on the highest-value domains.

### Phase 1 domains

- `session.getContext`
- `messages.*`
- `content.*`
- `events.*`
- `admissions.public.*`
- `admissions.crossClub.*`
- `admissions.sponsorCandidate`
- `vouches.*`
- `profile.update`
- `updates.*`
- `quotas.getUsage`
- `clubadmin.*` actions with important scope constraints

### Phase 1 top-level workflows

- `bootstrap.authenticated_session`
- `admissions.self_apply`
- `admissions.member_sponsored`
- `messaging.private_vs_public_routing`

## Mapping current skill sections into the new schema

### Sections to remove or heavily shrink from `SKILL.md`

- "Available actions"
- "Common surprises"
- "Resolving club IDs"
- "`clubId` behavior"
- "Self-applied admissions"
- "Search and discovery"
- "Default quotas"
- most of "How someone joins a club"
- most of "When To Clarify First"
- most of "Legality gate"

### Where those sections move

- action menu -> generated `actions[]`
- common surprises -> `guidance.pitfalls` or top-level `guidance.invariants`
- `clubId` rules -> `guidance.scopeRules`
- admissions playbook -> top-level `guidance.workflows`
- quota notes -> `quotas.getUsage.guidance` and relevant write-action business errors
- clarify-first rules -> `guidance.clarifyBeforeCall`
- legality gate summary -> `guidance.gates` plus `businessErrors`

### What the thinner skill should look like afterward

The post-change skill should mostly do four things:

1. explain how to connect
2. insist on fetching `/api/schema` first
3. explain the client's conversation and privacy posture
4. point the agent to the generated schema for action-level behavior

## Detailed implementation plan

### 1. Add public guidance types to the registry

Files:

- `src/schemas/registry.ts`

Work:

- add `ActionGuidance` and supporting types
- extend `ActionDefinition` with `guidance?: ActionGuidance`
- keep this field in the "public metadata" section of the type

Why:

- action definitions are already the single source of truth for public action metadata
- adding another manual registry just moves the duplication problem somewhere else

### 2. Add top-level schema guidance source

Files:

- new `src/schemas/guidance.ts`
- `src/schema-endpoint.ts`

Work:

- create a typed module that exports top-level `SchemaGuidance`
- keep cross-action invariants and workflow definitions there
- import it in `src/schema-endpoint.ts`
- expose it as a new top-level `guidance` field
- include it in `schemaHash` computation

Why:

- top-level guidance should be generated and versioned just like actions
- keeping it outside `schema-endpoint.ts` avoids turning the endpoint builder into a huge blob

### 3. Extend schema endpoint output shape

Files:

- `src/schema-endpoint.ts`

Work:

- extend `SchemaAction` with `guidance?: ActionGuidance`
- include `def.guidance` when building `actions[]`
- include top-level `guidance`
- keep deterministic key sorting
- ensure `schemaHash` changes whenever guidance changes

Why:

- the whole point is to make behavior metadata part of the generated contract

### 4. Populate action guidance in schema modules

Files:

- `src/schemas/session.ts`
- `src/schemas/messages.ts`
- `src/schemas/entities.ts`
- `src/schemas/events.ts`
- `src/schemas/membership.ts`
- `src/schemas/profile.ts`
- `src/schemas/updates.ts`
- `src/schemas/clubadmin.ts`
- any other modules with meaningful constraints

Work:

- add `guidance` blocks to high-value actions
- keep `description` short
- move action-specific behavior out of free-form skill prose and into structured fields

Concrete examples:

- `messages.send`
  - `whenToUse`: private 1:1 communication
  - `whenNotToUse`: public club posts
  - `clarifyBeforeCall`: ambiguous public-vs-private intent
  - `scopeRules`: no `clubId`, shared-club rule is only an eligibility check

- `content.create`
  - `clarifyBeforeCall`: ambiguous DM vs public post, vague content
  - `pitfalls`: publish-now not draft-save, avoid generic filler
  - `relatedActions`: `messages.send`
  - `businessErrors`: `quota_exceeded`, `illegal_content`, `gate_unavailable`

- `vouches.create`
  - `pitfalls`: cannot self-vouch, reason should be firsthand and specific
  - `businessErrors`: `self_vouch`, `duplicate_vouch`, `gate_unavailable`

- `admissions.public.submitApplication`
  - `businessErrors`: `needs_revision`, `attempts_exhausted`, `challenge_expired`, `invalid_proof`, `challenge_consumed`, `gate_unavailable`
  - `outputNotes`: accepted message should be relayed verbatim
  - `workflowRefs`: `admissions.self_apply`

### 5. Distill internal gate expectations into public hints

Files:

- `src/schemas/membership.ts`
- `src/schemas/profile.ts`
- `src/schemas/entities.ts`
- `src/schema-endpoint.ts`
- optionally `src/schemas/guidance.ts`

Work:

- expose public, stable gate hints through `guidance.gates` and `businessErrors`
- do not expose raw internal prompt files verbatim
- for sponsorships and vouches, encode the public expectation that reasons should be concrete and firsthand

Why:

- agents need to know the behavior contract
- they do not need the exact private prompt wording

### 6. Rewrite `SKILL.md` after the schema is ready

Files:

- `SKILL.md`

Work:

- remove or shrink duplicated server-truth sections
- replace long action inventories with short pointers to `/api/schema`
- keep bootstrap, interaction posture, privacy posture, and response style
- keep the instruction to fetch the schema first

Why:

- if the skill is thinned before the schema replacement exists, the docs become worse, not better

### 7. Add tests and snapshots

Files:

- `test/integration/non-llm/smoke.test.ts`
- `test/snapshots/api-schema.json`
- possibly new `test/unit/schema-guidance.test.ts`
- possibly extend `test/unit/server.test.ts`

Work:

- assert that `/api/schema` now includes top-level `guidance`
- assert that representative actions include expected `guidance` fields
- keep the full schema snapshot up to date
- add targeted regression tests for high-value guidance, for example:
  - `messages.send` exposes non-club-scoped routing guidance
  - admissions submit actions expose `needs_revision` recovery guidance
  - `content.create` exposes DM-vs-public clarification rules

Why:

- once behavior guidance becomes part of the contract, it deserves the same snapshot protection as field schemas

### 8. Add one consistency guardrail for the skill

Recommended but optional:

- add a test that scans `SKILL.md` for backticked action names and verifies they exist in the generated schema
- or, better, reduce action-name density in `SKILL.md` enough that this is no longer necessary

Why:

- this is a cheap way to catch future drift while the skill still mentions concrete actions

## Proposed file changes

Core implementation:

- `src/schemas/registry.ts`
- new `src/schemas/guidance.ts`
- `src/schema-endpoint.ts`
- selected action modules in `src/schemas/`
- `SKILL.md`

Verification:

- `test/integration/non-llm/smoke.test.ts`
- `test/snapshots/api-schema.json`
- optionally a small new unit test for top-level guidance shape

## Rollout order

1. Add guidance types and top-level guidance module.
2. Expose the new metadata in `/api/schema`.
3. Populate the highest-value actions and workflows.
4. Add tests and refresh the schema snapshot.
5. Thin `SKILL.md`.
6. Optionally add a small consistency guardrail for remaining action mentions in the skill.

This order matters. The generated replacement should land before the manual duplicate is removed.

## Non-goals

- replacing JSON Schema for input/output contracts
- generating the entire skill from code in the first pass
- exposing raw internal quality gate prompts
- encoding generic assistant tone or response style into the public API schema
- removing `SKILL.md` completely

## End state

After this work, the intended split should be clear:

- `/api/schema` tells an agent what the server does, how to call it, when to choose an action, what can go wrong, and how to recover
- `SKILL.md` tells an agent how to behave as a ClawClub client in conversation

That is a better architectural boundary than the current one, and it directly reduces the drift risk that comes from maintaining a fat manual skill beside a generated schema.
