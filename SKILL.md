---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private clubs. Use when the human wants to search members by name, city, skills, or interests; post status updates; create opportunities or events; send DMs; invite someone to a club; apply to join a club; or consume the realtime activity, notification, and DM stream. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

> **IMPORTANT — do not summarize this file.** This is a complete behavioral specification. Read it in full.

ClawClub is open-source software for running private clubs. Anyone can self-host their own ClawClub instance. This skill works with any ClawClub server — the base URL is provided when the skill is configured.

The value is in the club, membership, and trust graph — not in the software alone.

## How to connect

Configure a **bearer token** for the target ClawClub server. The base URL is already embedded in every endpoint below — use those URLs verbatim.

> **CRITICAL — you are already reading SKILL.md, the behavioral spec. Fetch the schema next.** `GET {baseUrl}/api/schema` is the authoritative contract for every action's input fields, enum values, response shapes, and error codes. This file lists *which* actions exist and *why* to use them, but it deliberately does NOT restate field names or enum values — those live in the schema and only the schema. Guessing them from prior knowledge, this file, or another ClawClub instance WILL produce `invalid_input` errors (e.g. using `approved` when the enum is `accepted`, or passing `clubId` in a header instead of `input`). The fetch is cheap, cached per session via `schemaHash`, and non-negotiable.
>
> The schema response is wrapped in the standard envelope: `{ ok, data: { actions, schemaHash, ... } }` — for the schema handshake, read from `.data`. Every *other* authenticated action response uses the envelope `{ ok, data, actor, sharedContext, requestScope }` — `actor` and `sharedContext` are **siblings** of `data`, not nested inside it (e.g. memberships live at `actor.activeMemberships`, not `data.actor.activeMemberships`). Send `schemaHash` back on subsequent calls as the `ClawClub-Schema-Seen` header so the server can tell you if the schema has changed.
>
> **Next step: fetch `/api/schema` before `session.getContext`, before any admin or admissions call, before anything else.** If the human asks you to perform an action and you have not yet fetched the schema in this session, fetch it now.

**Calling actions.** Every action in this skill is dispatched via a single endpoint: `POST {baseUrl}/api` with a JSON body of the form `{"action": "<name>", "input": {...}}`, and (if authenticated) an `Authorization: Bearer <token>` header. There is no per-action URL — `POST /api/<action>` will 404. All action parameters (including `clubId`) go inside `input`, never as headers or query strings. The schema's `transport` block has the full envelope details.

The schema includes a `schemaHash`. Cache per base URL for the current session. If the hash changes on a subsequent fetch, replace your cache.

> **Contract handshake.** Every response except `GET /stream` includes a `ClawClub-Schema-Hash` header. Cache the latest hash you've seen and send it back as `ClawClub-Schema-Seen` on every `POST /api`. If the server's schema has changed since your cache was populated, it will reject the request with `409 stale_client` and an `error.message` that tells you exactly what to do. Read that message literally and follow the steps in order. Auto-retry is only safe for read-only actions or mutations that include a `clientKey`. For other mutations, confirm with the human before retrying so you do not duplicate a side effect. Sending the header is optional, but participating agents get clean recovery behavior when the contract drifts. The SSE stream is deliberately exempt from this handshake — do not treat a long-lived `/stream` connection as a staleness signal.

**Schema conventions.** Cursorable list surfaces accept `limit` and `cursor`, and return `{ results, hasMore, nextCursor }`. `limit` is validated in the range advertised by `/api/schema`; out-of-range values are rejected with `invalid_input`, not clamped. This includes `superadmin.clubs.list`, `superadmin.messages.get`, `invitations.list`, `accessTokens.list`, and `superadmin.accessTokens.list`. `updates.list` uses `cursor` for the activity, notifications, and inbox slices. Some list responses also echo resolved filters so you can verify what the server actually applied; for example `vouches.list` echoes `memberId`, `limit`, and `clubScope`, and `updates.list.activity` echoes `limit` and `clubScope`.

**Public shape conventions.** Bearer-token creation responses use a flat token object `{ tokenId, ..., bearerToken }`; `superadmin.members.createWithAccessToken` requires `email` and returns `{ member, token }`. `messages.send` returns `{ message, thread }`: message-inherent fields live on `message`, while thread/perspective context such as `recipientMemberId` and `sharedClubs` lives on `thread`. `messages.get` and `superadmin.messages.get` return messages newest-first. DM thread summaries use `counterpart: { memberId, publicName }`, not separate counterpart id/name fields. `events.setRsvp` returns `data.content`. `clubadmin.members.get` takes `memberId`. Member email is nullable on read surfaces; if a member has no email on record, expect `null`, not an empty string.

`accessTokens.create` and `superadmin.accessTokens.create` accept `expiresAt` as optional. If you provide it, it must be a future ISO datetime no more than five years out. Omit it or pass `null` for a non-expiring token.

### Checking for new state

1. **One-call polling catch-up** — `updates.list`
2. **Real-time** — `GET {baseUrl}/stream?after=latest`

**Do not split broad polling across multiple actions.** The polling command is `updates.list`.

> **Club admins:** use `clubadmin.applications.list` / `clubadmin.applications.get` to review pending applications. `updates.list` is the default catch-up surface for member-facing state, DMs, and queued notifications; it is not a substitute for the admin review queue.

After processing:
- call `updates.acknowledge` with `target: { kind: "thread", threadId }` to mark a DM thread read
- call `updates.acknowledge` with `target: { kind: "notification", notificationIds }` for queued notifications
- activity items advance only via the activity cursor and are not explicitly acknowledged

Notification acknowledgement returns one receipt per requested id. `state: "processed"` means the server acknowledged an accessible queued notification and includes `acknowledgedAt`; `state: "suppressed"` with `acknowledgedAt: null` deliberately covers unknown, inaccessible, or already-acknowledged ids without distinguishing them.

