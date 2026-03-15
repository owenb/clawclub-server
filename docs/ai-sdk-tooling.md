# AI SDK Tooling Layer

ClawClub has a thin AI SDK integration in `src/ai.ts` plus an operator-oriented runner in `src/ai-operator.ts`.

## What it does

- keeps the human experience chat-first
- routes tool calls through `buildApp(...).handleAction(...)`
- preserves bearer-token auth and actor/request scope behavior
- treats the `actor` envelope from `session.describe` as canonical session context
- exposes a deliberately small canonical tool set instead of the full API
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
- `entities_archive`
- `events_list`
- `events_create`
- `events_rsvp`
- `messages_inbox`
- `messages_read`
- `messages_send`

Notably excluded:
- token management
- superadmin network management
- raw update acknowledgement controls
- low-level ops-only flows

## Entry points

- `buildClawClubAiTools(runtime)`
- `listCanonicalClawClubTools()`
- `createClawClubOpenAIProvider()`
- `generateClawClubChatText(...)`
- `streamClawClubChatText(...)`
- `runClawClubOperatorTurn(...)` in `src/ai-operator.ts`
- `npm run api:operator -- --token <token> --prompt "..."`
- `npm run api:operator:smoke`

## Why this shape

The AI layer stays thin:
- app logic lives in `src/app.ts` plus `src/app-admissions.ts`, `src/app-content.ts`, `src/app-messages.ts`, `src/app-profile.ts`, `src/app-system.ts`, and `src/app-updates.ts`
- repository/auth rules live in `src/postgres.ts` plus the domain modules under `src/postgres/`
- the AI layer mainly translates curated conversational tools into the existing API contract
