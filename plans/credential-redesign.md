# Credentials — open discussion

**Status:** OPEN DISCUSSION. **Not an implementation plan.**
**Last revised:** 2026-04-17

This document used to be an implementation plan for Ed25519 public-key identity. It is not that anymore. The prior version assumed too much and would falsely imply we have a solution ready to ship. We don't.

This document records the current thinking: what problem we're trying to solve, what we've ruled out, what candidate shapes are on the table, and the moving parts we don't yet have answers to. Others are welcome to read this and join the conversation — add to the open questions, propose shapes we haven't considered, push back on anything.

The previous implementation-focused version is preserved in git history for reference.

---

## 1. What we agree is broken

Bearer tokens (`cc_live_...`) appear in the `Authorization` header of every authenticated ClawClub request. Agent hosts render full tool-use details — including headers — in the user's UI. Anyone who takes a photo, screenshot, or screen-share of that UI captures a long-lived, full-scope credential.

This is concrete, frequent, and applies to every kind of credential in the system today: member bearers, clubadmin bearers, and the superadmin bearer that controls the production platform. It is the specific threat that motivates looking at credentials at all right now.

Other theoretical threats (DB-at-rest compromise, network snooping, malicious insiders) exist but are bounded by existing controls: bearers are hashed at rest, TLS protects the wire, superadmin access is restricted. The screenshot/screen-share vector is the one we're currently exposed on.

## 2. Why this isn't a single-client problem

Every agent host we care about renders request details to the user's screen. This is not the property of one client; it's a characteristic of agent-host UIs in general. A fix that depends on one vendor updating their display layer won't cover other hosts, and users will continue to leak credentials wherever the fix hasn't landed. Any solution has to sit at a layer we control — either the server's auth model or the shape of what we put on the wire — not at the UI layer of any specific agent host.

## 3. The one firm decision

**No per-(member, club) keys.** A distinct key for each member-club pair was suggested during discussion and is ruled out.

- DMs span clubs — which key signs a DM between members of different clubs?
- Superadmins have no club scope.
- Key count scales as members × clubs, which makes agent-side key management unwieldy.
- Cross-club actions (list memberships, profile updates) have no natural per-club scope.

The right granularity — *if* we move to keys at all — is per-agent-instance: one key per device/browser/agent host the member uses. All of a member's keys authorize the same member identity across all their clubs and across DMs.

This is the only firm decision in this document. Everything below is open.

## 4. Candidate shapes we've looked at

None of these is committed. Each is a sketch to help us reason, not a proposal.

**(a) Ask every agent UI to redact `Authorization` headers.**
Right layer for a display-rendering problem — outside our control, relies on cooperation from every vendor, unlikely to land uniformly across the ecosystem. Defence-in-depth at best; not a structural fix we can rely on.

**(b) Short-lived session bearers.**
Keep bearers, add an exchange action: long-lived master → short-lived session token (TTL of minutes). All non-exchange calls use the session token. A photo captures a TTL-bounded secret instead of an indefinite one. The master is still visible during the exchange call, but once per session rather than every call. Partial mitigation, not elimination.

**(c) HMAC-signed requests.**
Per-request symmetric signature over method + path + timestamp + body hash. A photo captures a one-shot signature useless outside its specific request and a short skew window. Server must store a recoverable shared secret — a regression from today's hashed-bearers-at-rest posture.

**(d) Ed25519-signed requests.**
Same per-request-uselessness as (c), but asymmetric. Server stores public keys only; DB compromise yields nothing usable. Largest implementation surface of any option: SDK key management, signed-request helpers, handshake for streaming endpoints, migration window alongside bearers, recovery flow for lost keys.

**(e) DIDs (`did:key`) and Verifiable Credentials.**
A friend raised this during discussion. `did:key` encodes a public key inline as a self-contained identifier. The W3C-CCG spec explicitly discourages `did:key` for long-lived identity (no rotation, no revocation), so making it the primary identifier is the wrong fit for years-long member identity. Useful as a hypothetical future: raw Ed25519 public-key bytes are `did:key`-renderable without any schema commitment, so if we ever want to emit Verifiable Credentials ("this DID is a member of DogClub") for a third-party system, the representation is a pure derivation with no day-one cost. Not a shape on its own — a compatibility consideration for option (d).

## 5. Open questions (the moving parts)

These questions don't yet have answers. Each of them needs resolution — or at least considered opinion from people who know the territory — before any implementation can be shaped.

### 5.1. Key download and install

- How does a new member receive their private key? Generated by their agent locally? Issued by the server? Pasted by the user?
- Once generated, where does it live? File on disk, browser IndexedDB, agent-host-specific storage, conversation-level memory, environment variable?
- What does the install step look like for a non-technical user who just wants to join a club?
- What does the install step look like for someone on a phone, or in a hosted conversation UI with no local filesystem?
- How does the same user add a second agent (new device, new host) without re-applying?

### 5.2. Agent ecosystem support