Replying in a DM via `messages.send` also auto-marks that thread read for the sender. Use `updates.acknowledge` when you read a thread without replying.

`updates.list` is the one polling command for "has anything happened?" It polls three surfaces in one call: the club activity log, the personal notification worklist, and the DM inbox summary. The DM inbox slice defaults to the full inbox (`unreadOnly: false`); pass `unreadOnly: true` only for unread-only triage. Each slice uses `{ results, hasMore, nextCursor }`, but the activity slice is a polling cursor rather than classic null-at-tail pagination: its `nextCursor` is always present, `hasMore: true` means "call again immediately", and `hasMore: false` means "hold this cursor and poll again later." The notification and inbox slices keep classic pagination semantics; if notifications still has `hasMore: true`, continue by calling `updates.list` again with `notifications.cursor` set to the returned `nextCursor`. `notifications_dirty` is invalidation-only — it tells you to re-read state, not that the payload arrived on the stream. `Last-Event-ID` only resumes activity; after reconnect, call `updates.list` to catch up on missed DM and notification state.

Where to read notifications:
- `updates.list` → `data.notifications.results` (authoritative queue)
- any other authenticated action → `actor.sharedContext.notifications` (fast-path piggyback after a write; empty on `updates.list`)

Never process both in the same response.

`event: closed` is emitted by the server immediately before an explicit eviction. `data` is `{ "reason": "<stable code>", "message": "<plain English>" }`. Current reasons: `"superseded"` (a newer `/stream` from the same member reached the per-member cap; the newest connection wins). After `closed`, the socket will end; reconnect if needed.

Other stream terminations (token revoked, network blip, server shutdown, client disconnect) end with plain EOF and do not emit `closed`. Treat EOF as the general end-of-stream signal and `closed` as an additive diagnostic signal.

---

## Session bootstrap

1. `GET {baseUrl}/api/schema` — cache `schemaHash`
2. If authenticated, `POST session.getContext` — read `actor.activeMemberships`
3. If authenticated, poll `updates.list` once for catch-up state
4. Pick a `clubId` from `actor.activeMemberships` for scoped actions, or use a `clubSlug` the human already has for pre-membership flows (see "Club discovery" below)
5. Only then route the human request

Route using each action's `description`, `businessErrors`, `scopeRules`, and `notes` from the schema — not from memory or from this file.

Registration via `accounts.register` is the only mandatory ceremony step. Club-specific welcomes arrive later through `updates.list` as `application.accepted` notifications.

## Club discovery

**There is no public directory.** ClawClub clubs are private. The server does not expose any action — authenticated or unauthenticated — that lists every club. Do not look for one, do not ask the schema for one, and do not invent a workaround. A cold agent **cannot** discover what clubs exist on the server.

How a prospective applicant arrives at a specific club:

- **A private DM from an existing member.** For an existing network member, the normal social invite is often just a regular DM from someone who already knows them. The DM should name the club and include the `clubSlug` if the recipient will need it to call `clubs.apply`. This is only a nudge to apply — it does not grant membership.
- **An invitation.** A current member sponsors them via `invitations.issue`. Existing registered members get an in-app `invitation.received` heads-up and then apply through `clubs.apply`. External invitees get a code and redeem it with `invitations.redeem`. The invitation itself carries the club context — the agent does not need to discover anything.
- **Word of mouth.** The human already knows the exact `clubSlug` (or `clubId`) from the club's owner, a sponsor, or an operator channel outside this API. Ask the human for it. Do not guess.

How an existing member finds their own clubs:

- Read `actor.activeMemberships` from `session.getContext`. That is the authoritative, scoped list of clubs the caller belongs to.

If a human says "what clubs are on this server?" or "show me every club," the honest answer is that the API does not expose that and you cannot retrieve it. Ask them instead for the slug or invitation code they were given. If they have neither, they need to be invited.

Do not swap `clubSlug` and `clubId`: pre-membership surfaces (`clubs.apply`, `invitations.redeem`) take a `clubSlug` the human brings in; scoped / post-membership surfaces take a `clubId` from `actor.activeMemberships`.

## Club lifecycle

There are now explicit actions for creating, updating, removing, and restoring clubs.

### Who can create a club

- **Members** use `clubs.create` to create their own club.
- **Superadmins** use `superadmin.clubs.create` to create a club for any owner.

`clubs.create` is the self-serve path. It is LLM-gated, requires a `clientKey`, and refreshes the actor so the new club appears in `actor.activeMemberships` immediately after success.

On hosted/free instances, do not guess the self-serve limits. Read them from the published instance policy in the schema handshake:

- `instancePolicy.clubs.maxClubsPerMember`
- `instancePolicy.clubs.freeClubMemberCap`

Current hosted intent is:

- one self-serve club per member
- a free club starts with the free-club cap
- the owner counts toward that cap

If a member already owns the maximum number of clubs they may create themselves, `clubs.create` returns `owner_free_club_limit_reached`. Do not tell them to "just try again." Tell them to keep using the existing club, or ask an operator to upgrade it or create another one manually.

### Free clubs vs upgraded clubs

Club summaries expose:

- `usesFreeAllowance`
- `memberCap`

Interpret them like this:

- `usesFreeAllowance: true` means the club is still on the instance's free-club policy and inherits `instancePolicy.clubs.freeClubMemberCap`
- `usesFreeAllowance: false` means the club has been taken out of the free allowance and its stored `memberCap` is authoritative

Important rule: **upgrading a club out of the free allowance does not entitle the owner to create another self-serve club.** The hosted product policy is "one club per user on the member self-serve path," not "one currently-free club."

### Who can update a club

- **Owners** update club text through `clubadmin.clubs.update`
- **Superadmins** use `superadmin.clubs.update`

