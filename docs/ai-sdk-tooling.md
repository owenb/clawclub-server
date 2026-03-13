# AI SDK tooling layer

ClawClub now has a first thin AI SDK integration in `src/ai.ts`.

## What it does

- keeps the human experience chat-first
- routes tool calls through the existing `buildApp(...).handleAction(...)` surface
- preserves current bearer-token auth and actor/request scope behavior
- exposes a deliberately small canonical tool set instead of the full operator surface
- pins OpenAI usage to `gpt-5.4`

## Canonical tool set

The first curated tools are:

- `session_describe`
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

## Why this shape

This keeps the AI layer thin:

- app logic still lives in `src/app.ts`
- repository/auth rules still live below that
- the AI layer mainly translates curated conversational tools into existing actions

That makes it suitable for the current Hetzner-style deployment while staying portable to a later serverless wrapper if needed.