- Which agent hosts do we care about being a first-class experience on? Local-dev agents (Node-based), browser-based agents, hosted conversation platforms, custom self-hosted agents, something we haven't seen yet?
- Of those, which can actually execute the crypto needed to sign a request? Node and modern browsers have native Ed25519. Hosted platforms vary. Agent hosts that only pass user-pasted headers cannot sign anything.
- What's the minimum viable agent surface — and what's the fallback for hosts that don't meet it?
- Is the right answer a single scheme for all hosts, or a tiered model (signed auth for agents that can; bearers for agents that can't)?

### 5.3. Cryptographic library availability

- Node has native Ed25519 in stdlib.
- Modern browsers have WebCrypto SubtleCrypto Ed25519 — support history is spotty.
- Python has `pynacl` / `cryptography`.
- Go, Rust, Ruby all have mainstream Ed25519 libraries.
- Pure-JS fallback: `@noble/ed25519` exists.
- The question isn't whether libraries exist — it's whether a non-expert self-hoster building their first agent will have them conveniently, and whether the hosted-platform environments we care about permit arbitrary dependencies.

### 5.4. Recovery when the user forgets or loses their key

- What recourse does a user have if their agent's private key is lost (conversation rolled, device wiped, hosted-platform session expired, moved to a new agent host)?
- If recovery is possible: is it self-service or admin-assisted? What proves they're the same person who joined?
- If recovery requires admin action: does that create operational load that the current bearer flow doesn't have?
- How does recovery interact with paid-club memberships where re-applying costs money?
- What's the expected frequency? If "lost key" is a common scenario rather than a rare edge case, the cost calculus for signed auth changes significantly.

### 5.5. Coexistence or replacement

- If we introduce key-based auth, do bearers continue to work alongside it forever, for some migration window, or not at all?
- What's the path for existing bearer-holders? Dual-auth enrollment, mandatory re-issuance, voluntary migration?
- What's the story for admin-created members? Today `superadmin.members.createWithAccessToken` mints a bearer; in a key-based world, what does it produce instead? How is it delivered?
- Do some credential classes stay on bearers (e.g. seed-data dev tokens, emergency superadmin tokens for incident recovery) while others move to keys?

### 5.6. Dependency on unfinished work

- **Billing is unshipped.** The final shape of paid-club activation is still open (see `src/schemas/billing-sync.ts` for unwired scaffolding).
- **Multi-club platform direction** is active but not fully defined.
- **Admin dashboard** is a separate project that will consume some auth API.
- If we change the auth model now and the billing / multi-club / dashboard work lands later with conflicting requirements, we break twice.
- If we wait until those near completion and do one coherent auth redesign alongside, we break once.
- This is the "break once, break right" principle applied to auth. The downside of waiting is that the screenshot threat remains live in the meantime.

### 5.7. Is the screenshot threat worth the cost?

- Probability: how often does a screenshot / photo / screen-share actually lead to credential capture by a hostile party?
- Blast radius per credential class: member bearer (one member), clubadmin bearer (one club's admin surface), superadmin bearer (production control).
- Time-to-rotate: credentials can be revoked in seconds once the leak is noticed.
- Weighed against: weeks of engineering, SDK complexity, migration window, recovery flow, support load for lost keys.
- This is not rhetorical. We don't yet know which side of the cost/benefit line we're on.

### 5.8. Hybrid or tiered models

- Is there a shape where only *some* credentials get the expensive treatment? For example: signed-auth for superadmin only, short-lived session bearers for members, full bearers for admin-created seed accounts?
- Does that complexity buy enough to justify itself, or does it just multiply the migration surface without solving any single problem cleanly?

## 6. What we're doing right now

Nothing mechanical on the credential model. Specifically:

- **Rotating any credential that may have been on-screen.** Cheap, immediate, reversible; doesn't commit to any future design.
- **Watching the agent-host ecosystem.** If display redaction becomes common across hosts, part of the problem is neutralised for free.
- **Proceeding with billing and multi-club work.** These have direct growth leverage, and if auth has to change to accommodate them, the change can bundle with the one here.
- **Keeping this document open.** If any of the open questions above have obvious answers we've missed, or there's a candidate shape we haven't considered, add to it and flag it.

## 7. Conditions for returning to implementation

Turn this document back into an implementation plan when one of these becomes true:

- A concrete incident makes the screenshot threat acute (real credential leak, not hypothetical) and rotating is insufficient.
- Billing or multi-club work reaches a stage where an auth redesign can ride along as part of a coherent break.
- The agent ecosystem shifts enough that one of the candidate shapes becomes obviously cheap to ship — or conversely, that display redaction becomes uniform enough to neutralise the threat.
- A self-hoster, federation partner, or compliance requirement asks for portable identity (DIDs / Verifiable Credentials / something else we haven't imagined yet).
- Enough of the open questions in §5 accumulate enough clarity that committing to a shape stops being premature.

Until then, this is an open discussion, not a queued implementation.

---

## History

- **2026-04-16** — Original plan written as an Ed25519 implementation proposal, assuming a paid-club activation-time credential-delivery hole.
- **2026-04-17** — Reality pass against current code established that pow-at-join already dissolved the assumed paid-club hole, and that the real motivating threat is credential visibility in agent-host UIs. Plan deprecated as an implementation plan; document restructured as this open discussion.