`clubadmin.clubs.update` is owner-only in practice. Non-owner clubadmins fail before the gate runs.

Member/owner update surface:

- use it for text changes (`name`, `summary`, `admissionPolicy`)
- it is LLM-gated for substantive text edits
- it skips the gate for semantic no-ops
- it does **not** let the owner change `memberCap` or escape the free allowance

Superadmin update surface:

- can edit club text
- can switch `usesFreeAllowance` to `false`
- can set or raise `memberCap`

That is the operator path for "this club is no longer free; raise the cap."

### Club removal and restore

Physical club deletion is a **superadmin-only** flow. Members and club owners do not have a self-serve delete action.

The lifecycle is:

1. `superadmin.clubs.archive`
2. `superadmin.clubs.remove`
3. optional recovery through `superadmin.removedClubs.list` and `superadmin.removedClubs.restore`

`superadmin.clubs.remove` is intentionally cautious:

- it only works on an already-archived club
- it requires `confirmSlug`
- it requires `reason`
- it requires `clientKey`

If a human says "delete my club" and they are not a superadmin, do not improvise a destructive flow. Tell them removal is an operator action. If they only want the club hidden or inactive, archival is the less destructive operator step.

Restored clubs come back live. `superadmin.removedClubs.list` is the archive inventory, and `superadmin.removedClubs.restore` is the one-shot recovery action.

---

## How someone joins a club

The flow is now **register first, apply second**.

### Stage 1: register an account

If the human does not already have a bearer token:

1. Call `accounts.register` in its discover shape. If the human has an external invitation code, include both `invitationCode` and their email in discover; supplying only one is invalid.
2. Read and surface the returned `challenge.expiresAt` immediately. The registration challenge is valid for 1 hour from issuance, and that single window must cover both solving the puzzle and submitting registration.
3. Solve the returned proof-of-work challenge locally and call `accounts.register` in its submit shape with the solved proof, the user's public name, email, and a fresh `clientKey` before `challenge.expiresAt`. If discover included `invitationCode`, submit must include the same invitation code and the same email. There is no extra post-solve grace period.
4. Save the returned bearer token immediately.

Registration creates a real platform member with zero club memberships. That is a valid state. The bearer does **not** grant access to any club by itself.

Using an invitation code during registration only reduces the registration PoW for the code/email pair. It does **not** consume the invite, create a club application, or join the club. The member still needs Stage 2.

**Important idempotency exception:** `accounts.register` will not replay the bearer on same-`clientKey` retries. If registration succeeded and the bearer was lost in transit, a retry with the same `clientKey` returns a sanitized "already completed" result, not the token again. Tell the human to save the token carefully. Operator recovery may exist out-of-band, but there is no self-service recovery flow.

### Stage 2: apply to a club

Every applicant is authenticated by this point.

- The human must already know the target club (slug from an operator or sponsor, or an invitation code). There is no discovery step — see "Club discovery" above.
- Use `clubs.apply` for a normal application, passing the `clubSlug` the human brought in.
- Use `invitations.redeem` when the human has an invite code. Redemption still requires the same full `draft` object: `name`, `socials`, and `application`.
- `draft.name` is a person name, not a handle: provide a first and last name. The same rule applies to `invitations.issue.candidateName`.
- Use `clubs.applications.revise` when the server asks for revisions.
- Treat `data.application.phase` together with `data.workflow` as the authoritative current state. Do not infer submission state from your own memory.

The main paths are:

1. **Registered member, no invite**
   - Call `clubs.apply`.
   - If the response phase is `revision_required`, patch the draft and call `clubs.applications.revise`.
   - If the response phase is `awaiting_review`, stop and wait for admin review.
   - Never tell the human they have "applied" or "submitted" when the phase is `revision_required`. That phase means the draft is saved only and has NOT reached club admins yet.

2. **Registered member, with in-app invite**
   - Call `clubs.apply` with the `clubSlug` from the invite/DM.
   - If the server returns `invitation_ambiguous`, pick one of the candidate `invitationId` values from `error.details` and retry `clubs.apply` with that `invitationId`.
   - Handle `revision_required` / `awaiting_review` the same way.

3. **Registered member, with invite code**
   - Call `invitations.redeem` with the invite code and a full draft.
   - Handle `revision_required` / `awaiting_review` the same way.

4. **Existing member applying to another club**
   - Same bearer, same actions. There is no separate "cross-join token" flow.
   - On acceptance, the existing bearer simply gains access to the new club because a new active membership row is created.

There are no anonymous application surfaces, no claim tokens, and no manual bearer delivery. The bearer comes from registration only.

### Application phases

Treat the phase in the response as authoritative:
Read it from `data.application.phase` on applicant-facing application responses, and use `data.workflow` to understand whether the draft is actually with admins yet.

- `revision_required` — the draft is on file but NOT submitted to club admins yet; revise it
- `awaiting_review` — the application is submitted and waiting for admins
- `active` — the application was accepted and the membership now exists
- `declined` / `withdrawn` / `banned` / `removed` — terminal

The defensive reading is:

- `workflow.currentlySubmittedToAdmins = false` means the current draft is not in the admin queue right now.
- `workflow.applicantMustActNow = true` means the applicant still has work to do before the process can advance.
- `workflow.canApplicantRevise = true` means `clubs.applications.revise` is allowed right now.
- `workflow.awaitingActor` tells you who owns the next move: `applicant`, `clubadmins`, or `none`.

Revision and lifetime rules:

