import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for postgres RLS tests');
  }
  return databaseUrl;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function isRetriableCatalogError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'message' in error
    && error.code === 'XX000'
    && typeof error.message === 'string'
    && error.message.includes('tuple concurrently updated');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queryWithCatalogRetry(client: PoolClient, sql: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await client.query(sql);
      return;
    } catch (error) {
      if (!isRetriableCatalogError(error) || attempt === 4) {
        throw error;
      }

      await sleep(25 * (attempt + 1));
    }
  }
}

async function withIsolatedClient(fn: (client: PoolClient, roleName: string) => Promise<void>) {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const client = await pool.connect();
  const roleName = `clawclub_rls_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    await queryWithCatalogRetry(client, `create role ${quoteIdentifier(roleName)} nologin`);
    await queryWithCatalogRetry(client, `grant usage on schema app to ${quoteIdentifier(roleName)}`);
    await queryWithCatalogRetry(client, `grant execute on all functions in schema app to ${quoteIdentifier(roleName)}`);
    await queryWithCatalogRetry(client, `grant select, insert, update, delete on all tables in schema app to ${quoteIdentifier(roleName)}`);
    await client.query('begin');
    await fn(client, roleName);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.query('reset session authorization').catch(() => {});
    await queryWithCatalogRetry(client, `drop role if exists ${quoteIdentifier(roleName)}`).catch(() => {});
    client.release();
    await pool.end();
  }
}

async function setActorContext(client: PoolClient, actorMemberId: string) {
  await client.query(
    `select set_config('app.actor_member_id', $1, true)`,
    [actorMemberId],
  );
}

async function seedRlsFixture(client: PoolClient) {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const ownerId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Owner ${suffix}`, `auth|owner-${suffix}`, `owner-${suffix}`],
  )).rows[0]!.id;

  const memberAId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Member A ${suffix}`, `auth|member-a-${suffix}`, `member-a-${suffix}`],
  )).rows[0]!.id;

  const memberBId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Member B ${suffix}`, `auth|member-b-${suffix}`, `member-b-${suffix}`],
  )).rows[0]!.id;

  const memberCId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Member C ${suffix}`, `auth|member-c-${suffix}`, `member-c-${suffix}`],
  )).rows[0]!.id;

  const unpaidMemberId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Unpaid Member ${suffix}`, `auth|unpaid-${suffix}`, `unpaid-${suffix}`],
  )).rows[0]!.id;

  const pendingCandidateId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Pending Candidate ${suffix}`, `auth|pending-${suffix}`, `pending-${suffix}`],
  )).rows[0]!.id;

  const outsiderId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
    [`Outsider ${suffix}`, `auth|outsider-${suffix}`, `outsider-${suffix}`],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
      values ($1, 'superadmin', 'active', 1, $1)
    `,
    [ownerId],
  );

  await setActorContext(client, ownerId);

  const network1Id = (await client.query<{ id: string }>(
    `insert into app.networks (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
    [`network-one-${suffix}`, `Network One ${suffix}`, ownerId, 'RLS test network one'],
  )).rows[0]!.id;

  const network2Id = (await client.query<{ id: string }>(
    `insert into app.networks (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
    [`network-two-${suffix}`, `Network Two ${suffix}`, outsiderId, 'RLS test network two'],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.network_owner_versions (
        network_id,
        owner_member_id,
        version_no,
        created_by_member_id
      )
      values
        ($1, $2, 1, $2),
        ($3, $4, 1, $4)
    `,
    [network1Id, ownerId, network2Id, outsiderId],
  );

  const ownerMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, role, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, 'owner', null, now())
      returning id
    `,
    [network1Id, ownerId],
  )).rows[0]!.id;

  const memberAMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [network1Id, memberAId, ownerId],
  )).rows[0]!.id;

  const memberBMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [network1Id, memberBId, ownerId],
  )).rows[0]!.id;

  const memberCMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [network1Id, memberCId, ownerId],
  )).rows[0]!.id;

  const unpaidMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [network1Id, unpaidMemberId, ownerId],
  )).rows[0]!.id;

  const pendingCandidateMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, sponsor_member_id, status)
      values ($1, $2, $3, 'pending_review')
      returning id
    `,
    [network1Id, pendingCandidateId, ownerId],
  )).rows[0]!.id;

  const outsiderMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.network_memberships (network_id, member_id, role, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, 'owner', null, now())
      returning id
    `,
    [network2Id, outsiderId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.network_membership_state_versions (membership_id, status, version_no, created_by_member_id)
      values
        ($1, 'active', 1, $2),
        ($3, 'active', 1, $2),
        ($4, 'active', 1, $2),
        ($5, 'active', 1, $2),
        ($6, 'active', 1, $2),
        ($7, 'pending_review', 1, $2),
        ($8, 'active', 1, $9)
    `,
    [
      ownerMembershipId,
      ownerId,
      memberAMembershipId,
      memberBMembershipId,
      memberCMembershipId,
      unpaidMembershipId,
      pendingCandidateMembershipId,
      outsiderMembershipId,
      outsiderId,
    ],
  );

  await client.query(
    `
      insert into app.subscriptions (
        membership_id,
        payer_member_id,
        status,
        amount,
        currency,
        current_period_start,
        current_period_end
      )
      values
        ($1, $2, 'active', 25, 'GBP', now(), now() + interval '30 days'),
        ($3, $4, 'active', 25, 'GBP', now(), now() + interval '30 days'),
        ($5, $6, 'active', 25, 'GBP', now(), now() + interval '30 days')
    `,
    [memberAMembershipId, memberAId, memberBMembershipId, memberBId, memberCMembershipId, memberCId],
  );

  await client.query(
    `
      insert into app.member_profile_versions (
        member_id,
        version_no,
        display_name,
        summary,
        created_by_member_id
      )
      values ($1, 1, $2, $3, $1)
    `,
    [outsiderId, `Outsider ${suffix}`, 'Outside applicant profile'],
  );

  await setActorContext(client, memberAId);

  const network1EntityId = (await client.query<{ id: string }>(
    `insert into app.entities (network_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
    [network1Id, memberAId],
  )).rows[0]!.id;

  const network1EntityVersionId = (await client.query<{ id: string }>(
    `
      insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
      values ($1, 1, 'published', $2, $3, $4)
      returning id
    `,
    [network1EntityId, `Entity One ${suffix}`, 'Visible inside network one', memberAId],
  )).rows[0]!.id;

  const threadId = (await client.query<{ id: string }>(
    `
      insert into app.transcript_threads (network_id, kind, created_by_member_id, counterpart_member_id)
      values ($1, 'dm', $2, $3)
      returning id
    `,
    [network1Id, memberAId, memberBId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.transcript_messages (thread_id, sender_member_id, role, message_text)
      values ($1, $2, 'member', $3)
    `,
    [threadId, memberAId, 'Private DM'],
  );

  await setActorContext(client, outsiderId);

  const network2EntityId = (await client.query<{ id: string }>(
    `insert into app.entities (network_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
    [network2Id, outsiderId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
      values ($1, 1, 'published', $2, $3, $4)
    `,
    [network2EntityId, `Entity Two ${suffix}`, 'Hidden from network one', outsiderId],
  );

  await setActorContext(client, ownerId);

  const applicationId = (await client.query<{ id: string }>(
    `
      insert into app.applications (
        network_id,
        applicant_member_id,
        sponsor_member_id,
        path,
        metadata
      )
      values ($1, $2, $3, 'outside', '{}'::jsonb)
      returning id
    `,
    [network1Id, outsiderId, ownerId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.application_versions (
        application_id,
        status,
        notes,
        intake_kind,
        version_no,
        created_by_member_id
      )
      values ($1, 'submitted', 'Outside applicant under review', 'advice_call', 1, $2)
    `,
    [applicationId, ownerId],
  );

  return {
    ownerId,
    memberAId,
    memberBId,
    memberCId,
    unpaidMemberId,
    pendingCandidateId,
    outsiderId,
    network1Id,
    network2Id,
    ownerMembershipId,
    memberAMembershipId,
    memberBMembershipId,
    unpaidMembershipId,
    pendingCandidateMembershipId,
    network1EntityId,
    network2EntityId,
    threadId,
    applicationId,
  };
}

test('RLS only exposes entities inside the actor network scope', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);
    await setActorContext(client, fixture.memberAId);
    const visible = await client.query<{ id: string }>(
      `
        select id
        from app.entities
        where id = $1
           or id = $2
        order by id asc
      `,
      [fixture.network1EntityId, fixture.network2EntityId],
    );

    assert.deepEqual(visible.rows.map((row) => row.id), [fixture.network1EntityId]);
  });
});

