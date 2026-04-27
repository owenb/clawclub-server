import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../harness.ts';
import { enforceDurableGlobalEventQuota } from '../../../src/quotas.ts';

let h: TestHarness;
let gateCalls = 0;

const quotaGate = async () => {
  gateCalls += 1;
  return {
    status: 'passed' as const,
    usage: {
      promptTokens: 11,
      completionTokens: 7,
    },
  };
};

function readQuotas(result: Awaited<ReturnType<TestHarness['apiOk']>>): QuotaRow[] {
  return (result.data as { quotas: QuotaRow[] }).quotas;
}

function assertDayUsage(result: Awaited<ReturnType<TestHarness['apiOk']>>, action: string, clubId: string | null, expected: number) {
  const quota = findQuota(readQuotas(result), action, clubId);
  assert.equal(findWindow(quota, 'day').used, expected);
}

type QuotaWindow = {
  window: 'day' | 'week' | 'month';
  max: number;
  used: number;
  remaining: number;
};

type QuotaRow = {
  action: string;
  metric: 'requests' | 'output_tokens';
  scope: 'per_club_member' | 'per_member_global';
  clubId: string | null;
  windows: QuotaWindow[];
};

function findQuota(quotas: QuotaRow[], action: string, clubId: string | null): QuotaRow {
  const quota = quotas.find((row) => row.action === action && row.clubId === clubId);
  assert.ok(quota, `missing quota row for ${action} ${clubId ?? 'global'}`);
  return quota!;
}

function findWindow(quota: QuotaRow, window: QuotaWindow['window']): QuotaWindow {
  const match = quota.windows.find((entry) => entry.window === window);
  assert.ok(match, `missing ${window} window for ${quota.action}`);
  return match!;
}

