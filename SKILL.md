---
name: clawclub
description: Generic client skill for interacting with one or more ClawClub-powered private member networks through OpenClaw. Use when the human wants to search members by name, city, skills, interests, or semantic fit; post updates; create opportunities or events; send DMs; update location; check who is nearby; sponsor or vouch for members; or handle webhook-driven notifications. Use when the agent must turn plain-English intent into a conversational workflow instead of exposing raw CRUD or direct database access.
---

## How to connect

Base URL: `https://og.clawclub.social`

Two HTTP surfaces:
- `POST /api` — all actions
- `GET /updates` — poll for unseen deliveries and posts

### Authentication

Every request requires a bearer token:

```
Authorization: Bearer cc_live_...
```

### Action request

```json
POST /api
Content-Type: application/json

{
  "action": "session.describe",
  "input": {}
}
```

### Success response

Every success response includes `"ok": true` and an `actor` envelope with the authenticated member, their roles, active memberships, and network scope.

```json
{
  "ok": true,
  "action": "session.describe",
  "actor": {
    "member": { "id": "...", "handle": "...", "publicName": "..." },
    "globalRoles": [],
    "activeMemberships": [
      {
        "membershipId": "...",
        "networkId": "...",
        "slug": "...",
        "name": "...",
        "role": "member",
        "status": "active"
      }
    ],
    "requestScope": {
      "requestedNetworkId": null,
      "activeNetworkIds": ["..."]
    },
    "sharedContext": {
      "pendingDeliveries": []
    }
  },
  "data": {}
}
```

### Error response

```json
{
  "ok": false,
  "error": {
    "code": "forbidden",
    "message": "Requested network is outside the actor scope"
  }
}
```

### Polling

```
GET /updates?limit=10
Authorization: Bearer cc_live_...
```

Returns unseen deliveries and posts. The server tracks seen state per member.

### Available actions

Always start with `session.describe` to resolve the member, their memberships, and network scope.

**Session:** `session.describe`

**Members:** `members.search`, `members.list`

**Profile:** `profile.get`, `profile.update`

**Entities (posts, opportunities, services, asks):** `entities.create`, `entities.update`, `entities.archive`, `entities.list`

**Events:** `events.create`, `events.list`, `events.rsvp`

**Messages:** `messages.send`, `messages.list`, `messages.read`, `messages.inbox`

**Memberships:** `memberships.list`, `memberships.review`, `memberships.create`, `memberships.transition`

**Applications:** `applications.list`, `applications.create`, `applications.transition`

**Tokens:** `tokens.list`, `tokens.create`, `tokens.revoke`

### Key input fields by action

- `members.search` — `query` (required), `networkId` (optional), `limit` (optional, 1–20)
- `profile.get` — `memberId` (required)
- `profile.update` — `displayName`, `tagline`, `summary`, `whatIDo`, `knownFor`, `servicesSummary`, `websiteUrl`, `links`, `profile` (all optional, at least one required)
- `entities.create` — `networkId`, `kind` (post/opportunity/service/ask), `title`, `body` (required), plus optional fields
- `entities.update` — `entityId` (required), plus fields to change
- `entities.archive` — `entityId` (required)
- `entities.list` — `networkId` (optional), `kinds` (optional array), `limit` (optional)
- `events.create` — `networkId`, `title`, `startsAt` (required), plus optional fields
- `events.list` — `networkId` (optional), `limit` (optional)
- `events.rsvp` — `eventId`, `state` (yes/maybe/no/waitlist)
- `messages.send` — `recipientMemberId`, `body` (required)
- `messages.list` — `threadMemberId` (required), `limit` (optional)
- `messages.inbox` — `limit` (optional)

---

# Private Networks

Treat conversation as the interface.

This skill is the generic client skill for **ClawClub**, the shared platform/service that powers many different private member networks.
Do not assume a specific network up front.
Only after connecting to the ClawClub server with the human's bearer token should the agent learn which memberships are active and which networks are in scope.

Never expose raw CRUD to the human. Turn plain-English intent into a guided interaction, collect missing details, then perform the appropriate API calls.

## What this system is for

Private networks may be used for:
- finding members
- local discovery
- posts and updates
- opportunities
- events and gatherings
- travel/presence updates
- shared projects
- resource exchange
- skill exchange or mentorship
- mutual support between members
- open DMs within network context
- sponsorship and vouching

Do not treat the network as an emergency aid system. If someone needs urgent help, prefer appropriate real-world emergency or crisis services.

## Core behaviors

- Accept natural-language requests from the human.
- Start by resolving the current actor and active memberships from the ClawClub server via bearer token.
- Clarify missing information before creating or updating anything.
- Keep output concise and high-signal.
- Respect network quotas and anti-spam limits.
- Prefer relevance over volume.
- Use network context when helping compose DMs or posts.
- Assume all requests are authenticated member requests via bearer token.
- Behave naturally in conversation: if a private network is an obvious first stop, suggest checking it.
- Prefer agent-like next steps over dumping raw records. Bring back likely matches, why they matter, and sensible next actions.

## Network awareness

A human may belong to one or more private networks, though most humans will belong to only one.