- There is no fixed per-application revise limit. A member may revise the same application any number of times while its phase is `revision_required`.
- Revising is only allowed in `revision_required`. Once the phase becomes `awaiting_review`, the applicant must stop and wait for admins.
- Treat `awaiting_review` / `workflow.currentlySubmittedToAdmins = true` as the first moment the human has actually submitted the application to club admins. Before that, the human only has a saved draft on file.
- Each revise counts against the same rolling per-member application quota bucket as `clubs.apply` / `invitations.redeem`.
- `clubs.apply`, `clubs.applications.revise`, and `invitations.redeem` are `clientKey`-idempotent across the whole admission path. Reusing a key with a different payload returns `client_key_conflict`; reusing the exact same payload replays without rerunning admission preflight, quota, or gate work.
- By default that quota is **10 application submits/revises per rolling 24 hours**.
- The application record itself does **not** auto-expire once it exists. A `revision_required` draft can stay on file indefinitely until the applicant revises it, withdraws it, or some later terminal state is written.
- Do not confuse invitation expiry with application expiry: invitation codes expire, but the resulting application record does not have its own TTL.

The server enforces a hard cap of **3 in-flight applications** per member. If the human already has three live applications, resolve one before starting another.

`submissionPath` is historical metadata only:
- `cold` = self-initiated application
- `invitation` = bound to an invitation (either an in-app internal invite auto-bound by `clubs.apply`, or an external code consumed by `invitations.redeem`)

To tell the two `invitation` sub-modes apart, read `application.invitation.inviteMode`: `internal` means the applicant was notified in-app and bound through `clubs.apply`; `external` means they redeemed a code.

Cancelled members can reapply. If a membership is in the `cancelled` state, the same `clubs.apply` path is open; the admission gate runs and an accepted application reactivates the original membership row. Cancelled members do **not** get automatic access back — the applicant only regains access when a clubadmin accepts the fresh application.

Declined applications can create a temporary applicant block. The default instance policy blocks immediate reapplication for 30 days after a decline; operators can configure the window, including disabling it. A removed or banned member has a persistent block. In either case `application_blocked` means do not retry automatically; wait for the temporary block to expire or ask a clubadmin/operator to reconsider a persistent block.

### Drafting rule

The admissions gate is an AI pre-filter for legality and broad relevance, not a guaranteed line-by-line enforcement engine for every admission-policy question.

- Treat the club's admission policy as guidance you should address clearly and concretely.
- If the policy is question-shaped, answering each question directly is still the safest strategy.
- If the gate returns `revision_required`, read the feedback literally and patch the missing items it actually called out.
- Final admission judgment belongs to human admins, not the model.

### Admin review

Club admins review and decide applications through:

- `clubadmin.applications.list`
- `clubadmin.applications.get`
- `clubadmin.applications.decide`
- `clubadmin.members.update`

Acceptance creates the active membership in the same transaction. Decline writes a temporary applicant block according to instance policy; ban and remove write persistent blocks so the same member cannot immediately reapply to that club.

There is no admin-triggered revision verb — `revision_required` is produced only by the gate on submit/revise. Admins decide `accept | decline | ban`.

### Notifications and status changes

Do not poll raw application state as the primary status channel. The standing rule is still: poll `updates.list`.

When resuming from notifications, be defensive:

- Applicant-facing `application.*` notifications now include `phase`, `workflow`, `next`, and `messages`.
- Because these notifications are durable history, if there is any ambiguity about the latest state for one `applicationId`, call `clubs.applications.get(applicationId)` before telling the human whether the application is submitted or still only a draft.
- If `application_in_flight` or `application_not_mutable` returns `error.details`, treat that canonical application payload exactly the same way as a normal success response.

Important notification/update topics include:

Member-facing:

- `account.registered` — platform welcome after registration
- `application.awaiting_review` — the application reached admin review
- `application.revision_required` — the applicant needs to revise
- `application.accepted` — membership created; includes the club welcome payload
- `application.declined`
- `application.banned`
- `application.withdrawn`
- `membership.banned`
- `membership.removed`
- `invitation.redeemed` — sponsor-facing heads-up when an invite code turns into an application record
  Read `applicationPhase` and any included workflow/messages before telling the sponsor the candidate has actually reached admin review.
- `invitation.resolved` — sponsor-facing terminal outcome for the invite-backed application

Admin-facing:

- `clubadmin.application_pending` — materialized ping when an application enters `awaiting_review`; manual `updates.acknowledge` is optional because a successful admin decision auto-acknowledges the pending notification

When a notification includes server-authored prose like `payload.message`, `payload.headsUp`, or `payload.welcome`, relay it verbatim before acknowledging it.

### Registration PoW

Proof-of-work happens **once at registration**, not on every club application. The discover-mode response from `accounts.register` returns `challengeBlob`, `challengeId`, `difficulty`, and `expiresAt`. Treat `expiresAt` as authoritative and surface it to the human.

The registration challenge is valid for **1 hour from challenge creation**. That is a single end-to-end window: the human or agent must both compute the nonce and complete `accounts.register` submit before `expiresAt`. There is **no second timer** after the nonce is found and **no extra grace period** between "challenge solved" and "registration submitted". If submit lands after `expiresAt`, the server rejects it with `challenge_expired` and the only recovery is to call discover again for a fresh challenge.

**The algorithm.** Success means the hex SHA-256 digest of `${challengeId}:${nonce}` ends with `difficulty` **trailing** hex zeros (default `difficulty` is 7, so the hash must end with `0000000`). The hash input uses `challengeId` — not `challengeBlob`. `challengeBlob` is the HMAC-signed payload you pass back to `accounts.register` untouched; `challengeId` is the shorter id you hash against. Do not hardcode the difficulty — read it from the response.

Invitation-assisted registration has a lower default difficulty (6). To use it, discover must include both `invitationCode` and `email`; supplying only one returns `invalid_input`. Submit must include the same code and same email. The challenge binds an HMAC of the invitation code plus the normalized email, so changing either value at submit returns `invalid_challenge`.

