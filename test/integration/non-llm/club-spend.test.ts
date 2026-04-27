import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { DEFAULT_CONFIG_V1, type AppConfig } from '../../../src/config/index.ts';
import { processEmbeddings } from '../../../src/workers/embedding.ts';

let h: TestHarness;
let gateCalls = 0;

function buildSpendTestConfig(): AppConfig {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as AppConfig;
  config.policy.quotas.llm.clubSpendBudget.dailyMaxCents = 1;
  return config;
}

const spendGate = async () => {
  gateCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, 75));
  return {
    status: 'passed' as const,
    usage: {
      promptTokens: 11,
      completionTokens: 7,
    },
  };
};

function findSpendWindow(
  windows: Array<Record<string, unknown>>,
  name: 'day' | 'week' | 'month',
): Record<string, unknown> {
  const match = windows.find((window) => window.window === name);
  assert.ok(match, `missing ${name} spend window`);
  return match!;
}

function findTokenWindow(
  windows: Array<Record<string, unknown>>,
  name: 'day' | 'week' | 'month',
): Record<string, unknown> {
  const match = windows.find((window) => window.window === name);
  assert.ok(match, `missing ${name} token window`);
  return match!;
}

before(async () => {
  h = await TestHarness.start({
    llmGate: spendGate,
    config: buildSpendTestConfig(),
  });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('club spend budget', () => {
  it('records finalized gate spend and exposes it through superadmin.clubs.get', async () => {
    gateCalls = 0;
    const admin = await h.seedSuperadmin('Club Spend Admin');
    const owner = await h.seedOwner('club-spend-visible', 'Club Spend Visible');

    const created = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Budgeted post',
      body: 'A concrete post body for spend accounting.',
      clientKey: 'club-spend-visible-1',
    });
    const content = (created.data as Record<string, unknown>).content as Record<string, unknown>;
    assert.ok(content.id);
    assert.equal(gateCalls, 1);

    const spendRows = await h.sql<{
      action_name: string;
      usage_kind: string;
      status: string;
      reserved_micro_cents: string;
      actual_micro_cents: string;
      actual_prompt_tokens: number | null;
      actual_completion_tokens: number | null;
      actual_embedding_tokens: number | null;
      member_id: string | null;
      club_id: string;
    }>(
      `select action_name,
              usage_kind,
              status,
              reserved_micro_cents::text as reserved_micro_cents,
              actual_micro_cents::text as actual_micro_cents,
              actual_prompt_tokens,
              actual_completion_tokens,
              actual_embedding_tokens,
              member_id,
              club_id
       from ai_club_spend_reservations
       where club_id = $1
       order by created_at desc
       limit 1`,
      [owner.club.id],
    );
    assert.equal(spendRows.length, 1);
    assert.equal(spendRows[0]!.action_name, 'content.create');
    assert.equal(spendRows[0]!.usage_kind, 'gate');
    assert.equal(spendRows[0]!.status, 'finalized');
    assert.equal(spendRows[0]!.member_id, owner.id);
    assert.equal(spendRows[0]!.club_id, owner.club.id);
    assert.equal(spendRows[0]!.actual_prompt_tokens, 11);
    assert.equal(spendRows[0]!.actual_completion_tokens, 7);
    assert.equal(spendRows[0]!.actual_embedding_tokens, null);
    assert.ok(Number(spendRows[0]!.actual_micro_cents) > 0);
    assert.ok(Number(spendRows[0]!.reserved_micro_cents) >= Number(spendRows[0]!.actual_micro_cents));

    const detail = await h.apiOk(admin.token, 'superadmin.clubs.get', {
      clubId: owner.club.id,
    });
    const club = (detail.data as Record<string, unknown>).club as Record<string, unknown>;
    const aiSpend = club.aiSpend as Record<string, unknown>;
    const spendBudget = aiSpend.budget as Record<string, unknown>;
    assert.deepEqual(spendBudget, {
      dailyMaxCents: 1,
      weeklyMaxCents: 5,
      monthlyMaxCents: 18,
    });
    const spendUsage = aiSpend.usage as Array<Record<string, unknown>>;
    assert.equal(findSpendWindow(spendUsage, 'day').usedMicroCents, Number(spendRows[0]!.actual_micro_cents));
    assert.equal(findSpendWindow(spendUsage, 'day').remainingMicroCents, 1_000_000 - Number(spendRows[0]!.actual_micro_cents));

    const llmOutputTokens = club.llmOutputTokens as Record<string, unknown>;
    const tokenUsage = llmOutputTokens.usage as Array<Record<string, unknown>>;
    assert.equal(findTokenWindow(tokenUsage, 'day').usedTokens, 7);
  });

  it('rejects gated writes when the club spend budget would be exceeded', async () => {
    gateCalls = 0;
    const owner = await h.seedOwner('club-spend-blocked', 'Club Spend Blocked');

    await h.sql(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'finalized',
               999500, 999500, 0, 64, 0, 0, null, now(), now())`,
      [owner.club.id, owner.id],
    );

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Blocked by spend',
      body: 'This should fail before the gate runs.',
      clientKey: 'club-spend-blocked-1',
    });
    assert.equal(err.status, 429);
    assert.equal(err.code, 'quota_exceeded');
    assert.equal(gateCalls, 0);

    const spendCount = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from ai_club_spend_reservations
       where club_id = $1`,
      [owner.club.id],
    );
    assert.equal(Number(spendCount[0]!.count), 1);
  });

  it('serializes concurrent same-clientKey retries so the gate and spend charge run once', async () => {
    gateCalls = 0;
    const owner = await h.seedOwner('club-spend-replay', 'Club Spend Replay');

    const payload = {
      clubId: owner.club.id,
      kind: 'post' as const,
      title: 'Replay-safe post',
      body: 'This request is sent twice concurrently and should only bill once.',
      clientKey: 'club-spend-replay-1',
    };

    const [first, second] = await Promise.all([
      h.apiOk(owner.token, 'content.create', payload),
      h.apiOk(owner.token, 'content.create', payload),
    ]);

    const content = (first.data as Record<string, unknown>).content as Record<string, unknown>;
    const secondContent = (second.data as Record<string, unknown>).content as Record<string, unknown>;
    assert.equal(content.id, secondContent.id);
    assert.equal(gateCalls, 1);

    const spendRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from ai_club_spend_reservations
       where club_id = $1
         and action_name = 'content.create'`,
      [owner.club.id],
    );
    assert.equal(Number(spendRows[0]!.count), 1);

    const contentRows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from contents
       where author_member_id = $1
         and client_key = $2`,
      [owner.id, payload.clientKey],
    );
    assert.equal(Number(contentRows[0]!.count), 1);
  });

  it('worker sweep releases expired pending club-spend reservations', async () => {
    const owner = await h.seedOwner('club-spend-sweep', 'Club Spend Sweep');
    const expired = await h.sql<{ id: string }>(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'pending',
               1000, null, 10, 64, null, null, null, now() - interval '1 minute', null)
       returning id`,
      [owner.club.id, owner.id],
    );
    const live = await h.sql<{ id: string }>(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'pending',
               1000, null, 10, 64, null, null, null, now() + interval '10 minutes', null)
       returning id`,
      [owner.club.id, owner.id],
    );
    const finalized = await h.sql<{ id: string }>(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'finalized',
               1000, 250, 10, 64, 9, 12, null, now() - interval '10 minutes', '2026-01-01T00:00:00Z')
       returning id`,
      [owner.club.id, owner.id],
    );
    const released = await h.sql<{ id: string }>(
      `insert into ai_club_spend_reservations (
         club_id,
         member_id,
         action_name,
         usage_kind,
         provider,
         model,
         status,
         reserved_micro_cents,
         actual_micro_cents,
         reserved_input_tokens_estimate,
         reserved_output_tokens,
         actual_prompt_tokens,
         actual_completion_tokens,
         actual_embedding_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'gate', 'openai', 'gpt-5.4-nano', 'released',
               1000, 0, 10, 64, null, null, null, now() - interval '10 minutes', '2026-01-02T00:00:00Z')
       returning id`,
      [owner.club.id, owner.id],
    );

    await processEmbeddings({ db: h.pools.super });

    const rows = await h.sql<{
      id: string;
      status: string;
      actual_micro_cents: string | null;
      finalized_at: string | null;
    }>(
      `select id, status, actual_micro_cents::text as actual_micro_cents, finalized_at::text as finalized_at
       from ai_club_spend_reservations
       where id = any($1::text[])
       order by id`,
      [[expired[0]!.id, live[0]!.id, finalized[0]!.id, released[0]!.id]],
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get(expired[0]!.id)?.status, 'released');
    assert.equal(byId.get(expired[0]!.id)?.actual_micro_cents, '0');
    assert.match(String(byId.get(expired[0]!.id)?.finalized_at), /^\d{4}-\d{2}-\d{2}/);
    assert.equal(byId.get(live[0]!.id)?.status, 'pending');
    assert.equal(byId.get(live[0]!.id)?.actual_micro_cents, null);
    assert.equal(byId.get(live[0]!.id)?.finalized_at, null);
    assert.equal(byId.get(finalized[0]!.id)?.status, 'finalized');
    assert.equal(byId.get(finalized[0]!.id)?.actual_micro_cents, '250');
    assert.match(String(byId.get(finalized[0]!.id)?.finalized_at), /^2026-01-01/);
    assert.equal(byId.get(released[0]!.id)?.status, 'released');
    assert.equal(byId.get(released[0]!.id)?.actual_micro_cents, '0');
    assert.match(String(byId.get(released[0]!.id)?.finalized_at), /^2026-01-02/);
  });
});