test('RLS ignores spoofed legacy actor_network_ids and still derives access from memberships', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);
    await setActorContext(client, fixture.memberAId);
    await client.query(`select set_config('app.actor_network_ids', $1, true)`, [fixture.network2Id]);
    const leaked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.entities
        where id = $1
      `,
      [fixture.network2EntityId],
    );

    assert.equal(leaked.rows[0]?.visible_count, '0');
  });
});

test('RLS only lets owners or superadmins insert network memberships, and blocks direct membership updates', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberAId);
    await client.query('savepoint bad_membership_insert');
    await assert.rejects(
      () => client.query(
        `
          insert into app.network_memberships (
            network_id,
            member_id,
            sponsor_member_id,
            role,
            accepted_covenant_at
          )
          values ($1, $2, $3, 'member', now())
        `,
        [fixture.network1Id, fixture.outsiderId, fixture.ownerId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_membership_insert');

    await setActorContext(client, fixture.ownerId);
    const inserted = await client.query<{ id: string }>(
      `
        insert into app.network_memberships (
          network_id,
          member_id,
          sponsor_member_id,
          role,
          accepted_covenant_at
        )
        values ($1, $2, $3, 'member', now())
        returning id
      `,
      [fixture.network1Id, fixture.outsiderId, fixture.ownerId],
    );

    const blockedUpdate = await client.query<{ id: string }>(
      `
        update app.network_memberships
        set role = 'owner'
        where id = $1
        returning id
      `,
      [inserted.rows[0]?.id],
    );

    assert.equal(typeof inserted.rows[0]?.id, 'string');
    assert.equal(blockedUpdate.rowCount, 0);
  });
});

test('RLS restricts subscription writes to superadmin scope and blocks ordinary updates', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberAId);
    const beforeBlockedInsert = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.accessible_network_memberships
        where id = $1
      `,
      [fixture.unpaidMembershipId],
    );
    await client.query('savepoint bad_subscription_insert');
    await assert.rejects(
      () => client.query(
        `
          insert into app.subscriptions (
            membership_id,
            payer_member_id,
            status,
            amount,
            currency,
            current_period_start,
            current_period_end
          )
          values ($1, $2, 'active', 25, 'GBP', now(), now() + interval '30 days')
        `,
        [fixture.unpaidMembershipId, fixture.unpaidMemberId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_subscription_insert');
    const afterBlockedInsert = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.accessible_network_memberships
        where id = $1
      `,
      [fixture.unpaidMembershipId],
    );

    const blockedUpdate = await client.query<{ id: string }>(
      `
        update app.subscriptions
        set ended_at = now()
        where membership_id = $1
        returning id
      `,
      [fixture.memberAMembershipId],
    );

    await setActorContext(client, fixture.ownerId);
    const inserted = await client.query<{ id: string }>(
      `
        insert into app.subscriptions (
          membership_id,
          payer_member_id,
          status,
          amount,
          currency,
          current_period_start,
          current_period_end
        )
        values ($1, $2, 'active', 25, 'GBP', now(), now() + interval '30 days')
        returning id
      `,
      [fixture.unpaidMembershipId, fixture.unpaidMemberId],
    );
    const afterAllowedInsert = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.accessible_network_memberships
        where id = $1
      `,
      [fixture.unpaidMembershipId],
    );

    const allowedUpdate = await client.query<{ id: string }>(
      `
        update app.subscriptions
        set ended_at = now()
        where id = $1
        returning id
      `,
      [inserted.rows[0]?.id],
    );

    assert.equal(beforeBlockedInsert.rows[0]?.visible_count, '0');
    assert.equal(afterBlockedInsert.rows[0]?.visible_count, '0');
    assert.equal(blockedUpdate.rowCount, 0);
    assert.equal(typeof inserted.rows[0]?.id, 'string');
    assert.equal(afterAllowedInsert.rows[0]?.visible_count, '1');
    assert.equal(allowedUpdate.rows[0]?.id, inserted.rows[0]?.id);
  });
});