Invitation state is checked only after the solved, bound challenge is submitted. Registration can then fail with `invitation_invalid`, `invitation_revoked`, `invitation_expired`, `invitation_used`, `invitation_support_withdrawn`, or `email_does_not_match_invite`. Recovery is to rediscover with the correct code/email or ask the sponsor for a fresh invitation. A successful registration still leaves the invitation redeemable; call `invitations.redeem` after registration to apply to the club.

Do not invent your own solver. Copy the solver below verbatim. If you must port it to another language, preserve two invariants exactly: (1) the hash input is `${challengeId}:${nonce}`; (2) success is **trailing** hex zeros, not leading bits.

```js
const { createHash } = require('node:crypto');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { availableParallelism } = require('node:os');

if (isMainThread) {
  const challengeId = process.argv[2];
  const difficulty = Number(process.argv[3]);
  if (!challengeId || !Number.isInteger(difficulty) || difficulty < 1) {
    throw new Error('usage: node pow.js <challengeId> <difficulty>');
  }
  const n = availableParallelism();
  for (let start = 0; start < n; start++) {
    new Worker(__filename, { workerData: { challengeId, difficulty, start, step: n } })
      .on('message', (nonce) => { console.log(nonce); process.exit(0); });
  }
} else {
  const { challengeId, difficulty, start, step } = workerData;
  const prefix = `${challengeId}:`;
  const fullBytes = difficulty >> 1;
  const halfNibble = (difficulty & 1) === 1;
  for (let nonce = start;; nonce += step) {
    const h = createHash('sha256').update(prefix).update(String(nonce)).digest();
    let ok = true;
    for (let i = 0; i < fullBytes; i++) {
      if (h[31 - i] !== 0) { ok = false; break; }
    }
    if (ok && halfNibble && (h[31 - fullBytes] & 0x0f) !== 0) ok = false;
    if (ok) {
      parentPort.postMessage(String(nonce));
      break;
    }
  }
}
```

If registration proof validation fails, treat that as a registration error, not an application error. Once the bearer exists, club applications do not require another proof round.

### Core join/apply rules

- Never tell the human they are "in the club" until the application reaches `active`.
- A bearer token alone does not imply club access.
- A bearer holder with zero memberships can register, update their contact email, poll `updates.list`, and apply — but cannot access club-scoped content or member lists for clubs they do not belong to.
- Use `clubs.applications.get` / `clubs.applications.list` for member-owned application reads when you need detail, but treat `updates.list` as the primary catch-up surface.
- `clubs.applications.list` defaults to `awaiting_review + active`. Include `revision_required` in `phases` when you need saved drafts that are still with the applicant.
- `applicationLimits.inFlightCount` still counts `revision_required` drafts even when the default list does not show them.

---

# Agent behavior

Treat conversation as the interface. Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction.

## Core behaviors

- **First call of every session: `GET {baseUrl}/api/schema`.** Non-negotiable. Field names, enum values, and required parameters live there and nowhere else. Skipping this step is the single most common cause of `invalid_input` errors. See "How to connect" for the rationale.
- Then call `session.getContext` to resolve the actor, memberships, and club scope
- Clarify missing information before creating or updating anything when the intent is not already specific enough to publish or send
- Keep output concise and high-signal
- Use club context when composing DMs or posts
- If a human needs their first access to the server, use `accounts.register` first.
- If a human asks to join a club, route through `clubs.apply` or `invitations.redeem` with an existing bearer. Do not invent an anonymous join flow.
- If a club admin asks to review applicants, use the `clubadmin.*` actions (check `isOwner` or `role: 'clubadmin'` in `session.getContext`)
- If a club admin wants to inspect one specific application, use `clubadmin.applications.get` directly instead of list-and-filter

## Club awareness

Once the human already belongs to clubs, use `actor.activeMemberships` (from `session.getContext`) as the scoped source of truth. If the human belongs to one club, default to it. If multiple, ask which one. Never silently cross-post. For pre-membership flows, the human brings the `clubSlug` — the API does not expose a directory.

## Membership privacy

- Do not reveal which clubs another member belongs to unless visible through shared club context
- Do not leak membership across clubs
- When in doubt, keep membership private

## Interaction patterns

### Search
Suggest checking the club first when the human expresses a need. Use `members.get` for detail inside a specific club.

### Post an update
If one club, default. If multiple, ask. Keep posts concise.

`content.list` hides closed ask/gift/service/opportunity loops by default. Pass `includeClosed: true` when the human explicitly wants closed-loop history; this applies to all members who can see the club, not only to the original author.

`content.list` and `events.list` return thread-aware result items shaped as `{ id, clubId, content, contentCount, latestActivityAt }`. Use `result.content` for the displayed post/event. `content.get` returns the same thread metadata under `thread`, plus a paginated `contents` collection for the full thread history.

### Create an opportunity
Ask: what, when, where, remote/in-person, paid/unpaid, duration, why recommend it.

## Mentions

The bracket syntax `[Display Name|memberId]` is a **wire-level encoding**, not something the human ever types or reads. The human talks to you in ordinary English ("tell Kevin thanks", "tagging the dalmatian guy", "welcome @kevin"). Your job is to recognise when they mean a specific club member, disambiguate in plain conversation, and silently emit the bracket form in the outgoing content. Never show the brackets to the human. Never ask them to type an id. Never echo the raw stored body of a post back in your reply if it contains brackets — rewrite it to the human-facing form first.

**The workflow**

1. The human drafts a message or post in normal language, sometimes naming other members.
2. Before you submit, scan the draft for any reference that might be a member: first names, full names, nicknames, "him/her", "the breeder I met".
3. For each reference:
   - Call `members.searchByFullText` (scoped to the relevant club for public content, or unscoped for DMs) to find candidates.
   - **If exactly one match is obvious from context**, convert the reference silently without asking. Example: the human is replying to Alice's own post and says "tell her thanks" — just tag Alice, don't interrupt.
   - **If there's any ambiguity** (multiple matches, partial name, nickname you haven't seen before), ask the human in plain English: "Do you mean Kevin Spots from DogClub?" Confirm with them. If they say yes, insert the mention silently on submit. If they say no or pick someone else, use that id instead. If they want it to stay as plain text, leave it alone.
   - **If the reference clearly isn't a club member** (the human's dentist, a public figure, a company), leave it as plain text. Not everything is a tag.
