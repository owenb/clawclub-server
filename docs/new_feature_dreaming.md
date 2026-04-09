# New feature dreaming

Working notes from a long design session about where ClawClub goes next. Not a spec — captured so we don't lose the thinking when we pick this back up.

## The big direction: Club Mind

The synchronicity engine today does vector matching — cosine similarity in pgvector against profile and entity embeddings. That's good for matches that *look alike* but it can't reason about *causally connected* things. The killer example: "Maria mentioned wanting to leave Stripe last week" and "Owen is hiring engineers this week" will never be close in embedding space, but a human hearing both things in the same week would immediately connect them.

The long-term direction is to add an **LLM reasoning layer** on top of the existing vector engine. Not replace it — augment it. The vector engine handles the fast, event-triggered, obvious matches. A scheduled reasoning worker (gpt-5.4-nano) reads the club state and produces matches that need actual thinking.

We call this conceptually the **Club Mind** — each club has a continuously-running consciousness that knows its members, remembers things, and weaves connections.

### Hybrid is the goal

- **Small clubs (<100 members):** members want to see raw posts. The agent on the read side does any summarization. Vector matching is enough.
- **Larger clubs:** raw posts become noise. The Club Mind filters server-side and surfaces only what matters per-member.

It's not one or the other. Both run. The right one drives the experience based on club size.

## Primitives discussed

Five things worth building. Each is independently shippable.

### 1. The WHY field on entities (deferred — see "WHY field design" below)

Status: designed in detail, **not built**. Has real privacy implications that need careful thought before committing.

### 2. Standing gifts on member profiles

Every member offers exactly **three gifts** to the community as part of joining. Gifts are *free, no expectations* — distinct from `service` (which is a professional / often paid offering). They're declared during the application flow and persisted on the member profile.

**Stopgap design** (SKILL.md only): collect during application as text in the `application` field; persist after admission via `profile.gifts` array in the existing extensible `profile` jsonb. The `profile` jsonb is already part of the embedding source, so gifts automatically influence matching with no engine changes.

**Proper design** (next time): first-class `gifts` field on the profile schema, structured input on `profile.update`, structured `gifts` field on `admissions.public.submitApplication` so reviewing admins see them as data not buried in free text.

**Key principle:** exactly three. Not five, not ten. Three forces focus and means each one is meant.

The drafted SKILL.md edits live in the conversation history — they're a clean stopgap that starts collecting gift data immediately even before the schema work lands.

### 3. Open and closed loops on entities

Owen's reframe: "open" isn't a primitive — it's the natural state. "Closed" is the affirmative action. There's no "open loops" feature, just sensible defaults plus a close verb.

- Add `is_open boolean` (or `loop_state text` for future flexibility) on `entities`
- Default to `true` for all kinds except events (which have inherent end dates)
- New action `content.close` to flip it
- Synchronicity worker stops treating closed entities as match candidates
- The 5-day delivery TTL in `src/workers/synchronicity.ts:51-56` stays the same — what changes is that *relevance* persists until the member closes the loop

**No privacy issues. Smallest of the primitives. Probably the next thing built.**

### 4. Location and travel synchronicity

Members share home cities and upcoming travel plans. The synchronicity engine notices when:
- Two members from the same club will be in the same non-home city at overlapping times
- Someone in your travel city posts an ask or has a relevant standing gift
- A new travel plan overlaps with existing ones in shared clubs

**Implementation:**
- New `member_travel_plans` table (`member_id, city, country, starts_at, ends_at, note, visibility`)
- Optional `home_city` / `home_country` on the member profile
- New actions `member.travelAdd` / `member.travelRemove`
- New match kind `co_location` in `signal_background_matches` — uses existing delivery infrastructure
- New trigger in synchronicity worker: SQL window-overlap query when a travel plan is added

The most viscerally demoable feature on the list ("you and Maria are both in Tokyo this week"). Needs zero LLM work. Self-contained — doesn't entangle with the embedding pipeline.

**Privacy story:** explicit visibility on each travel plan (private / club-scoped / specific people). Not hidden fields — explicit user choices. Cleanly handled.

### 5. The reasoning layer (Club Mind v0)