test('RLS only lets authors archive accessible entities', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberBId);
    await client.query('savepoint bad_entity_archive');
    await assert.rejects(
      () => client.query(
        `
          insert into app.entity_versions (
            entity_id,
            version_no,
            state,
            title,
            summary,
            body,
            effective_at,
            expires_at,
            content,
            supersedes_version_id,
            created_by_member_id
          )
          select
            cev.entity_id,
            cev.version_no + 1,
            'archived',
            cev.title,
            cev.summary,
            cev.body,
            now(),
            now(),
            cev.content,
            cev.id,
            $2::app.short_id
          from app.current_entity_versions cev
          where cev.entity_id = $1::app.short_id
        `,
        [fixture.network1EntityId, fixture.memberBId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_entity_archive');

    await setActorContext(client, fixture.memberAId);
    const archivedVersion = await client.query<{ id: string }>(
      `
        insert into app.entity_versions (
          entity_id,
          version_no,
          state,
          title,
          summary,
          body,
          effective_at,
          expires_at,
          content,
          supersedes_version_id,
          created_by_member_id
        )
        select
          cev.entity_id,
          cev.version_no + 1,
          'archived',
          cev.title,
          cev.summary,
          cev.body,
          now(),
          now(),
          cev.content,
          cev.id,
          $2::app.short_id
        from app.current_entity_versions cev
        where cev.entity_id = $1::app.short_id
        returning id
      `,
      [fixture.network1EntityId, fixture.memberAId],
    );
    const hidden = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.live_entities
        where entity_id = $1
      `,
      [fixture.network1EntityId],
    );

    await client.query('reset session authorization');
    const archived = await client.query<{ archived_version_count: string; current_state: string | null }>(
      `
        select
          (
            select count(*)::text
            from app.entity_versions
            where entity_id = $1
              and state = 'archived'
          ) as archived_version_count,
          (
            select state::text
            from app.current_entity_versions
            where entity_id = $1
            limit 1
          ) as current_state
      `,
      [fixture.network1EntityId],
    );

    assert.equal(typeof archivedVersion.rows[0]?.id, 'string');
    assert.equal(hidden.rows[0]?.visible_count, '0');
    assert.equal(archived.rows[0]?.archived_version_count, '1');
    assert.equal(archived.rows[0]?.current_state, 'archived');
  });
});

test('RLS blocks transcript reads for same-network members who are not participants', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);
    await setActorContext(client, fixture.memberCId);
    const blocked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.transcript_messages
        where thread_id = $1
      `,
      [fixture.threadId],
    );

    await setActorContext(client, fixture.memberAId);
    const allowed = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.transcript_messages
        where thread_id = $1
      `,
      [fixture.threadId],
    );

    assert.equal(blocked.rows[0]?.visible_count, '0');
    assert.equal(allowed.rows[0]?.visible_count, '1');
  });
});

test('RLS only exposes application-linked outsider member data to owners and related actors', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberAId);
    const memberBlocked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.members
        where id in ($1, $2)
      `,
      [fixture.pendingCandidateId, fixture.outsiderId],
    );
    const profileBlocked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.member_profile_versions
        where member_id = $1
      `,
      [fixture.outsiderId],
    );
    const applicationBlocked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.applications
        where id = $1
      `,
      [fixture.applicationId],
    );

    await setActorContext(client, fixture.ownerId);
    const memberVisible = await client.query<{ id: string }>(
      `
        select id
        from app.members
        where id in ($1, $2)
        order by id asc
      `,
      [fixture.pendingCandidateId, fixture.outsiderId],
    );
    const profileVisible = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.member_profile_versions
        where member_id = $1
      `,
      [fixture.outsiderId],
    );
    const applicationVisible = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.applications
        where id = $1
      `,
      [fixture.applicationId],
    );

    assert.equal(memberBlocked.rows[0]?.visible_count, '0');
    assert.equal(profileBlocked.rows[0]?.visible_count, '0');
    assert.equal(applicationBlocked.rows[0]?.visible_count, '0');
    assert.deepEqual(
      memberVisible.rows.map((row) => row.id).sort(),
      [fixture.outsiderId, fixture.pendingCandidateId].sort(),
    );
    assert.equal(profileVisible.rows[0]?.visible_count, '1');
    assert.equal(applicationVisible.rows[0]?.visible_count, '1');
  });
});