4. When you submit `content.create` / `content.update` / `messages.send`, the body field must contain `[Display Name|memberId]` for confirmed mentions and plain text for everything else. The `Display Name` portion is whatever the human wrote — "Kev", "Kevin", "Kevin Spots" — all fine; the server canonicalizes response `authoredLabel` to the member's current `publicName`.

**When reading content back to the human**

Responses include mention spans with `{ memberId, authoredLabel, start, end }` and an `included.membersById` bundle with each member's current `publicName`. When you quote or summarise content to the human, render mentions as the current public name from `included` — not as `authoredLabel` and definitely not as the raw bracket span. The human should see "Kevin Spots" or "@Kevin Spots", never "[Kevin Spots|xekjjcz5nyyx]".

**Rules**

- The bracket syntax is internal plumbing. The human never sees it and never types it.
- Disambiguate in plain English. Don't paste `[Name|id]` into a confirmation prompt.
- Better to leave a name as plain text than tag the wrong member. Mentioning the wrong id misroutes signal, which is worse than not mentioning anyone.
- Unknown or inaccessible member ids return `invalid_mentions` with `details.invalidSpans[]` entries shaped like `{ mentionText, memberId, reason: "not_resolvable" }`. Relay the meaning to the human, remove or correct those spans, and do not retry with a fabricated id.
- The bracket syntax is distinct from markdown links `[text](url)` — the pipe `|` plus the fixed 12-char id format make them unambiguous; your parser never confuses them.

**Wire-level shape (for reference, not for the human)**

```json
{
  "content": {
    "version": {
      "body": "Thanks [Alice Hound|a7k9m2p4q8r3] for the intro.",
      "mentions": {
        "title": [], "summary": [],
        "body": [{ "memberId": "a7k9m2p4q8r3", "authoredLabel": "Alice Hound", "start": 7, "end": 32 }]
      }
    }
  },
  "included": {
    "membersById": {
      "a7k9m2p4q8r3": { "memberId": "a7k9m2p4q8r3", "publicName": "Alice Hound" }
    }
  }
}
```

The server resolves mentions at write time against the writer's context and re-hydrates the mentioned member's current identity on every read. Public content mentions must resolve inside the writer's club scope. DM mentions must resolve to a participant in that DM thread. Recipients always see the latest display name, even after a rename.

## When To Clarify First

Some actions are structurally valid long before they are conversationally ready. The schema tells you what JSON is accepted. This section tells you when to slow down and ask follow-up questions before calling the action.

### DM vs public post

Before calling `content.create`, verify that the user intends to address the club publicly, not a specific person privately.

- If the content is addressed to one named person and reads like a private 1:1 note, use `messages.send` instead
- If the content includes private arrangements, personal contact details, financial details, or other sensitive information, treat it as a DM unless the user explicitly says they want it posted publicly
- If the intent is ambiguous, ask: `Did you want to post this publicly to the club, or send it as a private message to [person]?`
- Never convert a DM request into a public post without explicit user confirmation

### `content.create`

Treat this as publish-now, not draft-save.

- For `post`, first check whether the content is actually a private message in disguise. Do not broadcast personally addressed or sensitive content to the whole club by default.
- `post` — do not publish generic filler or a body with no concrete point
- `opportunity` — ask for what it is, who it is for, how to engage, and compensation/budget or an explicit note that it is negotiable or voluntary
- `service` — ask what is offered, who it is for, and how to engage
- `ask` — ask for enough context that someone can tell whether they can help
- `gift` — ask what is being offered, who it is for, and how someone should take you up on it
- `event` — ask for the title plus an `event` payload with at least location and start time; include end time, timezone, and capacity when relevant

If the user is vague, ask one or two focused questions before posting.

### `clubs.create`

Treat this like a real club proposal, not a stub.

Before calling `clubs.create`, make sure you have:

- a slug
- a clear club name
- a concrete summary
- an admission policy that contains at least one concrete question or condition the applicant must answer or meet (e.g. "What have you shipped in X?", "Link one recent project", "Members must have N years running team Y"). Vague aesthetic policies like "just be cool" or "good vibes only" are rejected by the gate.

Do not pad the summary with generic filler. The club create path is gated like other LLM-reviewed text surfaces, and vague or operator-hostile club text can be rejected.

Also:

- do not promise success before the gate passes
- do not suggest that a user can create "another free club" by upgrading their first one; that is not allowed on the member path
- do not suggest a `memberCap` input on `clubs.create`; that is not part of the member surface

If the user wants a bigger club than the free policy allows, explain the correct path: a superadmin must take the club out of the free allowance and raise the cap through `superadmin.clubs.update`.

### Create an event
Treat this as publish-ready, not draft-save. Ask for: what it is called, when it starts, where it happens, enough description for someone to decide whether to attend, and timezone if the time could be ambiguous.

### DM a member
Keep messages clear and human. Do not reveal which clubs the recipient belongs to. Never send a message to the user themselves.
Do not use `content.create` as a substitute for a DM. If the content could plausibly be either a public post or a private message, clarify before choosing the action.

If the human wants to invite a specific existing network member to a club, prefer a regular DM when the sender can already message that person:
- Use `messages.send`.
- Say the club name plainly.
- Include the `clubSlug` if the recipient will need it to call `clubs.apply`.
- Be explicit that this is only an invitation to apply. It does not create membership, bypass the admission policy, or skip admin review.

