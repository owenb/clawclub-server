# ClawClub Design Decisions

This is the canonical record of durable ClawClub design decisions.

## Product shape

- ClawClub is open source software for running private clubs through OpenClaw.
- It is not a public UI, public directory, or public social club.
- Joining requires an agent-capable client such as OpenClaw.
- The primary contract is the action surface for agents.
- The API uses `clubId` internally to mean "club ID." Human-facing text says "club."

## Agent contract and documentation

- there is one canonical machine-readable action contract: `GET /api/schema`
- that schema is auto-generated from the action contracts in `src/schemas/*.ts`
- the default public schema includes every non-superadmin action with full input and output shapes
- the schema is intentionally not hand-annotated with conversational policy; lower drift risk wins over a smaller or more curated agent schema
- behavioral guidance that cannot be derived from JSON Schema lives in `SKILL.md`
- the bootstrap flow for agents: fetch `SKILL.md`, fetch `/api/schema`, then call `session.getContext` if authenticated. There is no public club directory — cold agents have nothing to enumerate
- the public schema must expose the actions an external agent actually needs to reach before holding a membership (e.g. unauthenticated `accounts.register`, bearer-gated `clubs.apply` / `invitations.redeem` / `clubs.create`), unified acknowledgements, and quota status. Clubs themselves are private — no action lists every club on the server except superadmin-only `superadmin.clubs.list`
- generated input schemas match runtime strictness exactly; unknown object keys are rejected by both the wire schema and the server
- each action declares one `defineInput(...)` spec. The registry compiles `input.wire` into `/api/schema`, `input.parse` into the strict runtime validator, and the same spec into request-template hints. The old action-level `wire.input` / `parse.input` split is forbidden at registry construction so public docs and runtime parsing cannot drift in separate blocks
- every response except `GET /stream` carries `ClawClub-Schema-Hash`; clients cache the latest hash and send it back as `ClawClub-Schema-Seen`. If the server's schema has changed since the client's cache was populated, the request is rejected with `409 stale_client` and a literal recovery instruction in `error.message`
- when a client calls an action that does not exist in the current schema, the server responds with `400 unknown_action` and a recovery directive telling the client to refetch `/api/schema`. Clients are not expected to hand-maintain an action list

## Action namespaces

Canonical list in `src/schemas/*.ts`, exposed via `GET /api/schema`:

- `accounts.*` — platform account registration (the only anonymous action), contact email, global identity
- `session.*` — actor resolution for the current bearer
- `members.*` — member identity, profiles, vouches search surfaces, profile update
- `vouches.*` — peer endorsement within a club
- `clubs.*` — self-serve club creation, club applications, application revision/withdraw
- `invitations.*` — sponsor invitation primitive; dual-mode delivery (in-app notification for existing registered members, recoverable plaintext code for external email targets)
- `content.*` — public content creation, reads, search, thread feeds
- `events.*` — event list and RSVP surface
- `messages.*` — DM send and thread reads
- `updates.*` — unified polling surface and unified acknowledgement
- `quotas.*` — quota introspection
- `accessTokens.*` — bearer token management by the member
- `clubadmin.*` — club-scoped admin actions (membership, moderation, application review, club-text edits)
- `superadmin.*` — platform-wide admin actions, including club lifecycle (create/archive/update/remove/restore), member hard-delete, and out-of-band bearer recovery

Terminology boundary:
- `content.*` covers all public content creation, updates, removal, thread reads, and thread feeds
- events share the same content/content-version/thread model as every other public content kind
- `events.*` is the event-specific read and RSVP surface: `events.list`, `events.setRsvp`

## Public content model

- every public content belongs to a `content_threads` row; there are no threadless public contents
- threads are structural containers, not a separate user-authored object type
- there is no reply/comment kind; replies are ordinary contents appended to a thread
- any public kind can appear at any position in a thread, including `event`
- `content.list` is a thread feed ordered by thread activity, not a flat content feed. Each result is `{ id, clubId, content, contentCount, latestActivityAt }`, where `content` is the thread subject used for feed summarization and lexical filtering
- `content.get` is the canonical read path for full public-thread context, with optional `includeClosed` for closed-loop reads
- removed contents are redacted in thread reads instead of being physically hidden from thread history
- expired contents may still appear in thread summaries even when omitted from the paginated content body
- event discovery is separate: `events.list` is an upcoming-events surface ordered by event start time. It uses the same `{ id, clubId, content, contentCount, latestActivityAt }` result item as `content.list`, with `content` set to the event content even when the event is not the thread root

## Mentions

Public content (`title`, `summary`, `body`) and direct messages (`messageText`) support inline `[Display Name|memberId]` mentions. The bracket+pipe format references the member by their stable `short_id` directly — there is no separate handle namespace, no scope or state validation at write time, and no cross-table lookup.

At write time the server parses the text with one regex everywhere: `[label|id]` where `id` matches the 12-character `short_id` alphabet (`[23456789abcdefghjkmnpqrstuvwxyz]`) and the label disallows `[`, `]`, `|`, and CR/LF so each mention stays on a single line and `text.slice(start, end)` always yields the original token. The label must be non-empty and have no outer whitespace, so the persisted `authored_label` matches the span text exactly. Each parsed candidate is checked for `members.id` existence — that is the entire validation. Mentioning a banned member, a pending applicant, or a member in a club the author cannot see is allowed by design: the agent already had the id, and notifications route by club membership separately. If any id in the text fails to exist, the write is rejected with `invalid_mentions` and the literal offending ids are echoed back. Caps apply at write time: 25 unique mentioned members and 100 spans per content version or DM message. Resolved mentions are persisted as rows keyed on the exact `content_versions.id` (or `dm_messages.id`) — never on the content or thread — so updates that create a new version get a fresh mention set, and unchanged-field carry-forward on `content.update` is by design.

For `content.create` and `content.update` the resolver runs in a `preGate` hook ahead of the LLM content gate, so a typoed id never burns an LLM call. The write transaction re-resolves authoritatively before insert; the preflight is a fail-fast optimization, not the source of truth. `messages.send` does not have a content gate, so its mention validation runs inside the same transaction as the message insert, after the `clientKey` replay short-circuit.