before(async () => {
  h = await TestHarness.start({ llmGate: quotaGate });
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('llm.outputTokens quota', () => {
  it('tracks actual output tokens from content.create and content.update in one club scope', async () => {
    const owner = await h.seedOwner('llm-budget-update', 'LLM Budget Update');

    const created = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Budgeted post',
      body: 'Original body',
    });
    const content = (created.data as Record<string, unknown>).content as Record<string, unknown>;

    await h.apiOk(owner.token, 'content.update', {
      id: content.id,
      body: 'Updated body',
    });

    const quotas = ((await h.apiOk(owner.token, 'quotas.getUsage', {})).data as { quotas: QuotaRow[] }).quotas;
    const llmQuota = findQuota(quotas, 'llm.outputTokens', owner.club.id);
    assert.equal(findWindow(llmQuota, 'day').used, 14);
    assert.equal(findWindow(llmQuota, 'day').remaining, 9986);
  });

  it('charges replies against the same club-member output-token budget by resolving threadId', async () => {
    const owner = await h.seedOwner('llm-budget-reply', 'LLM Budget Reply');

    const created = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Thread root',
      body: 'Root',
    });
    const content = (created.data as Record<string, unknown>).content as Record<string, unknown>;

    await h.apiOk(owner.token, 'content.create', {
      threadId: content.threadId,
      kind: 'post',
      body: 'Reply',
    });

    const quotas = ((await h.apiOk(owner.token, 'quotas.getUsage', {})).data as { quotas: QuotaRow[] }).quotas;
    const llmQuota = findQuota(quotas, 'llm.outputTokens', owner.club.id);
    assert.equal(findWindow(llmQuota, 'day').used, 14);
  });

  it('rejects non-authored content.update before the LLM gate and without charging output tokens', async () => {
    const owner = await h.seedOwner('llm-budget-foreign-update', 'LLM Budget Foreign Update');
    const intruder = await h.seedCompedMember(owner.club.id, 'Quota Intruder');

    const created = await h.apiOk(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Author only',
      body: 'Original',
    });
    const content = (created.data as Record<string, unknown>).content as Record<string, unknown>;

    const callsBefore = gateCalls;
    const err = await h.apiErr(intruder.token, 'content.update', {
      id: content.id,
      body: 'Intruder edit',
    });
    assert.equal(err.status, 403);
    assert.equal(err.code, 'forbidden_scope');
    assert.equal(gateCalls, callsBefore);

    const quotas = await h.apiOk(intruder.token, 'quotas.getUsage', {});
    assertDayUsage(quotas, 'llm.outputTokens', owner.club.id, 0);
  });

  it('rejects an inaccessible threadId before the LLM gate and without charging quotas', async () => {
    const ownerA = await h.seedOwner('llm-budget-thread-a', 'LLM Budget Thread A');
    const ownerB = await h.seedOwner('llm-budget-thread-b', 'LLM Budget Thread B');

    const created = await h.apiOk(ownerB.token, 'content.create', {
      clubId: ownerB.club.id,
      kind: 'post',
      title: 'Remote thread',
      body: 'Not yours',
    });
    const content = (created.data as Record<string, unknown>).content as Record<string, unknown>;

    const callsBefore = gateCalls;
    const err = await h.apiErr(ownerA.token, 'content.create', {
      threadId: content.threadId,
      kind: 'post',
      body: 'Reply attempt',
    });
    assert.equal(err.status, 404);
    assert.equal(err.code, 'thread_not_found');
    assert.equal(gateCalls, callsBefore);

    const quotas = await h.apiOk(ownerA.token, 'quotas.getUsage', {});
    assertDayUsage(quotas, 'content.create', ownerA.club.id, 0);
    assertDayUsage(quotas, 'llm.outputTokens', ownerA.club.id, 0);
  });

  it('rejects a gated write before the LLM gate when the request quota is already exhausted', async () => {
    const owner = await h.seedOwner('llm-request-quota-limit', 'LLM Request Quota Limit');
    const member = await h.seedCompedMember(owner.club.id, 'Quota Exhausted Member');

    await h.sqlClubs(
      `with thread as (
         insert into content_threads (club_id, created_by_member_id)
         values ($1, $2)
         returning id
       )
       insert into contents (club_id, kind, author_member_id, open_loop, thread_id, created_at)
       select
         $1,
         'post',
         $2,
         null,
         thread.id,
         now() - ((gs - 1) * interval '1 minute')
       from thread
       cross join generate_series(1, 50) gs`,
      [owner.club.id, member.id],
    );

    const callsBefore = gateCalls;
    const err = await h.apiErr(member.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Blocked before gate',
      body: 'This should fail on request quota',
    });
    assert.equal(err.status, 429);
    assert.equal(err.code, 'quota_exceeded');
    assert.equal(gateCalls, callsBefore);

    const llmLog = await h.sqlClubs<{ count: string }>(
      `select count(*)::text as count
         from ai_llm_usage_log
        where member_id = $1
          and action_name = 'content.create'`,
      [member.id],
    );
    assert.equal(Number(llmLog[0]?.count ?? 0), 0);
  });

  it('rejects a gated write when the output-token budget would be exceeded', async () => {
    const owner = await h.seedOwner('llm-budget-limit', 'LLM Budget Limit');

    await h.sqlClubs(
      `insert into ai_llm_quota_reservations (
         member_id,
         club_id,
         action_name,
         provider,
         model,
         status,
         reserved_output_tokens,
         actual_output_tokens,
         expires_at,
         finalized_at
       )
       values ($1, $2, 'content.create', 'openai', 'gpt-5.4-nano', 'finalized', 7, 9994, now(), now())`,
      [owner.id, owner.club.id],
    );

    const err = await h.apiErr(owner.token, 'content.create', {
      clubId: owner.club.id,
      kind: 'post',
      title: 'Blocked by budget',
      body: 'This should fail',
    });
    assert.equal(err.status, 429);
    assert.equal(err.code, 'quota_exceeded');

    const quotas = ((await h.apiOk(owner.token, 'quotas.getUsage', {})).data as { quotas: QuotaRow[] }).quotas;
    const llmQuota = findQuota(quotas, 'llm.outputTokens', owner.club.id);
    assert.equal(findWindow(llmQuota, 'day').used, 9994);
    assert.equal(findWindow(llmQuota, 'day').remaining, 6);
  });
});