Do not claim the person has joined just because the DM was sent.

### Vouch for a member
Use `vouches.create` for endorsing someone **already in the same club**. Push back on vague reasons. A good vouch includes:
- Concrete, firsthand evidence
- Observable context
- Why it matters to the club

Do not submit until the reason is specific. Use `vouches.list` to check existing vouches.

### Issue an invitation
Use `invitations.issue` when the human wants the server-tracked invitation flow rather than a simple DM nudge. This is for someone **not yet a member of that club**. Required fields are:
- `clubId`
- `reason`
- either `candidateMemberId` for an existing registered member, or `candidateEmail`
- `candidateName` is only required when `candidateEmail` does not already belong to an existing active member, and it must be a full person name

Same quality bar as vouching: who they are, what you've seen them do, and why they belong. The `reason` is persisted as the sponsor's on-the-record justification and is visible to whoever reviews the resulting application — it is not a formality.

**Existing registered members.** When you pass `candidateMemberId`, or when `candidateEmail` resolves to an existing active member, the server upgrades the invitation to in-app delivery automatically. The recipient gets `invitation.received` through `updates.list` and then applies through `clubs.apply`. No code is issued. This is only a heads-up. It does **not** create membership or bypass review. When the sponsor addressed the invite by email, the response confirms in-app delivery but does not echo the resolved member id back to the sponsor.

**External invitees.** When `candidateEmail` does not resolve to an existing active member, the invitation stays code-backed. The response contains `invitation.code` in the short `XXXX-XXXX` format. Sponsors can recover a forgotten code later by calling `invitations.list` and reading the `code` field on their own code-backed invitations.

**Cap and lifecycle.** Each member can have up to **3 live invitations per club** at any time. An invitation counts until it is revoked, expires, or the application it spawned reaches a terminal state. Exceeding the cap returns `429 invitation_quota_exceeded`. Invitations expire 30 days after issuance whether they were delivered in-app or as a code. Use `invitations.list` to see invitation `status`, `quotaState`, `deliveryKind`, and `code`, and use `invitations.revoke` to cancel one. A sponsor can have only one live invitation per normalized candidate email in a club, regardless of whether they addressed the candidate by email or member id. Issuing a new invitation to the same candidate in the same club returns the existing live invitation rather than silently dropping it.

**Joining route.** Invitations never grant membership by themselves. Existing registered members respond with `clubs.apply`. External invitees can use the invitation code during registration for reduced PoW, but that does not redeem the invite. After registration, they still use `invitations.redeem` with a full draft (`name`, `socials`, `application`).

**Revoke vs withdraw.** `invitations.revoke` has two behaviors depending on whether the invitation has been consumed:
- Before consumption (no application exists yet): the sponsor or any clubadmin in the club can revoke, which cancels the invitation outright.
- After consumption, while the resulting application is still live (`revision_required` or `awaiting_review`): only the **original sponsor** can call it. This does not mutate the application; it records a symbolic withdrawal of support. The admin surface for the application flips `sponsorshipStillOpen` to `false` but keeps the frozen `inviteReasonSnapshot` visible.
- After the application reaches a terminal state (`active`, `declined`, `banned`, `removed`, `withdrawn`): revoke is rejected as terminal. The provenance snapshot is preserved as-is.

Already-terminal mutation attempts return typed 409 conflicts instead of `ok:true` replays when the new intent is not a semantic no-op. `content_already_removed` returns `details.content` with the canonical removed content payload, `message_already_removed` returns `details.removal` plus `details.requestedReason` when the retry reason differs, and `invitation_already_revoked` / `invitation_already_expired` return `details.invitation` with the canonical invitation summary. Treat those details as the current state and stop retrying the same mutation intent.

DM outreach, inviting, and vouching are separate:
- **DM outreach** (`messages.send`) = private nudge to an existing member telling them to apply through the normal route
- **Vouching** (`vouches.create`) = endorsing someone already in the club
- **Inviting** (`invitations.issue`) = creating the durable invitation/provenance record; the server either notifies an existing member in-app or returns a code for an external email target

### `members.updateProfile`

Short factual changes are fine. Push back only when the human is asking you to invent vague marketing copy. Ask for concrete wording when fields like `tagline`, `summary`, `whatIDo`, `knownFor`, or `servicesSummary` would otherwise become generic filler.

### `quotas.getUsage`

Use this when the human asks how much public-content allowance is left, or after a 429 `quota_exceeded` response.

### `updates.list`

Use `updates.list` when the human is asking the broad question: "has anything happened, did anyone message me, or is there anything I need to know?" It is the one-call polling surface for activity, notifications, and inbox summaries. `updates.acknowledge` applies to any notification returned in the queue. Use `/stream` for activity, DM, and invalidation frames, then re-read through `updates.list` when needed.

On `updates.list`, treat `data.notifications.results` as the source of truth. `actor.sharedContext.notifications` is intentionally empty there. On every other authenticated action, inspect `actor.sharedContext.notifications` for piggybacked unread items before deciding whether you need a fresh poll.

When you read a queued notification with server-authored prose (`payload.message`, `payload.headsUp`, or `payload.welcome`), relay that prose verbatim before acknowledging it. Do not paraphrase it.

Registration welcome and club-acceptance welcome both arrive through `updates.list`.

### Club removal requests

If a human asks to remove or delete a club:

- if they are a superadmin, use the archive → remove flow
- if they are not a superadmin, explain that permanent removal is operator-only
- do not collapse archive and remove into one conversational step without being clear that removal is irreversible in normal operation

For superadmin removal work:

- verify they mean the correct club
- use the exact slug for `confirmSlug`
- provide a short factual `reason`
- if the club may need to come back, mention that removed clubs can be restored through `superadmin.removedClubs.list` / `superadmin.removedClubs.restore` while within retention

## Auth and scope error codes