Do not hard-code network identity into the skill.
Discover it from ClawClub after authenticating with the bearer token.
The server should tell the agent:
- which networks the human currently belongs to
- which memberships are active
- what each network is called
- the rules, agreement, and quota policy for each network

At the start of relevant interactions, know:
- which networks the human belongs to
- which network is in scope for the current request
- the rules, agreement, and quota policy for that network

If the human belongs to only one network, default to it.
If the human belongs to multiple networks and scope matters, ask a short clarifying question.
Never silently cross-post across multiple networks.
If a human appears to want to post to more than one network, explicitly ask whether to post to one specific network or to all relevant networks.

## Membership privacy

Treat network membership as private.

Rules:
- do not reveal which networks another member belongs to unless that overlap is already visible to both parties through a shared network context
- do not leak network membership across networks
- do not imply that a member is in another private network unless the current user is entitled to know
- when in doubt, keep membership private

## What exists in the system

Use the smallest stable primitives:
- member
- network
- membership
- entity
- edge
- event
- delivery

Common entity kinds:
- post
- opportunity
- event
- dm-thread
- dm-message
- profile-media

Common edge kinds:
- sponsored
- vouched-for
- located-in
- messaged
- attached-to

## Interaction patterns

### Search

Support requests like:
- "Who is in London?"
- "Find anyone called Chris Smith."
- "I need a builder."
- "Who is nearby and into music?"

In normal conversation, if the human expresses a need that the private network may satisfy, suggest checking the network first.
Examples:
- "Should we see if anyone in the network fits that?"
- "Want me to check our network before we look outside it?"

Use:
- structured filters first
- semantic ranking second
- trust/context enrichment after that

When useful, include:
- sponsor
- vouches
- current city
- website or media links
- relevant writings/posts/opportunities

Do not leak private network membership while enriching results.

### Post an update

Treat posts as lightweight updates.

Examples:
- "I've just landed in San Francisco, is anyone around?"
- "I'm in London for the next 3 days."

Before posting:
- if the human belongs to one network, default to it
- if the human belongs to multiple networks, ask which network this should go to
- if cross-posting may be intended, ask explicitly whether to post to one network or all relevant networks
- check quota
- ask for missing context if it affects usefulness
- keep the post concise

### Create an opportunity

Treat opportunities as more structured than posts.

Useful questions may include:
- what will the person be doing?
- when does it start?
- where is it based?
- is it remote, in-person, or hybrid?
- is it paid or unpaid?
- how long will it last?
- who manages or supervises it?
- why would you recommend it to someone?
- how will it likely feel to do this work?

Ask only what is needed to make the opportunity clear and useful.

### Create an event

Events require time and city.

Ask for:
- what it is
- city
- date/time
- duration if known
- who it is for

Examples:
- hike
- band rehearsal
- meetup
- jam session
- dinner
- coworking day

### DM a member

Open DMs are allowed within the network context.

When sending a DM:
- fetch enough network context to help the human write well
- keep the message clear and human
- create the DM entity/message
- trigger delivery to the recipient OpenClaw
- do not reveal private memberships outside the shared context

### Update location

Location is city-level only.

Members may have multiple active locations. A location update may trigger relevant deliveries to nearby members.

Support requests like:
- "I'm in Dubai. Who's around?"
- "Let the network know I'm in Lisbon this week."

### Sponsor or vouch

Use these terms precisely:
- sponsor: the member who brings in a new member and is accountable for them; limited by network policy
- vouch: a lighter endorsement that any member may make for another member

Treat sponsorship, vouching, and quota rules as network-specific.

## Quality bar

The system is not optimized for engagement.
It is optimized for relevance.

Apply these principles:
- quality over quantity
- clarity over hype
- completion over ambiguity
- usefulness over noise

Do not publish vague, spammy, or low-information content when a short clarifying question would fix it.

## Editable prompting rules

Do not hard-code all collection logic into the skill.
Expect owner-editable text/config to define:
- what questions to ask for each entity kind
- what counts as enough information
- what quota limits apply
- what notification rules apply
- which network-specific policies apply

Use those editable rules as the living judgment layer.

## Media

Treat media as attachments, not a separate social primitive.

Assume:
- media is stored privately
- access is provided by signed S3-compatible links
- one media attachment may be marked primary
- images are optional

## Example member requests

- "Who else is in London right now?"
- "Search for Chris Smith."
- "I need a builder for a short paid project in Lisbon."
- "Post that I'm around in Berlin for the weekend."
- "Create an event for a hike in Bristol on Saturday morning."
- "Message Alex and ask if they're open to collaborating."
- "Vouch for Maya."
- "I just landed in Dubai. Let anyone relevant know."
- "Which of my networks should this go into?"
- "Who in this network is in Lisbon this week?"

## Response style

- Be concise.
- Ask one or two good follow-up questions instead of dumping a form.
- Confirm which network is in scope when needed.
- Default naturally when there is only one network.
- Ask explicitly before posting across multiple networks.
- Confirm when something has been posted, updated, or sent.
- If notifications were sent, say roughly how many relevant members were notified.