test('RLS limits token and history tables to actor or owner scope', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberAId);
    const ownToken = await client.query<{ member_id: string }>(
      `
        insert into app.member_bearer_tokens (member_id, label, token_hash, metadata)
        values ($1, 'member-a', $2, '{}'::jsonb)
        returning member_id
      `,
      [fixture.memberAId, `hash-member-a-${Date.now()}`],
    );
    assert.equal(ownToken.rows[0]?.member_id, fixture.memberAId);

    await client.query('savepoint bad_token');
    await assert.rejects(
      () => client.query(
        `
          insert into app.member_bearer_tokens (member_id, label, token_hash, metadata)
          values ($1, 'member-b', $2, '{}'::jsonb)
        `,
        [fixture.memberBId, `hash-member-b-${Date.now()}`],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_token');

    const hiddenRoles = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.member_global_role_versions
        where member_id = $1
      `,
      [fixture.ownerId],
    );
    assert.equal(hiddenRoles.rows[0]?.visible_count, '0');

    const visibleOwnerHistory = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.network_owner_versions
        where network_id in ($1, $2)
      `,
      [fixture.network1Id, fixture.network2Id],
    );
    assert.equal(visibleOwnerHistory.rows[0]?.visible_count, '1');

    await client.query('savepoint bad_state');
    await assert.rejects(
      () => client.query(
        `
          insert into app.network_membership_state_versions (
            membership_id,
            status,
            version_no,
            created_by_member_id
          )
          select $1::app.short_id, 'paused', cnms.version_no + 1, $2::app.short_id
          from app.current_network_membership_states cnms
          where cnms.membership_id = $1::app.short_id
        `,
        [fixture.memberBMembershipId, fixture.memberAId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_state');

    await setActorContext(client, fixture.ownerId);
    const visibleRoles = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.member_global_role_versions
        where member_id = $1
      `,
      [fixture.ownerId],
    );
    assert.equal(visibleRoles.rows[0]?.visible_count, '1');

    const insertedState = await client.query<{ id: string }>(
      `
        insert into app.network_membership_state_versions (
          membership_id,
          status,
          version_no,
          supersedes_state_version_id,
          created_by_member_id
        )
        select $1::app.short_id, 'paused', cnms.version_no + 1, cnms.id, $2::app.short_id
        from app.current_network_membership_states cnms
        where cnms.membership_id = $1::app.short_id
        returning id
      `,
      [fixture.memberBMembershipId, fixture.ownerId],
    );
    assert.equal(typeof insertedState.rows[0]?.id, 'string');

    await setActorContext(client, fixture.memberAId);
    const entityVersion = await client.query<{ id: string }>(
      `
        select id
        from app.current_entity_versions
        where entity_id = $1
        limit 1
      `,
      [fixture.network1EntityId],
    );

    const memberUpdate = await client.query<{ id: string; recipient_member_id: string }>(
      `
        insert into app.member_updates (
          recipient_member_id,
          network_id,
          topic,
          payload,
          entity_id,
          entity_version_id,
          created_by_member_id
        )
        values ($1, $2, 'entity.version.published', '{"kind":"post"}'::jsonb, $3, $4, $5)
        returning id, recipient_member_id
      `,
      [fixture.memberAId, fixture.network1Id, fixture.network1EntityId, entityVersion.rows[0]?.id, fixture.memberAId],
    );
    assert.equal(memberUpdate.rows[0]?.recipient_member_id, fixture.memberAId);

    const ownReceipt = await client.query<{ recipient_member_id: string }>(
      `
        insert into app.member_update_receipts (
          member_update_id,
          recipient_member_id,
          network_id,
          state,
          version_no,
          created_by_member_id
        )
        values ($1, $2, $3, 'processed', 1, $2)
        returning recipient_member_id
      `,
      [memberUpdate.rows[0]?.id, fixture.memberAId, fixture.network1Id],
    );
    assert.equal(ownReceipt.rows[0]?.recipient_member_id, fixture.memberAId);

    await client.query('savepoint bad_update_receipt');
    await assert.rejects(
      () => client.query(
        `
          insert into app.member_update_receipts (
            member_update_id,
            recipient_member_id,
            network_id,
            state,
            version_no,
            created_by_member_id
          )
          values ($1, $2, $3, 'processed', 1, $4)
        `,
        [memberUpdate.rows[0]?.id, fixture.memberBId, fixture.network1Id, fixture.memberAId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_update_receipt');
  });
});
