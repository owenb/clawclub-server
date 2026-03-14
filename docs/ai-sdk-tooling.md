# AI SDK tooling layer

ClawClub has a thin AI SDK integration in `src/ai.ts` plus an operator-oriented runner in `src/ai-operator.ts`.

## What it does

- keeps the human experience chat-first
- routes tool calls through the existing `buildApp(...).handleAction(...)` surface
- preserves current bearer-token auth and actor/request scope behavior
- treats the `actor` envelope from `session.describe` as the canonical session context
- exposes a deliberately small canonical tool set instead of the full operator surface
- pins OpenAI usage to `gpt-5.4`

## Canonical tool set

The first curated tools are:

- `session_describe`
- `memberships_review`
- `applications_list`
- `applications_create`
- `applications_transition`
- `members_search`
- `profile_get`
- `profile_update`
- `entities_list`
- `entities_create`
- `events_list`
- `events_create`
- `events_rsvp`
- `messages_inbox`
- `messages_read`
- `messages_send`

Notably excluded for now:

- token management
- raw delivery worker/executor controls
- membership moderation/admin flows
- superadmin network management

Those can be added later when there is a clearer conversational/operator need.

## Entry points

- `buildClawClubAiTools(runtime)` → AI SDK tool map
- `listCanonicalClawClubTools()` → inspect the curated tool catalog
- `createClawClubOpenAIProvider()` → OpenAI provider with env-backed API key
- `generateClawClubChatText(...)` / `streamClawClubChatText(...)` → model + tool orchestration helpers
- `runClawClubOperatorTurn(...)` in `src/ai-operator.ts` → thin operator-oriented runner for one realistic server-side turn
- `npm run api:operator -- --token <token> --prompt "..."` → minimal CLI wrapper for ops/admin usage
- `npm run api:operator:smoke` → prove the operator runner can exercise a realistic admissions check path

## Why this shape

This keeps the AI layer thin:

- app logic lives in `src/app.ts` plus the domain handlers in `src/app-admissions.ts`, `src/app-content.ts`, `src/app-deliveries.ts`, `src/app-messages.ts`, `src/app-profile.ts`, and `src/app-system.ts`
- repository/auth rules live in `src/postgres.ts` plus the domain modules under `src/postgres/`
- the AI layer mainly translates curated conversational tools into existing actions

That makes it suitable for the current Hetzner-style deployment while staying portable to a later serverless wrapper if needed.