The server splits authorization failures into specific codes so an agent can recover precisely instead of guessing from message text:

- `unauthenticated` (401) — no bearer, malformed bearer, or revoked/unknown bearer. Recovery: re-authenticate or ask the human for a fresh bearer; do not retry.
- `invalid_auth_header` (401) — the `Authorization` header is shaped wrong. The server requires literally `Bearer <token>` with no trailing whitespace, no double spaces, no embedded newlines. Recovery: re-send with the canonical shape.
- `forbidden_role` (403) — the actor is authenticated but lacks the required global or club role (e.g. a non-superadmin calling a `superadmin.*` action, or a non-clubadmin calling a `clubadmin.*` action). Recovery: this is a hard wall; do not retry. If the human believes they should have the role, escalate.
- `forbidden_scope` (403) — the actor has the right role but is targeting a club or member outside their scope (e.g. a clubadmin of ClubA calling a clubadmin action with `clubId` for ClubB, or any member passing a `clubId` they do not belong to). Recovery: re-issue the call against an in-scope `clubId` from `actor.activeMemberships`. Reading the scope from `actor.requestScope.activeClubIds` is the safe source of truth — it reflects only verified scope, never raw input.

The legacy `unauthorized` and `forbidden` codes are no longer part of the public error set. Branch on the specific codes above.

## Idempotency strategies and replay

Every authenticated mutating action declares one of three replay strategies:

- **`clientKey` (most common)** — the action accepts a `clientKey` field. Same actor + same key + same payload replays the original response without re-running quota or gate work. Same actor + same key + *different* payload returns `client_key_conflict` (409) with `error.details` carrying the canonical prior response. Read `error.details` instead of guessing — that is the authoritative current state.
- **`naturallyIdempotent`** — actions like `events.setRsvp`, `updates.acknowledge`, and similar set/ack operations whose final state is identical regardless of how many times the same input is sent. Safe to retry without a `clientKey`.
- **`secretMint`** — credential-producing actions like `accessTokens.create`, `superadmin.notificationProducers.create`, and similar. Exact replay returns `secret_replay_unavailable` (409) with safe metadata about the prior mint (`tokenId`, `expiresAt`, `label`) but **never re-emits the plaintext credential**. If the agent loses the original bearer/secret in transit, do not retry expecting recovery — guide the human to mint a fresh credential and discard the conflicted `clientKey`.

`clientKey` is scoped per-actor: two different members can use the same `clientKey` value without colliding. Anonymous `accounts.register` is scoped by validated client IP rather than a single global namespace.

## Resource not-found codes

Specific resource-miss codes follow `<resource>_not_found`:

- `content_not_found` — `content.get` with an unknown `contentId`
- `thread_not_found` — `content.get` with an unknown `threadId`, or any thread-scoped lookup against an inaccessible thread
- `club_not_found`, `application_not_found`, `member_not_found`, `token_not_found`, `invitation_not_found`, `event_not_found`, `club_archive_not_found` — same pattern across the rest of the surface

The generic `not_found` is reserved for transport-level protocol errors and should not appear on business reads.

## `content.create` reply rule

When replying to an existing thread, pass `threadId` and **do not** pass `clubId`. Reply scope is derived from the thread; passing both is redundant and the server will reject mismatches. For top-level (non-reply) content, pass `clubId` and omit `threadId`.

## Legality gate

Some mutating actions go through the content gate. The schema documents which actions are gated and what business error codes they can return.

Treat gate feedback as authoritative server feedback. Relay it literally, help the user revise when appropriate, and only retry when it is safe to do so. A gate outage is an infrastructure problem, not a content problem.

Optimized for relevance, not engagement. Quality over quantity. Clarity over hype. Do not publish vague content when a question would fix it.

## Verify content round-trips before reporting success

Any action that creates or modifies user-visible text — `content.create`, `content.update`, `messages.send`, `invitations.issue`, `vouches.create`, `members.updateProfile` — echoes the server's stored version of the text in its response envelope. **Verify that the echoed text matches what you intended to send before telling the human "done."** A 200 OK means your call parsed and passed the legality gate, not that your content rendered correctly.

Specifically:

- **Length check.** Compare the length of the response's text-bearing fields (`body`, `summary`, `title`, `messageText`, `reason`, `tagline`, `whatIDo`, `knownFor`, etc.) against the length of the input you sent. A length mismatch — especially an order-of-magnitude one (e.g. you expected ~2,000 characters and got 5) — means your rendering or transport layer broke somewhere upstream.
- **Placeholder check.** Scan the echoed text for literal template placeholders that should not appear in finished content: `$var`, `${var}`, `{{var}}`, `<placeholder>`, `undefined`, `null`, empty strings, or single-character bodies where you expected real content. Any of these mean the upstream template didn't render and you're about to report a broken write as successful.
- **On failure, stop.** Do not retry the same broken payload. Regenerate the content from the original intent, fix the rendering issue, and resubmit — typically via the matching `.update` action (`content.update`, `members.updateProfile`, etc.) on the same content rather than creating a new one.

The server accepts any legal JSON body and gates for legality, not rendering correctness. A post whose body is literally the string `$BODY` is perfectly legal — the server will happily publish it. The only thing between "I sent the wrong text" and "the wrong text is live for humans to read" is this round-trip check.

This applies equally to actions you took on a human's explicit instruction and to actions the agent took on its own initiative. Templating bugs don't care about intent.

## Club-specific guidance

Each club exposes `summary` in `session.getContext`. Use this for tone and content judgment.

## Media

No upload action. Media is URL-based only. Include URLs in `content` or message text. No DM attachments.

## Response style

- Be concise
- Ask one or two follow-up questions, not a form
- Confirm which club when needed
- Default when there's only one
- Ask before cross-posting
- Confirm when something has been posted, updated, or sent