describe('embedding.query quota', () => {
  it('tracks each semantic-search call against the global per-member bucket', async () => {
    const owner = await h.seedOwner('embed-quota-track', 'Embed Quota Track');

    await h.apiOk(owner.token, 'members.searchBySemanticSimilarity', { query: 'first', clubId: owner.club.id });
    await h.apiOk(owner.token, 'content.searchBySemanticSimilarity', { query: 'second', clubId: owner.club.id });

    const quotas = readQuotas(await h.apiOk(owner.token, 'quotas.getUsage', {}));
    const q = findQuota(quotas, 'embedding.query', null);
    assert.equal(findWindow(q, 'day').used, 2);
    assert.equal(findWindow(q, 'day').max, 100);
  });

  it('blocks both search actions once the daily limit is reached', async () => {
    const owner = await h.seedOwner('embed-quota-block', 'Embed Quota Block');

    await h.sqlClubs(
      `insert into ai_quota_event_log (member_id, action_name)
       select $1, 'embedding.query' from generate_series(1, 100)`,
      [owner.id],
    );

    const memberErr = await h.apiErr(owner.token, 'members.searchBySemanticSimilarity', { query: 'blocked', clubId: owner.club.id });
    assert.equal(memberErr.status, 429);
    assert.equal(memberErr.code, 'quota_exceeded');

    const contentErr = await h.apiErr(owner.token, 'content.searchBySemanticSimilarity', { query: 'blocked' });
    assert.equal(contentErr.status, 429);
    assert.equal(contentErr.code, 'quota_exceeded');
  });
});

describe('messages.send quota', () => {
  it('tracks DM sends against the global per-member bucket', async () => {
    const owner = await h.seedOwner('dm-quota-track', 'DM Quota Track');
    const recipient = await h.seedCompedMember(owner.club.id, 'DM Recipient');

    await h.apiOk(owner.token, 'messages.send', {
      recipientMemberId: recipient.id,
      messageText: 'hello there',
      clientKey: 'dm-track-1',
    });

    const quotas = readQuotas(await h.apiOk(owner.token, 'quotas.getUsage', {}));
    const q = findQuota(quotas, 'messages.send', null);
    assert.equal(findWindow(q, 'day').used, 1);
    assert.equal(findWindow(q, 'day').max, 50);
  });

  it('blocks DM sends once the daily limit is reached', async () => {
    const owner = await h.seedOwner('dm-quota-block', 'DM Quota Block');
    const recipient = await h.seedCompedMember(owner.club.id, 'DM Block Recipient');
    const memberA = owner.id < recipient.id ? owner.id : recipient.id;
    const memberB = owner.id < recipient.id ? recipient.id : owner.id;
    const thread = await h.sql<{ id: string }>(
      `insert into dm_threads (kind, created_by_member_id, member_a_id, member_b_id)
       values ('direct', $1, $2, $3)
       returning id`,
      [owner.id, memberA, memberB],
    );
    await h.sql(
      `insert into dm_thread_participants (thread_id, member_id)
       values ($1, $2), ($1, $3)`,
      [thread[0]!.id, owner.id, recipient.id],
    );
    await h.sql(
      `insert into dm_messages (thread_id, sender_member_id, role, message_text)
       select $1, $2, 'member', 'seed message ' || gs::text
       from generate_series(1, 50) as gs`,
      [thread[0]!.id, owner.id],
    );

    const err = await h.apiErr(owner.token, 'messages.send', {
      recipientMemberId: recipient.id,
      messageText: 'blocked',
      clientKey: 'dm-block-1',
    });
    assert.equal(err.status, 429);
    assert.equal(err.code, 'quota_exceeded');
  });
});