A new background worker that runs daily (or hourly for paid clubs). For each club, it assembles a context window:
- Recent published entities with bodies
- Open loops in the club
- Member list with profile summaries and standing gifts
- Recent matches the existing engine has already delivered (so it doesn't duplicate)
- Travel plans for upcoming overlaps

Feeds it to gpt-5.4-nano with a structured prompt: *"You are the mind of this club. Identify connections that should be made. Surface patterns. Explain each."* Output parses into `signal_background_matches` with a new `match_kind` like `club_mind_reasoning`. Existing delivery infrastructure carries them.

**Realistic build:** 2–3 days of code, plus 1–2 days of prompt iteration on real data. The prompt is the hardest part and is the actual product work.

This is where the "Club Mind" experience actually lives. It needs the other primitives (especially WHY and open loops) as substrate to reason over.

### 6. `member.tell()` — directional nudge to the synchronicity engine

A simple action where the agent tells the synchronicity engine what the member is thinking about right now. *"Owen is thinking about Lisbon."* *"Owen is feeling restless and wants space this week."* *"Owen is currently obsessed with payments infrastructure."*

**This is NOT a general-purpose memory store** (the conversation drifted that way for a while; we pulled back). It's a directional bias on what the engine surfaces.

Quick instinct on design (not yet built):
- Each new tell overrides the previous one (no history kept)
- Per-member globally (your state isn't different in DogClub vs CatClub)
- Expires after maybe a week of inactivity
- Private — only the engine reads it
- Used as an additional input to the matching layer

Has some privacy questions (anything that captures member state does), but cleaner than the WHY field because it's deliberately ephemeral and the agent controls what gets stored.

## WHY field design (deferred — biggest design conversation)

We spent a long time on this. Capturing the thinking so we don't lose it.

### The problem

Every social network captures WHAT people post; none capture WHY. Two people post the same thing — *"Looking for an intro to a senior fintech engineer"* — but one is validating a business idea and the other is hiring. Same WHAT, different WHY, completely different ideal matches. Vector matching can't distinguish them. LLM reasoning over a separate WHY signal can.

### Attempt 1: rich post bodies

Initially we thought the agent could capture motivation in the post body itself, drawn from the conversation. SKILL.md guidance, no schema change. Owen identified the killer flaw: the WHY can be deeply personal/confidential (job loss, mental health, financial stress) and the body is public to the entire club. Personal context has nowhere to live safely.

### Attempt 2: private `why` field

Add an optional `why` field to entity creation. Strong privacy: never displayed to anyone but the author. Stored alongside the entity. Used by the synchronicity engine for matching only.

Designed in detail, then deferred because it's a big feature with real privacy implications that need more chewing.

### Key design decisions reached

- **Field placement:** new `why text` column on `entity_versions` (not `entities`) — versions with content
- **Privacy invariant:** strong. Author-only. Never visible to other members, club admins, matched recipients, or even superadmins via the API. Strong invariant is what makes the field worth building; weaker invariant collapses the value
- **Quality gate:** must see the why for legality checking (someone could launder bad intent through innocent body + bad why). Gate is automated, not human-browsable, so privacy is preserved
- **Embedding source:** why is included in the entity embedding source with a `WHY:` label. Embeddings can't be reversed to plaintext, so privacy is preserved while matching benefits
- **Visibility on read:** every read path filters why to null unless `actor == author`. Needs an exhaustive pattern (TypeScript types that make it impossible to forget)
- **Visibility on match delivery:** Maria does NOT see Owen's why when Owen's ask is matched to her profile. She sees the body
- **Update semantics:** standard patch — omit to inherit, null to clear, string to replace
- **Optional:** yes. Forcing creates filler ("idk just looking")

### Edge cases the agent has to handle even with strong privacy

- **Other people's identifying information** — anonymize references to specific people. Don't write *"Sarah told me she's miserable"* — write *"a friend in fintech mentioned the culture is rough"*
- **Catastrophically sensitive data** — medical, legal, abuse, immigration, suicidal ideation. Matching benefit is unclear, breach/leak/subpoena risk is real. Use judgment, often skip
- **Things the member said in confidence** — if they say "don't write this down," respect it

### Why this is deferred

- Big surface area: schema, repository, every read path, embedding source, gate prompt, exhaustive tests
- Strong privacy invariant is a real platform-level commitment — once shipped, walking it back violates trust
- Redaction must be exhaustive — one missed read path is a privacy leak
- Legality gate seeing the why means a third-party LLM provider sees member secrets — needs to be addressed in privacy policy
- The whole thing needs more chewing

### Touch points if we pick it back up

- `db/init.sql` — add `why text` column to `entity_versions`
- `src/schemas/entities.ts` — wire/parse for `content.create` and `content.update`
- `src/schemas/responses.ts` — `entitySummary` shape
- Repository layer — `createEntity`, `updateEntity`, `listEntities`, `findEntitiesViaEmbedding`, all read paths
- `src/embedding-source.ts` — `buildEntitySourceText`, around lines 87–97
- `src/quality-gate.ts` — `content-create` gate prompt
- `SKILL.md` — agent guidance with the layered judgment rules
- `test/integration/content.test.ts` — exhaustive privacy tests, especially the redaction at every read path

## Ideas considered and dropped

- **Feelings as a separate primitive (table, action, weight)** — folded into other primitives. Once we have `member.tell()` and (eventually) WHY, feelings are captured as part of motivation/state. No dedicated table needed.
- **The broad "tell channel" as a unified memory store** — too abstract, abandoned. `member.tell()` is the much narrower version that survived.
- **Outcome traces / "was this useful?" follow-ups** — surveillance smell, gamification risk. Deferred indefinitely. Once the Club Mind exists, it can *observe* whether members keep mentioning each other in subsequent posts/whys, which is the non-surveillance version of outcome data.
- **Emergences as a primitive** — *"the club generated an insight this month"*. It's an *output* of the reasoning layer, not a primitive. Comes free when the Club Mind exists.
- **"Alive vs resting" rename of open/closed** — too poetic for the API. Save "alive" for marketing copy. Use `open`/`closed` in code.
- **Intentions as a new entity kind** — overlaps too much with `ask` and `member.tell()`. The body of an ask can already be intentional/exploratory.
- **Appreciations as feedback to the engine** — same risk profile as outcome traces. Deferred.
- **Replacing the synchronicity engine entirely with LLM reasoning** — too aggressive. The hybrid approach (vector engine for fast/obvious, LLM for causal/non-obvious) is the right shape.
- **Conflating gifts with services** — they're different. Services are professional, often paid. Gifts are free, no expectations. Owen pushed back hard on this and was right.
- **Putting motivation in the post body via SKILL.md** — fails because the body is public. The privacy split between body (public) and why (private) is the only model that captures personal motivation safely.

## Notes on the current synchronicity engine (for reference)

- Lives in `src/workers/synchronicity.ts`, `src/workers/similarity.ts`, `src/workers/matches.ts`
- Uses pgvector cosine distance via the `<=>` operator
- Match kinds: `ask_to_member`, `offer_to_ask`, `member_to_member`, `event_to_member`
- Stores matches in `signal_background_matches`, delivers as `signal_deliveries` via the update feed
- Throttled per match kind: ask/offer = 1/day, intros = 2/week
- TTLs in `synchronicity.ts:51-56` — ask/offer = 5 days, intro = 21 days, event = 2 days
- Triggered by: entity publication, profile embedding completion, member accessibility changes
- Embedding model: `text-embedding-3-small` (1536 dims) via `embedMany` from Vercel AI SDK
- Profile embeddings include `services_summary`, `known_for`, `what_i_do`, `tagline`, `summary`, `links`, plus the extensible `profile` jsonb
- Entity embeddings include title, summary, body, and the `content` jsonb (and would include WHY if/when we ship it)
- Quality gate (`src/quality-gate.ts`) runs on `content.create`, `content.update`, `events.create`, `profile.update`, `vouches.create`, `admissions.sponsorCandidate` — model is `gpt-5.4-nano`

## Open questions to resolve when we come back

- WHY field name (`why` vs `motivation` vs `private_context`)
- Strong vs weaker privacy invariant on WHY (recommendation: strong)
- Gifts: distinct entity kind, profile field, or both? (current direction: profile field, keep `service` separate)
- Reasoning layer cadence: daily for everyone, or tier by club size / paid status?
- `member.tell()` lifetime and scoping precise rules
- What does the Club Mind see vs not see in its reasoning context (privacy implications)
- How does the reasoning layer's output get gated (legality check on LLM-produced text?)