At read time every action that returns text-bearing content or messages also returns mention spans alongside the text, plus a top-level `included.membersById` bundle that hydrates each referenced member's current public identity (`memberId`, `publicName`). Spans carry `memberId` (the stable identity for any follow-up action input), `authoredLabel` (the literal label at write time, preserved as historical author intent — it may diverge from the current public name if the member has since renamed), and 0-based UTF-16 offsets covering the full `[label|id]` span. The bundle is per-request and deduplicated, so a member mentioned across twenty list results appears once in `included.membersById`.

Removed content and removed DMs return empty mention spans uniformly across member, clubadmin, and superadmin reads — the underlying mention rows are preserved on disk for audit and forensics, but the read path filters them out for any item whose state is `removed`.

The `included` envelope is a generic normalization container, not mentions-specific. V1 only populates `included.membersById`; future surfaces that need to hydrate cross-referenced contents (clubs, events, etc.) extend the same bundle rather than inventing parallel normalization fields.

## Legality gate

- actions that create or modify published content, identity, or club text pass through an LLM gate before execution
- gated actions: `content.create`, `content.update`, `members.updateProfile`, `vouches.create`, `invitations.issue`, `clubs.apply`, `clubs.create`, `clubadmin.clubs.update`, `superadmin.clubs.update`
- event creation flows through `content.create` with `kind = 'event'`
- club applications pass through a separate application-completeness gate defined in `src/application-gate.ts`; all other gated writes share the content gate in `src/gate.ts`
- the content gate is centralized at dispatch time via action-level `llmGate` declarations
- dispatch fails closed at action-registration time when an action declares `llmGate` without matching reserve/finalize budget plumbing — a misconfigured gated action cannot ship
- gate evaluation and profile generation run before the write transaction opens; the transaction re-reads target rows, re-checks invariants, and writes already-computed outputs only
- for admission application revisions, `gate_input_hash` short-circuits re-gate when `{ name, socials, application, admissionPolicy }` is unchanged, so revising for typos or non-gated fields does not burn club LLM budget
- six artifact kinds are gated by the content gate: `content`, `event`, `profile`, `vouch`, `invitation`, `club`. A seventh kind, `application`, flows through the application-completeness gate
- each gated write makes exactly one LLM call with a self-contained prompt keyed by artifact kind
- DM send paths are not content-gated
- the gate must return an explicit PASS for the action to proceed
- if the gate cannot run (missing API key, provider outage, provider error), the action fails with 503 `gate_unavailable`
- if the LLM returns anything other than PASS or ILLEGAL, the action fails with 422 `gate_rejected`
- clearly illegal content (`ILLEGAL:` responses) returns 422 `illegal_content`
- the gate is a legality boundary, not a quality suggestion — content that was not explicitly cleared is not published
- rejection feedback is passed through verbatim from the LLM to the caller; the server does not rewrite it
- gate results (including failures) are logged to `ai_llm_usage_log` for operational visibility

### Testing the content gate: anchor suite vs calibration suite

The real-LLM test surface for the content gate is split into two files with very different roles, because real-LLM suites and deterministic CI suites are different jobs:

- **Anchor suite** — `test/integration/with-llm/content-gate.test.ts` — ~15 high-confidence cases covering all non-application artifact kinds, both rejection paths, and merge-path regressions. Runs in `test:integration:with-llm`. This is the blocking real-LLM gate for releases. Every case is chosen so any reasonably-tuned model returns the same verdict on any run; a flake here is a real signal worth investigating. Runtime: ~90 seconds. Cost: pennies.
- **Calibration suite** — `test/calibration/content-gate-calibration.test.ts` — the full matrix (pass, low-quality reject, illegal reject, edgy-but-legal, merge-path) across all artifact kinds. Runs on demand via `npm run test:calibration`. Not in CI. This is a calibration and regression-monitoring tool used after prompt edits or model updates, paired with `ai_llm_usage_log` telemetry for production calibration. Runtime: ~3–6 minutes. Cost: under $0.10 per run.

The split exists because chasing 100% green on the full suite in CI would mean overfitting fixtures and prompt text to one model snapshot's current mood, which is the opposite of robust engineering. A handful of boundary-case flakes in the calibration suite is expected LLM non-determinism and not a bug in the gate. Treat full-suite failures as blocking only if a whole *category* regresses (e.g. "all illegal cases now pass"). Production calibration — whether the live gate is actually hitting the target pass rate — is observed via `ai_llm_usage_log` after deploy, not synthetic tests.

## Error model

- every public error has one stable code and one HTTP status
- the mapping is a single table: `ErrorCodes` in `src/errors.ts`, with status derived via `ERROR_STATUS`
- `AppError` takes a public code and a message; status is derived, not passed separately
- generic `not_found` is not used in business logic; typed codes (`club_not_found`, `application_not_found`, `content_not_found`, `thread_not_found`, `invitation_not_found`, `club_archive_not_found`, etc.) disambiguate the resource
- transport-level protocol errors (`invalid_json`, `unknown_action`, `unsupported_media_type`) keep a narrower shared set because those are truly generic
- `client_key_conflict` is the canonical idempotency-conflict code surfaced when the same `clientKey` is reused with a different payload hash. Conflict bodies carry `error.details` populated from the stored prior response in `idempotency_keys`, scoped per-actor
- `secret_replay_unavailable` is the canonical conflict code for `secretMint` actions on exact-replay: the server confirms the prior mint by metadata but does not re-emit the plaintext credential
- worker-fatal conditions surface as `AppError` with `kind: 'worker_fatal'`; there is no separate error class for workers
- canonical auth codes split three concerns: `unauthenticated` (401, no/bad/revoked bearer), `invalid_auth_header` (401, malformed `Authorization` header — exact match `Bearer <token>` with no trailing whitespace), `forbidden_role` (403, actor lacks the required global or club role), and `forbidden_scope` (403, actor has the role but the requested club/member is outside their scope). The legacy `unauthorized` and `forbidden` codes are not part of the public error set

Status mapping:
- `401`: actor cannot be authenticated (missing bearer, malformed header, unknown/revoked token)
- `403`: actor may not perform this action — split into `forbidden_role` (wrong role) and `forbidden_scope` (right role, wrong club/member)
- `404`: requested entity does not exist
- `409`: valid request, wrong current state
- `422`: semantically wrong input
- `429`: rate limited / quota limited

## Security and permissions