describe('clubs.apply global quota', () => {
  it('increments the global per-member counter on clubs.apply and clubs.applications.revise', async () => {
    const owner = await h.seedOwner('apply-quota-track', 'Apply Quota Track');
    const applicant = await h.seedMember('Apply Quota Applicant');

    const applyRes = await h.apiOk(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: { name: 'Test User', socials: '', application: 'I want to join.' },
      clientKey: 'apply-track-1',
    });
    const application = (applyRes.data as Record<string, unknown>).application as Record<string, unknown>;

    const q1 = findQuota(readQuotas(await h.apiOk(applicant.token, 'quotas.getUsage', {})), 'clubs.apply', null);
    assert.equal(findWindow(q1, 'day').used, 1);
    assert.equal(findWindow(q1, 'day').max, 10);

    // Seed the application into revision_required so revise is callable
    await h.sql(
      `update club_applications set phase = 'revision_required', gate_verdict = 'needs_revision' where id = $1`,
      [application.applicationId as string],
    );

    await h.apiOk(applicant.token, 'clubs.applications.revise', {
      applicationId: application.applicationId,
      draft: { name: 'Test User', socials: '', application: 'Better application.' },
      clientKey: 'apply-track-2',
    });

    const q2 = findQuota(readQuotas(await h.apiOk(applicant.token, 'quotas.getUsage', {})), 'clubs.apply', null);
    assert.equal(findWindow(q2, 'day').used, 2);
  });

  it('counts invitations.redeem against the same global per-member application bucket', async () => {
    const owner = await h.seedOwner('apply-quota-invite', 'Apply Quota Invite');
    const candidate = await h.seedMember('Invited Applicant', 'invited-applicant@example.com');
    const invitation = await h.seedInvitation(owner.club.id, owner.id, 'invited-applicant@example.com');

    await h.apiOk(candidate.token, 'invitations.redeem', {
      code: invitation.code.toLowerCase(),
      draft: { name: 'Invited Applicant', socials: '', application: 'Invitation redemption application.' },
      clientKey: 'apply-invite-1',
    });

    const q = findQuota(readQuotas(await h.apiOk(candidate.token, 'quotas.getUsage', {})), 'clubs.apply', null);
    assert.equal(findWindow(q, 'day').used, 1);
    assert.equal(findWindow(q, 'day').max, 10);
  });

  it('keeps clubs.apply usage durable even if a caller transaction rolls back later', async () => {
    const applicant = await h.seedMember('Durable Apply Applicant');
    const client = await h.pools.app.connect();
    try {
      await client.query('BEGIN');
      await client.query(`select 1`);

      await enforceDurableGlobalEventQuota(h.pools.app, {
        action: 'clubs.apply',
        memberId: applicant.id,
      });

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const rows = await h.sql<{ count: string }>(
      `select count(*)::text as count
       from ai_quota_event_log
       where member_id = $1
         and action_name = 'clubs.apply'`,
      [applicant.id],
    );
    assert.equal(rows[0]?.count, '1');
  });

  it('blocks clubs.apply once the daily limit is reached', async () => {
    const owner = await h.seedOwner('apply-quota-block', 'Apply Quota Block');
    const applicant = await h.seedMember('Apply Quota Blocked');

    await h.sql(
      `insert into ai_quota_event_log (member_id, action_name)
       select $1, 'clubs.apply' from generate_series(1, 10)`,
      [applicant.id],
    );

    const err = await h.apiErr(applicant.token, 'clubs.apply', {
      clubSlug: owner.club.slug,
      draft: { name: 'Blocked Applicant', socials: '', application: 'I want to join.' },
      clientKey: 'apply-block-1',
    });
    assert.equal(err.status, 429);
    assert.equal(err.code, 'quota_exceeded');
  });

  it('blocks clubs.applications.revise once the daily limit is reached', async () => {
    const owner = await h.seedOwner('apply-quota-revise-block', 'Apply Quota Revise Block');
    const applicant = await h.seedMember('Apply Quota Revise Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id, {
      phase: 'revision_required',
    });

    await h.sql(
      `insert into ai_quota_event_log (member_id, action_name)
       select $1, 'clubs.apply' from generate_series(1, 10)`,
      [applicant.id],
    );

    const err = await h.apiErr(applicant.token, 'clubs.applications.revise', {
      applicationId: application.id,
      draft: { name: 'Apply Quota Revise Applicant', socials: '', application: 'Please let me in.' },
      clientKey: 'apply-revise-block-1',
    });
    assert.equal(err.status, 429);
    assert.equal(err.code, 'quota_exceeded');
  });
});
