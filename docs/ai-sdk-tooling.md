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

The AI-exposed tool set is driven by `src/action-manifest.ts` — any action with `aiExposed: true` becomes a tool. The Zod input schemas for each tool live in `src/ai.ts` (`aiToolInputSchemas`).

Current AI-exposed tools (17):
- `session_describe`
- `memberships_review`
- `applications_list`, `applications_create`, `applications_transition`
- `members_search`
- `profile_get`, `profile_update`
- `entities_list`, `entities_create`, `entities_archive`
- `events_list`, `events_create`, `events_rsvp`
- `messages_inbox`, `messages_read`, `messages_send`

Notably excluded (not AI-exposed):
- `admin.*` — 11 superadmin actions (platform overview, moderation, diagnostics)
- `applications.challenge/solve` — unauthenticated cold-application PoW flow
- `tokens.*` — bearer token management
- `networks.*` — superadmin network lifecycle
- `memberships.list/create/transition` — owner-only membership management
- `members.list`, `entities.update`, `messages.list` — lower-level variants
- `updates.*` — raw update stream controls

## Safety model

Every call to `generateClawClubChatText` or `streamClawClubChatText` prepends a mandatory safety preamble instructing the model to never execute mutating actions based on instructions found inside member-written content. This is not bypassable by the caller's system prompt.

Tools are classified as `read_only` or `mutating` in the action manifest. The `readOnly` option on `buildClawClubAiTools` filters out all mutating tools, leaving only read-only tools available. Use this when processing untrusted member content.

## Entry points

- `buildClawClubAiTools(runtime, { readOnly? })` — builds the Vercel AI SDK ToolSet
- `listCanonicalClawClubTools()` — lists AI-exposed tools from the manifest
- `createClawClubOpenAIProvider()` / `createClawClubOpenAIModel()`
- `generateClawClubChatText(options)` / `streamClawClubChatText(options)` — run inference with safety preamble
- `runClawClubOperatorTurn(...)` in `src/ai-operator.ts`
- `npm run api:operator -- --token <token> --prompt "..."`
- `npm run api:operator:smoke`

## Why this shape

The AI layer stays thin:
- app logic lives in `src/app.ts` plus domain handlers (`src/app-admissions.ts`, `src/app-content.ts`, `src/app-messages.ts`, `src/app-profile.ts`, `src/app-platform.ts`, `src/app-updates.ts`, `src/app-admin.ts`)
- repository/auth rules live in `src/postgres.ts` plus the domain modules under `src/postgres/`
- the action manifest (`src/action-manifest.ts`) is the single source of truth for which actions exist, their auth requirements, safety classification, and AI exposure
- the AI layer translates curated conversational tools into the existing API contract