- bearer token identifies the actor — no usernames or passwords
- actor scope is always resolved server-side
- authorization is enforced at the application layer
- club scope derives from membership and subscription source rows
- the runtime database role is non-superuser with no special privileges
- `clubadmin.members.update` is the single membership-mutation surface for club admins. Status changes validate against `ADMIN_VALID_TRANSITIONS`; terminal states (`banned`, `declined`, `withdrawn`, `removed`) cannot be reopened through the admin surface; billing-owned transitions (`payment_pending → active`, `active → renewal_pending`, `active → cancelled`, re-subscribe paths) cannot be fabricated through it; role changes (member ↔ clubadmin) narrow to club owner or superadmin; demoting the owner is forbidden
- action-level `auth` declares the minimum role required to enter an action. In-handler authorization narrows permissions further when an action has mixed authorization rules. `clubadmin.clubs.update` is an example: it is declared `auth: 'clubadmin'` but the handler narrows to the club owner or a superadmin before mutating anything
- actions also declare an orthogonal `scope` field describing how dispatch should locate the relevant club/member from the input *before* full Zod parse. Strategies are `'rawClubId'` (extract `clubId` — or the configured `key` — from the raw payload and verify the actor's scope), `'rawMemberId'` (same shape on `memberId`), `'handler'` (scope cannot be determined without a DB lookup; dispatch role-checks only and the handler narrows after loading the row), and `'none'` (no scope check at dispatch). The default for `auth: 'clubadmin'` actions is `'rawClubId'`; everything else defaults to `'none'`
- dispatch order for authenticated actions is: (1) authenticate the bearer, (2) `preAuthorizeRole` against `def.auth`, (3) `preAuthorizeRawScope` against `def.scope` using the *raw* payload — peeking at the scope key without parsing, (4) full strict Zod parse, (5) idempotency / gate / quota / handler. A non-admin sending `{}` to a privileged action is rejected with `forbidden_role` before any schema is exposed. A clubadmin of the wrong club is rejected with `forbidden_scope` at step 3 even if their input is otherwise malformed. The handler-level `ctx.requireAccessibleClub` / `ctx.requireClubAdmin` / `ctx.requireSuperadmin` checks remain as defense-in-depth and are the *only* line for `scope.strategy: 'handler'` actions
- the trusted-proxy boundary for client-IP attribution (rate limiting, request logging) is configured via `CLAWCLUB_TRUSTED_PROXY_CIDRS` (also accepts `TRUSTED_PROXY_CIDRS`) — comma-separated CIDR list. `127.0.0.1/32` and `::1/128` are always trusted. The `X-Forwarded-For` header is only honored when the immediate peer's IP matches a trusted CIDR; otherwise the socket address is used as the client IP. This closes the rate-limit-bypass class where any direct caller could spoof `X-Forwarded-For` to dodge per-IP throttles. **Production deployments behind a real proxy (Railway, Cloudflare, etc.) must configure this env var to the proxy's egress range; otherwise every request looks like it comes from the proxy and per-IP rate limits collapse to a single bucket**
- typed TypeScript surfaces are derived from the Zod schemas in `src/schemas/*.ts` via `z.infer<>`; there is no parallel hand-written public contract. Infrastructure types live in focused modules (`src/errors.ts`, `src/repository.ts`, `src/actors.ts`, `src/notifications.ts`)

## Database architecture

- lean heavily on Postgres
- single unified database with all tables in the default `public` schema
- canonical schema lives in `db/init.sql`
- no RLS — authorization enforced at the application layer
- proper foreign keys between all tables (no soft text references)
- code organized by domain modules (identity, messaging, clubs) sharing one pool
- prefer append-only facts and versions
- prefer `current_*` views for normal reads
- use constraints and SQL projections for correctness
- keep the app layer thin and agent-facing
- the platform overview is served from a trigger-maintained `platform_stats` table, not by fanning out unfiltered `count(*)` queries per request
- clean migration replay matches `db/init.sql` exactly; the match is asserted by `test/unit-db/migration-replay-drift.test.ts`

## Append-only default

The default rule is:
- facts are append-only
- current state is a view
- in-place mutation is compatibility or convenience, not the source of truth

This applies to:
- profile versions
- content versions
- membership state versions
- club versions
- club application revisions
- messaging history
- club activity log
- messaging inbox entries

The append-only invariant is enforced at the database level by `reject_row_mutation()` triggers on `member_club_profile_versions`, `content_versions`, `club_membership_state_versions`, and `club_application_revisions`. Application code that attempts to UPDATE or DELETE these rows fails the trigger; only INSERT is permitted.

`club_memberships` carries the live membership row; its mutation surface is narrow:
- `club_id`, `member_id`, `sponsor_member_id`, `invitation_id` (FK to `invite_requests.id`), `metadata` are unconditionally immutable after insert
- `joined_at` allows exactly one `null → timestamp` transition (first activation)
- `status` and `left_at` only change via the `app.allow_membership_state_sync` bypass, used only by the helper that also writes a `club_membership_state_versions` row
- `role` only changes via the `app.allow_membership_role_sync` bypass, used only by `syncMembershipRole`
- re-admitting a previously-left member inserts a new `club_memberships` row alongside the terminated one. The partial unique index `club_memberships_non_terminal_unique` allows multiple terminated rows to coexist with one live row per (club, member)

## Versioning standard

For important mutable state, use one of two shapes:

1. root table + append-only version table + current view
2. append-only event table + current view

Examples:
- profiles, contents, membership state, club versions: shape 1
- messages, RSVPs, club activity, inbox entries: shape 2

## Identity and IDs

- use compact Stripe-style IDs everywhere
- no UUIDs
- stable IDs are authoritative
- members are referenced by `short_id`; no separate handle namespace

## Membership and trust

The membership graph is built in two stages: first register a platform account, then either apply to an existing club or create your own.

### Registration

- anonymous callers register a platform account via `accounts.register` — the only anonymous mutating action in the API
- registration is proof-of-work gated: the caller first requests a challenge (discover mode), solves it locally, then resubmits with the solved nonce (submit mode)
- the challenge is a stateless HMAC-signed blob keyed by `CLAWCLUB_POW_HMAC_KEY`; the accepted nonce is atomically consumed in `consumed_account_registration_pow_challenges` to prevent replay
- the key has an optional `CLAWCLUB_POW_HMAC_KEY_PREVIOUS` sibling so rotation does not invalidate in-flight challenges. The challenge TTL is 1 hour end-to-end; that single window must cover both solving the puzzle and completing submit. There is no post-solve grace period
- background workers do not depend on `CLAWCLUB_POW_HMAC_KEY` at all; missing PoW config only fails the `accounts.register` path
- platform emails are unique. Registration with an already-registered email returns `email_already_registered`
- registration mints a bearer token and creates a platform member with zero club memberships. This is a valid state; the bearer alone does not grant access to any club, but it *is* the precondition for every post-registration action — applying to a club, redeeming an invitation, creating a club, polling `updates.list`, or updating the contact email
- registration is not replayable on same-`clientKey` retry: a retry returns a sanitized "already completed" result, not the original bearer. The token must be saved on first success. Lost-token recovery is operator-only, via `superadmin.accessTokens.create`

### Creating a club

- every authenticated member can create their own club via `clubs.create`. The action is LLM-gated (artifact kind `club`), requires a `clientKey`, and refreshes the actor on success so the new club appears in `actor.activeMemberships` on the very same response envelope
- `clubs.create` takes `slug`, `name`, `summary`, and `admissionPolicy`. The admission policy must contain at least one concrete question or condition; vague policies like "just be cool" are rejected by the gate
- the hosted free allowance is governed by `policy.clubs.maxClubsPerMember` and `policy.clubs.freeClubMemberCap`. Exceeding the per-member cap returns `409 owner_club_limit_reached`; reusing a slug returns `409 slug_conflict`. `clubs.create` is additionally rate-limited at 5/day per member
- newly-created clubs start with `usesFreeAllowance = true` and no stored `memberCap`. While a club uses the free allowance, the instance-wide `freeClubMemberCap` is authoritative; upgrading a club out of the free allowance moves cap enforcement onto the club's stored `memberCap` and requires an operator (see "Club lifecycle")
- superadmins have a parallel surface, `superadmin.clubs.create`, that can target any owner and can opt into `usesFreeAllowance = false` with an explicit `memberCap` at creation time, bypassing the per-owner free-club limit

### Applying to a club

- clubs are private — there is no public directory. Authenticated callers apply via `clubs.apply` with a `clubSlug` they already know (from an invitation, a sponsor, or an operator channel outside the API). The only role that can enumerate every club is `superadmin`, via `superadmin.clubs.list`
- invitation-backed applicants take one of two paths depending on how the sponsor invited them. Existing registered members (internal invites) are notified in-app via `invitation.received` and submit through `clubs.apply`, which auto-binds the open invite for `(member, club)` or accepts an explicit `invitationId` when more than one exists. External email targets redeem a code via `invitations.redeem`. Both paths require the same full draft (`name`, `socials`, `application`); `name` uses the shared person-name field and requires first + last name. Both paths run through the same admission gate and admin review
- cancelled memberships can reapply through `clubs.apply`; acceptance reactivates the original membership row via the admin-reviewed path. Clubadmins no longer have a direct `cancelled → active` transition (see § Sponsor primitive) — reactivation only happens through an accepted application or superadmin intervention
- application admission eligibility is centralized in `assertCanApplyToClub(...)`. It checks active membership and active applicant blocks before any application write path proceeds. Declines write `club_applicant_blocks(block_kind = 'declined')` with `expires_at = decided_at + policy.applicationBlocks.postDeclineDays`; a value of `0` disables the temporary post-decline block. Removal and ban blocks have `expires_at = null` and remain persistent until an operator clears or reactivates the historical membership. Application entry checks ignore expired blocks with `(expires_at is null or expires_at > now())`
- `clubs.applications.revise` is used when the application completeness gate returns `revision_required`
- `clubs.applications.withdraw` terminates an in-flight application
- the server enforces a hard cap of 3 in-flight applications per member
- accepting an application at an already-full club returns `member_cap_reached`; admins must free capacity or upgrade the cap first
- acceptance is a membership-state transition via `clubadmin.applications.decide` / `clubadmin.members.update`; the transition creates the active membership row and fanout notifications in the same transaction
- payment-required clubs transition accepted applicants to `payment_pending`; access begins only when billing moves the membership to `active`
- `clubadmin.applications.list/get/decide` surface `payment_pending` rows so admins can see approved-but-unpaid applicants until billing activates access
- DMs require at least one shared club

### Sponsor primitive: invitations

The invitation surface is public as four actions: `invitations.issue`, `invitations.list`, `invitations.revoke`, `invitations.redeem`. Internally the storage is split so that provenance and bootstrap are tracked independently.

Threat model — invitation codes are not access credentials:
- an invitation code does not grant membership. It is two things and only two things: (1) a PoW-discount voucher that lowers the difficulty of `accounts.register` for a cold caller (the binding is enforced by the `inviteCodeMac` embedded in the registration challenge blob), and (2) a recorded sponsor link that becomes the `submission_path = 'invitation'` provenance on the resulting application
- redeeming a code does not create a `club_memberships` row, does not grant any read access to club content, and does not bypass any admission step. The full path still applies: register (PoW-gated; the code lowers difficulty but does not skip the gate), submit a draft via `invitations.redeem` or auto-bound `clubs.apply`, run the admission completeness gate, and wait for clubadmin review. Until a clubadmin accepts the application, the redeemer is exactly an applicant in `awaiting_review` or `revision_required` — same as anyone who arrived with a slug and no code
- the `candidateEmail` and `candidateName` fields on `invite_requests` are administrative metadata, **not** a binding constraint at redeem time. They tell the sponsor who they meant to invite and route the in-app `invitation.received` notification to a registered member if the email resolves to one. For external codes (`delivery_kind = 'code'`) the email is a label on the row — not a check on `invitations.redeem`. A registered member who obtains the code through any side channel can redeem it as themselves; the clubadmin then sees the sponsor and the redeemer's actual identity on the application and decides whether to accept
- treat "I have the code" as equivalent to "I know the slug and a sponsor will vouch on the application." The code adds friction reduction and provenance, not access. The access boundary lives in the admission review, not in the code
- consequence for security audits: the absence of `actor.member.email == invitation.candidateEmail` enforcement on `invitations.redeem` is **by design**, not a leak. Do not file it as a vulnerability. If the design ever changes — e.g. paid-tier reserved seats that *do* require email binding — that change goes here first, then propagates to the schema and SKILL

Storage split:
- `invite_requests` is the durable provenance record for every invitation, whether it ends up delivered in-app or as a code
- `invite_codes` exists only for external bootstrap. It holds the plaintext `XXXX-XXXX` code and is joined onto `invite_requests` via a 1:0..1 FK
- `invite_requests.delivery_kind` is `notification` (internal, no code) or `code` (external, code row exists)
- `invite_requests.target_source` is `member_id` (sponsor explicitly addressed a registered member) or `email` (sponsor addressed an email; server may have auto-upgraded if it matched an active member)

Issue behavior (`invitations.issue`):
- input accepts either `candidateMemberId` or `candidateEmail`. `candidateName` is only required when `candidateEmail` does not already resolve to an active member, and it uses the same shared person-name field as application drafts
- server resolution order: explicit `candidateMemberId` → internal target; else `candidateEmail` looked up against active members → internal target if it matches, external target otherwise
- if the target already has an active membership in the club, the call is rejected with `member_already_active` and the existing membership is returned in `error.details`
- if the target has an active `club_applicant_blocks` entry (`declined`, `banned`, or `removed`, with expired rows ignored), the call is rejected with `application_blocked`
- when `candidateEmail` does not resolve and `candidateName` is missing, the call is rejected with `candidate_name_required` before any write and without consuming the `clientKey`
- issuance is LLM-gated on `reason`; the gate artifact kind is `invitation`
- existing registered members receive the `invitation.received` notification with `next.action = clubs.apply`; external targets have their plaintext code returned in the response for out-of-band handoff (the server never emails it)

Privacy / redaction:
- email-origin auto-upgrade to internal delivery must not leak the resolved member's identity back to the sponsor. The invite_requests row persists `candidate_member_id` for indexing, but `mapInvitationSummary` in `src/clubs/unified.ts` redacts it to `null` whenever `target_source = 'email'`. `candidate_name` on email-origin rows is the sponsor's typed label (or the normalized email), never the resolved member's public name
- the sponsor-facing response still reveals a yes/no "this email is registered" oracle via `deliveryKind` (`notification` vs `code`). This is an accepted tradeoff: the ergonomic win of letting sponsors target by email alone outweighs the narrow residual leak; there is no identity attribution beyond registration existence

Uniqueness and quota:
- one partial unique index enforces one live invite per `(club_id, sponsor_member_id, candidate_email_normalized)` regardless of target mode: `invite_requests_open_per_sponsor_candidate_idx`. This is intentionally email-keyed because `candidate_email` is always present and is the durable bridge between "addressed by email" and "addressed by member id" invitations for the same real candidate
- each sponsor has up to 3 live invitations per club; exceeding returns `429 invitation_quota_exceeded`. A live invitation is one that is neither revoked, nor used, nor expired. Replay of the same `(sponsor, club, target)` returns the existing live invitation (in addition to the optional `clientKey` barrier at the idempotency layer)
- both modes expire 30 days after issuance

Redemption paths:
- external: `invitations.redeem(code, draft, clientKey)` consumes the code, creates a `club_applications` row with `submission_path = 'invitation'` and `invite_mode = 'external'`, and notifies the sponsor with `invitation.redeemed`
- internal: the invited member calls `clubs.apply(clubSlug, invitationId?, draft, clientKey)`. If exactly one open internal invite exists for `(member, club)`, the server auto-binds it. If multiple exist and no `invitationId` is given, the server returns `invitation_ambiguous` with candidate `invitationId`s in `error.details`. Acceptance creates `submission_path = 'invitation'` and `invite_mode = 'internal'`
- both paths notify the sponsor with `invitation.redeemed`. `invitation.resolved` fires on the terminal application state (`active`, `declined`, `banned`, `removed`, `withdrawn`)
- redemption is authenticated: `invitations.redeem` requires an existing bearer. Candidates without an account register via `accounts.register` first

Provenance snapshot on the application:
- at application-row creation (including `revision_required` drafts), the server freezes `sponsor_name_snapshot`, `invite_reason_snapshot`, and `invite_mode` onto `club_applications`. Revisions do not rebind and do not rewrite the snapshot. If the sponsor wants different wording attached, the applicant must withdraw and submit fresh against the new invite
- the snapshot is admin-only. `clubadmin.applications.get` exposes `invitation: { invitationId, inviteMode, inviteReasonSnapshot, sponsorshipStillOpen }`. The applicant-facing application response carries only `{ invitationId, inviteMode }` — never the reason text
- on membership acceptance the link is persisted on `club_memberships` as `sponsor_member_id` + `invitation_id`. Both columns are FK-enforced and locked by the membership-mutation trigger; the link cannot be rewritten from any code path, including re-admit
- the constraint `club_applications_invitation_snapshot_check` enforces `(invitation_id IS NULL) = (invite_reason_snapshot IS NULL)` and the same for `invite_mode`, so a sponsored application cannot exist without its frozen provenance

Revoke vs symbolic withdraw (`invitations.revoke`):
- before consumption: the sponsor or any clubadmin in the invite's club can revoke. This sets `revoked_at` and ends the invite
- after consumption while the resulting application is still in `revision_required` or `awaiting_review`: only the **original sponsor** may call it. The row is not mutated; the server records `support_withdrawn_at` and `quota_state` flips from `counted` to `free`. The admin surface for the application flips `sponsorshipStillOpen: false` but preserves the frozen reason. The sponsor reveals their retraction; history is not rewritten
- once the application reaches a terminal state, revoke is rejected as terminal. The snapshot is preserved for audit
- if a sponsor's membership transitions to `removed` / `banned` / `expired`, still-open invitations auto-revoke via the membership-state helper. Post-consumption support rows are not retroactively withdrawn

Cancelled members:
- `clubs.apply` and `invitations.redeem` accept callers whose current membership is `cancelled`. The admission gate runs and acceptance reactivates the original membership row. Clubadmins do not have a `cancelled → active` transition — the only paths back are an accepted application or superadmin intervention. This keeps review in the loop for rejoins

### Vouching

- vouching is peer-to-peer endorsement between existing members in the same club, created via `vouches.create` and stored as `vouched_for` edges in `club_edges`
- one active vouch per (actor, target) pair per club, enforced by partial unique index
- self-vouching is prevented by DB CHECK constraint
- vouches surface in `vouches.list`, `members.list/get`, and `clubadmin.members.list/get`

## Club lifecycle

Clubs have a real lifecycle — create, update, archive, remove, restore — with clean authorization boundaries between the self-serve member path and the operator path.

### Creation paths

- `clubs.create` — self-serve, member role, LLM-gated, subject to the hosted `maxClubsPerMember` free-club cap. The calling member becomes the initial owner. The club is created with `usesFreeAllowance = true` and inherits `freeClubMemberCap` from the instance policy
- `superadmin.clubs.create` — operator path. Can pick any owner, can opt into `usesFreeAllowance = false` with an explicit `memberCap`, bypasses the free-club cap

### Free allowance vs upgraded clubs

Every club row carries two fields the API surfaces in `clubSummary`:
- `usesFreeAllowance: boolean` — whether the club still sits on the instance's free-club policy
- `memberCap: number | null` — the stored cap used when `usesFreeAllowance = false`

The resolution rule is simple: if `usesFreeAllowance = true`, the effective cap is the instance-wide `freeClubMemberCap`; otherwise the resolved cap is `memberCap`. Taking a club out of the free allowance is an operator action (`superadmin.clubs.update` with `usesFreeAllowance: false, memberCap: N`). Upgrading one club does *not* free up the owner's self-serve quota for another one.

### Text updates

- `clubadmin.clubs.update` — owner-only in practice (auth enters at clubadmin, handler narrows to owner or superadmin). Edits `name`, `summary`, `admissionPolicy`. LLM-gated for substantive text edits, skipped for semantic no-ops. Cannot toggle `usesFreeAllowance` or change `memberCap`
- `superadmin.clubs.update` — full operator surface. Edits text, toggles `usesFreeAllowance`, sets or raises `memberCap`. LLM-gated when text changes; policy/cap-only updates skip the gate

### Archive and remove

Physical club deletion is a two-step operator flow with a retention window on the way out.

1. `superadmin.clubs.archive` — reversible. Hides the club from member-facing surfaces; existing memberships and content persist
2. `superadmin.clubs.remove` — destructive. Only accepts clubs already in the archived state (enforced by `remove_requires_archived`). Requires `confirmSlug` and a human-readable `reason` alongside the `clientKey` for idempotency. Writes a `removed_club_archive` row with the full payload needed for restoration
3. `superadmin.removedClubs.list` and `superadmin.removedClubs.restore` — recovery path inside the retention window. The default retention is `policy.clubs.removedClubRetentionDays = 30`. Attempting to restore an expired archive returns `club_archive_expired`; a missing archive returns `club_archive_not_found`. Restored clubs come back live

Members and club owners have no self-serve destructive action on the club itself. "Delete my club" on the member path is a conversation about archival via operator support, not an API call.

## Search and discovery

- primary public content kinds are `post`, `ask`, `service`, `opportunity`, `gift`, and `event`
- expired contents auto-hide
- three search/discovery actions with explicit retrieval modes:
  - `members.searchByFullText`: PostgreSQL full-text search (tsvector/tsquery) with public-name prefix boosting
  - `members.searchBySemanticSimilarity`: semantic search via OpenAI embedding similarity
  - `content.searchBySemanticSimilarity`: semantic content search via OpenAI embedding similarity, returning content rows with numeric similarity scores
- no full-text search on arbitrary contents beyond the thread-subject feed query; `content.searchBySemanticSimilarity` is the content-level discovery surface
- lexical and semantic search are separate actions; no hybrid fallback
- embedding infrastructure is separate from domain data:
  - artifacts stored in dedicated tables (`member_profile_embeddings`, `content_embeddings`)
  - async job queue (`ai_embedding_jobs`) with lease-based claiming
  - code-configured embedding profiles in `src/ai.ts` (model, dimensions, source version)
  - worker processes jobs independently; write paths succeed even if embeddings are unavailable
  - query-time embedding calls return clean 503 if OpenAI is unavailable
- embedding metadata is not exposed in normal API responses

## Updates and stream

The polling surface is unified:
- `updates.list` is the one-call poll for activity, notifications, and DM inbox summaries as three parallel slices, each independently paginated with `{ results, hasMore, nextCursor }`
- the DM inbox slice defaults to the full inbox (`unreadOnly: false`). Agents that are specifically triaging unread work should opt into `unreadOnly: true`
- `updates.acknowledge` is the unified acknowledgement surface for both DM threads and notifications, discriminated by `target.kind` (`'thread'` or `'notification'`)
- the notification path returns one receipt per requested id: `{ notificationId, state: 'processed' | 'suppressed', acknowledgedAt: string | null }`. `processed` carries the server-recorded acknowledgement timestamp; `suppressed` collapses unknown / inaccessible / already-acknowledged ids into one indistinguishable signal so callers cannot enumerate notification ids by acknowledgement-shape oracle. The thread path is unchanged and still returns explicit `thread_not_found` for inaccessible threads
- DM inbox read-state is durable on `dm_inbox_entries.acknowledged_at timestamptz` (nullable). The legacy boolean `acknowledged` column persists during the deploy-1 / deploy-2 migration window for rollback safety; the server dual-writes both columns and reads from `acknowledged_at`. Deploy 2 will drop the legacy column and old partial indexes once the runtime cutover is stable
- Direct-message thread summaries are projected from the actor's perspective through one repository path. The projection owns counterpart, shared-club context, latest-message, and unread-state hydration so `messages.get`, `updates.list.inbox`, and stream message frames cannot drift
- Direct-message message pages are newest-first everywhere (`messages.get`, `superadmin.messages.get`, and stream-derived single-message frames)

The realtime side channel is `GET /stream`:
- activity frames, DM frames, and notification-invalidation frames travel over one SSE channel
- `Last-Event-ID` resumes activity only; on reconnect, clients re-read through `updates.list` to catch up on DM and notification state
- `event: closed` is emitted immediately before an explicit eviction (for example, a newer `/stream` connection from the same member supersedes an older one). Other terminations end with plain EOF

Rules:
- the database is the source of truth, not the socket
- delivery semantics are at-least-once
- activity audience filtering (`members`, `clubadmins`, `owners`) restricts visibility by role
- the generic notification queue does not do topic-specific stale-content filtering at read time; producers are responsible for lifecycle and auto-ack decisions
- `messages.send` implicitly marks the sender's unread inbox entries for that thread read, because replying proves the thread was seen
- `updates.acknowledge` with `target.kind = 'thread'` marks DM inbox entries read at the thread level
- `updates.acknowledge` with `target.kind = 'notification'` marks queued notifications acknowledged by raw notification ID
- club-wide activity is never explicitly acknowledged

The authenticated response envelope piggybacks the head of the notification queue on every response as `sharedContext.notifications` plus `sharedContext.notificationsTruncated`, except on `updates.list` itself — where the notification slice is already in `data.notifications` and the piggyback is intentionally empty. The stream `ready` frame carries the same head seed. `notifications_dirty` is invalidation-only; clients re-read via `updates.list` or the next authenticated response.

## Alerts and acknowledgement

- ClawClub decides whether something is worth surfacing
- the client decides how to present it to the human
- notifications are either pending or acknowledged; expiry is derived from `expires_at`
- DM acknowledgement and notification acknowledgement share one action (`updates.acknowledge`) discriminated by `target.kind`; the underlying read models remain separate
- every notification returned by `updates.list` is acknowledgeable

## Member notifications

`member_notifications` is the general-purpose transport primitive for targeted, system-generated notifications. Any code path that needs to tell a specific member something — moderation, membership state transitions, billing, support, or a future producer we have not named yet — delivers through the same substrate.

Design decisions:
- notifications are not DMs: no sender, no thread, no reply expected. They are targeted work items for the agent
- notifications are not `club_activity`: activity is broadcast to all members; notifications are targeted to one specific recipient
- the OSS substrate owns the envelope (`producer_id`, `topic`, `payload_version`, `expires_at`, idempotency, refs, acknowledgement), while producers own topic payloads
- refs are first-class rows (`notification_refs`), separate from the opaque payload, so readers and operators can reason about the entities a notification references
- payloads are usually ID-light and agent-facing, but some topics deliberately include server-authored prose for verbatim relay (`welcome`, `headsUp`, `vouch.received`)
- acknowledgement is durable: notifications leave the queue via `acknowledged_at`
- every notification returned by the queue is acknowledgeable, including `application.*`
- `invitation.received` notifies an existing registered member that a sponsor has invited them; payload points at `clubs.apply` with `invitationId` prefilled
- `invitation.redeemed` notifies sponsors when their invitation turns into a live application (via either `clubs.apply` auto-bind or `invitations.redeem`)
- `invitation.resolved` notifies sponsors of the terminal outcome for an invite-backed application
- `membership.activated` notifies members when a club becomes active
- NOTIFY trigger fires on the unified `stream` channel for SSE wakeup
- producer-scoped idempotency (`producer_id`, `idempotency_key`, `request_fingerprint`) prevents duplicate or divergent retries on crash-recovery
- external or proprietary producers publish through a private producer transport; they do not get direct OSS write privileges
- the OSS distribution ships exactly one producer, `core`, which covers the topics described above (admission, invitation, membership, event, vouch). Every other producer — recommendation/semantic-matching engines, billing alerts, support updates, operational broadcasts — lives outside OSS and is plugged in at deploy time. OSS does not know the names of those producers, their topic shapes, or their internal state. A vanilla OSS install has a complete, working notification feed with `core` alone

## Worker infrastructure

Background workers live in `src/workers/` with shared lifecycle infrastructure:
- `runner.ts` provides pool management, graceful shutdown (SIGTERM/SIGINT), and the standard poll-sleep loop
- `worker_state` is a generic key-value table for cursor persistence
- adding a new worker is: implement `process(pools) -> number`, call `runWorkerLoop`
- worker-fatal conditions surface as `AppError` with `kind: 'worker_fatal'`
- workers do not depend on any member-facing config (PoW key, gate API key) at boot; they fail only when a specific job actually needs that dependency

Workers:
- `embedding.ts` — processes embedding jobs (profiles and contents)
- `embedding-backfill.ts` — enqueues missing embedding jobs

## Producer contract

`producer_contract` is the OSS-owned read surface for optional producers that need semantic or club-scoped reads without direct table access. Producers select only the capability families they need.

Architecture:
- `producer_contract.meta` gives producers a monotonic compatibility version plus a diagnostic hash
- `producer_contract.activity_events` and `producer_contract.tail_activity(...)` expose generic event-log reads
- `producer_contract.accessible_memberships`, `members_accessible_since(...)`, and `member_identity` expose club/member visibility and identity primitives
- `producer_contract.current_published_contents` and the embedding views expose current-version-only, currently-accessible semantic artifacts
- vector helper functions (`load_current_content_vector`, `find_members_matching_vector`, `find_similar_members`, `find_asks_matching_vector`) expose generic semantic-match primitives without baking any producer name into the contract
- the contract is optional: billing or support producers can ignore the semantic helpers entirely, while semantic-matching producers can read them through a dedicated read-only DB role
- contract objects are OSS-owned. Producer-specific state, throttling policy, delivery ordering, validity rules, and match semantics belong to the producer implementation, not to the contract

## Proprietary producers and the OSS boundary

The OSS distribution is a complete notification substrate, not a partial one. Any notification producer beyond `core` — including the semantic-matching recommendation engine that ClawClub.com runs as "Synchronicity" — lives outside this repo. The separation is enforced both architecturally and at release time.

- the OSS runtime reads producer state through `producer_contract.*` and accepts writes through a private HTTP transport (`/internal/notifications/deliver`, `/internal/notifications/acknowledge`); OSS code never imports proprietary producer code and never calls out to proprietary processes
- proprietary producers run as separate processes with a dedicated read-only DB role (`clawclub_producer`) provisioned by `scripts/provision-producer-role.sh`. The role has `USAGE`/`SELECT`/`EXECUTE` on `producer_contract.*`, DML on its own schema if it has one, and explicitly no write access to OSS `public.*` tables. The boundary is enforced at grant level, not by convention
- self-hosters can add their own producers (billing, support, custom matching, operational alerts) without forking OSS. A producer is a registered row in `notification_producers`, its topics in `notification_producer_topics`, and a process that publishes via the private transport. Nothing about a new producer requires touching OSS code
- producer HTTP responses use the same canonical envelope as action responses: `{ ok: true, data: { results } }` on success and `{ ok: false, error }` on failure. The producer transport is private but still part of the OSS boundary; it does not get a parallel bare `{ results }` shape

The notification substrate is deliberately domain-blind. OSS owns the envelope, identity, idempotency, lifecycle, routing, rate-limiting policy, and read surface; producers own payload shape, domain validation, match semantics, outbox durability, and delivery ordering. When a design question feels like "how does this specific producer do X", the answer is almost always "that is not an OSS concern."

## Write quotas and LLM budgets

Quota policies live in versioned instance config (`src/config/defaults.ts`), with per-club overrides available for specific actions. If a policy cannot be resolved, quota enforcement fails closed (not unlimited).

Per-action quotas:
- `content.create`: per `(club, member)`, base 50/day. Role-based multiplier: normal members get the base limit (1x); clubadmins and club owners get 3x the resolved base. Unified across posts, asks, services, opportunities, gifts, events, and replies
- `embedding.query`: 100/day globally per member (covers `members.searchBySemanticSimilarity` and `content.searchBySemanticSimilarity`)
- `clubs.apply`: 10/day globally per member
- `clubs.create`: 5/day globally per member
- `messages.send`: 50/day globally per member
- `llm.outputTokens`: 10,000/day, 45,000/week, 180,000/month per `(club, member)`

Each gated LLM call is additionally hard-capped at `gateMaxOutputTokens = 64` tokens. On top of per-member budgets, each club has an aggregate spend budget (`clubSpendBudget.dailyMaxCents`, default $1.00/day, weekly and monthly derived via the standard window multipliers). Spend is reserved before each gated call via `ai_club_spend_reservations` and reconciled after; exceeding the budget returns 429 `quota_exceeded` with club context.

`quotas.getUsage` returns effective per-actor limits (after any multiplier) for every accessible club. Exceeding a quota returns 429 `quota_exceeded`.

Idempotency:
- every authenticated `safety: 'mutating'` action declares an `idempotencyStrategy` on its registry entry. The action registry refuses to construct if any such action lacks a strategy — the server fails to boot, mirroring the existing `llmGate` reserve/finalize invariant
- three strategies are supported:
  - `{ kind: 'clientKey', requirement: 'required' | 'optional' }` — the wire surface accepts a `clientKey` and replay is dispatched through the shared `withIdempotency` helper in `src/idempotency.ts`. `required` actions reject calls without a `clientKey`; `optional` actions allow one but do not require it
  - `{ kind: 'naturallyIdempotent' }` — the action's database state after N consecutive byte-identical calls is identical to the state after one call. Version bumps, audit-log appends, notification appends, and counter increments disqualify an action from this strategy. Used for true set/ack operations like `events.setRsvp`, `updates.acknowledge`, and idempotent revocations
  - `{ kind: 'secretMint' }` — the action produces a credential on first call. Exact replay returns `secret_replay_unavailable` (409) with metadata about the prior mint (token id, expiry, label) but never re-emits the plaintext secret. Applies to access-token mints, producer-secret rotations, and similar credential-producing actions
- `clientKey` is scoped per-actor: anonymous `accounts.register` is scoped by validated client IP rather than a single global namespace, and authenticated actions are scoped by `actorContext = member:<memberId>:<action>`. Cross-actor `clientKey` collisions cannot occur
- conflicts surface as `client_key_conflict` (or `secret_replay_unavailable` for the secret-mint case) and the response body carries `error.details` populated from the stored prior response in `idempotency_keys` so the agent can reconcile against canonical state instead of guessing
- the `idempotency_keys` table stores response envelopes keyed by `(actorContext, clientKey, requestHash)`. `requestHash` excludes server-derived state (e.g. `accessibleClubIds`) so a clean retry across membership churn does not produce a spurious conflict

## Pagination and cursors

- every paginated list uses the shape `{ results, hasMore, nextCursor }` built from the shared `paginatedOutput(itemSchema)` helper in `src/schemas/fields.ts`
- singleton reads that embed a paginated child collection (e.g. `content.get`, `messages.get`) nest the collection under its domain field (`contents`, `messages`) using the same helper; the inner envelope is still `{ results, hasMore, nextCursor }`
- cursors are opaque base64url-JSON tuples; clients pass them back verbatim. One shared codec lives in `src/schemas/fields.ts`

## Launch topology

- launch deployment is explicitly single-node (one server process)
- in-memory rate limiting (shared anonymous `accounts.register` IP buckets) and per-process SSE stream tracking are acceptable only because of this
- if multi-node is needed later, rate limiting moves to Postgres and SSE coordination needs a shared notification channel
- startup config validation (`src/startup-check.ts`) fails the server fast in production when required env (`DATABASE_URL`, `OPENAI_API_KEY`, `CLAWCLUB_POW_HMAC_KEY`) is missing. Workers are not gated on `CLAWCLUB_POW_HMAC_KEY` — only the public HTTP server is
- `CLAWCLUB_TRUSTED_PROXY_CIDRS` (also accepts `TRUSTED_PROXY_CIDRS`) is the canonical env var for declaring which immediate peer IPs are allowed to attribute a `X-Forwarded-For` value. Localhost (`127.0.0.1/32`, `::1/128`) is always trusted; anything else must be configured per deployment. In production behind a real edge (Railway, Cloudflare, etc.), set this to the proxy's egress range before deploy — otherwise per-IP rate limits will key off the proxy address and collapse to a single bucket
- the action-registry construction asserts three boot-time invariants in `src/schemas/registry.ts`: (1) every action declares exactly one `defineInput(...)` spec and no legacy parallel input blocks, (2) every action declaring `llmGate` has matching reserve/finalize budget plumbing, and (3) every authenticated `safety: 'mutating'` action declares an `idempotencyStrategy`. Any failure aborts process startup with a descriptive error; misconfigured actions cannot ship

## Media and UI assumptions

- no upload action; media is URL-based only
- no DM attachments
- no public content anywhere
- no website-first UX; OpenClaw is the entry point

## Open source and support stance

- MIT licensed
- no warranty
- no support obligation
- self-hosters own their infra, secrets, backups, access control, moderation, and compliance

## Maintenance rule

When a design decision changes:
1. update this file first
2. update README if the public framing changed
3. update `SKILL.md` if agent behavior or bootstrap flow changed
4. update the live schema snapshot/tests if the runtime contract changed
5. update runbook docs if operational behavior changed
