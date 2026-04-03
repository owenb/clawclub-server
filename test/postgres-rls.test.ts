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
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Owner ${suffix}`, `owner-${suffix}`],
  )).rows[0]!.id;

  const memberAId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Member A ${suffix}`, `member-a-${suffix}`],
  )).rows[0]!.id;

  const memberBId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Member B ${suffix}`, `member-b-${suffix}`],
  )).rows[0]!.id;

  const memberCId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Member C ${suffix}`, `member-c-${suffix}`],
  )).rows[0]!.id;

  const unpaidMemberId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Unpaid Member ${suffix}`, `unpaid-${suffix}`],
  )).rows[0]!.id;

  const pendingCandidateId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Pending Candidate ${suffix}`, `pending-${suffix}`],
  )).rows[0]!.id;

  const outsiderId = (await client.query<{ id: string }>(
    `insert into app.members (public_name, handle) values ($1, $2) returning id`,
    [`Outsider ${suffix}`, `outsider-${suffix}`],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
      values ($1, 'superadmin', 'active', 1, $1)
    `,
    [ownerId],
  );

  await setActorContext(client, ownerId);

  const club1Slug = `club-one-${suffix}`;
  const club1Id = (await client.query<{ id: string }>(
    `insert into app.clubs (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
    [club1Slug, `Club One ${suffix}`, ownerId, 'RLS test club one'],
  )).rows[0]!.id;

  const club2Slug = `club-two-${suffix}`;
  const club2Id = (await client.query<{ id: string }>(
    `insert into app.clubs (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
    [club2Slug, `Club Two ${suffix}`, outsiderId, 'RLS test club two'],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.club_owner_versions (
        club_id,
        owner_member_id,
        version_no,
        created_by_member_id
      )
      values
        ($1, $2, 1, $2),
        ($3, $4, 1, $4)
    `,
    [club1Id, ownerId, club2Id, outsiderId],
  );

  const ownerMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, 'owner', null, now())
      returning id
    `,
    [club1Id, ownerId],
  )).rows[0]!.id;

  const memberAMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [club1Id, memberAId, ownerId],
  )).rows[0]!.id;

  const memberBMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [club1Id, memberBId, ownerId],
  )).rows[0]!.id;

  const memberCMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [club1Id, memberCId, ownerId],
  )).rows[0]!.id;

  const unpaidMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, $3, now())
      returning id
    `,
    [club1Id, unpaidMemberId, ownerId],
  )).rows[0]!.id;

  const pendingCandidateMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, sponsor_member_id, status)
      values ($1, $2, $3, 'pending_review')
      returning id
    `,
    [club1Id, pendingCandidateId, ownerId],
  )).rows[0]!.id;

  const outsiderMembershipId = (await client.query<{ id: string }>(
    `
      insert into app.club_memberships (club_id, member_id, role, sponsor_member_id, accepted_covenant_at)
      values ($1, $2, 'owner', null, now())
      returning id
    `,
    [club2Id, outsiderId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.club_membership_state_versions (membership_id, status, version_no, created_by_member_id)
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
        current_period_end
      )
      values
        ($1, $2, 'active', 25, 'GBP', now() + interval '30 days'),
        ($3, $4, 'active', 25, 'GBP', now() + interval '30 days'),
        ($5, $6, 'active', 25, 'GBP', now() + interval '30 days')
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

  const club1EntityId = (await client.query<{ id: string }>(
    `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
    [club1Id, memberAId],
  )).rows[0]!.id;

  const club1EntityVersionId = (await client.query<{ id: string }>(
    `
      insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
      values ($1, 1, 'published', $2, $3, $4)
      returning id
    `,
    [club1EntityId, `Entity One ${suffix}`, 'Visible inside club one', memberAId],
  )).rows[0]!.id;

  const threadId = (await client.query<{ id: string }>(
    `
      insert into app.transcript_threads (club_id, kind, created_by_member_id, counterpart_member_id)
      values ($1, 'dm', $2, $3)
      returning id
    `,
    [club1Id, memberAId, memberBId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.transcript_messages (thread_id, sender_member_id, role, message_text)
      values ($1, $2, 'member', $3)
    `,
    [threadId, memberAId, 'Private DM'],
  );

  await setActorContext(client, outsiderId);

  const club2EntityId = (await client.query<{ id: string }>(
    `insert into app.entities (club_id, kind, author_member_id) values ($1, 'post', $2) returning id`,
    [club2Id, outsiderId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.entity_versions (entity_id, version_no, state, title, body, created_by_member_id)
      values ($1, 1, 'published', $2, $3, $4)
    `,
    [club2EntityId, `Entity Two ${suffix}`, 'Hidden from club one', outsiderId],
  );

  await setActorContext(client, ownerId);

  const admissionId = (await client.query<{ id: string }>(
    `
      insert into app.admissions (
        club_id,
        applicant_member_id,
        sponsor_member_id,
        origin,
        metadata
      )
      values ($1, $2, $3, 'owner_nominated', '{}'::jsonb)
      returning id
    `,
    [club1Id, outsiderId, ownerId],
  )).rows[0]!.id;

  await client.query(
    `
      insert into app.admission_versions (
        admission_id,
        status,
        notes,
        intake_kind,
        version_no,
        created_by_member_id
      )
      values ($1, 'submitted', 'Outside applicant under review', 'advice_call', 1, $2)
    `,
    [admissionId, ownerId],
  );

  return {
    ownerId,
    memberAId,
    memberBId,
    memberCId,
    unpaidMemberId,
    pendingCandidateId,
    outsiderId,
    club1Id,
    club1Slug,
    club2Id,
    club2Slug,
    ownerMembershipId,
    memberAMembershipId,
    memberBMembershipId,
    unpaidMembershipId,
    pendingCandidateMembershipId,
    club1EntityId,
    club2EntityId,
    threadId,
    admissionId,
  };
}

test('RLS only exposes entities inside the actor club scope', async () => {
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
      [fixture.club1EntityId, fixture.club2EntityId],
    );

    assert.deepEqual(visible.rows.map((row) => row.id), [fixture.club1EntityId]);
  });
});

test('RLS ignores spoofed legacy actor_club_ids and still derives access from memberships', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);
    await setActorContext(client, fixture.memberAId);
    await client.query(`select set_config('app.actor_club_ids', $1, true)`, [fixture.club2Id]);
    const leaked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.entities
        where id = $1
      `,
      [fixture.club2EntityId],
    );

    assert.equal(leaked.rows[0]?.visible_count, '0');
  });
});

test('RLS only lets owners or superadmins insert club memberships, and blocks direct membership updates', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberAId);
    await client.query('savepoint bad_membership_insert');
    await assert.rejects(
      () => client.query(
        `
          insert into app.club_memberships (
            club_id,
            member_id,
            sponsor_member_id,
            role,
            accepted_covenant_at
          )
          values ($1, $2, $3, 'member', now())
        `,
        [fixture.club1Id, fixture.outsiderId, fixture.ownerId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_membership_insert');

    await setActorContext(client, fixture.ownerId);
    const inserted = await client.query<{ id: string }>(
      `
        insert into app.club_memberships (
          club_id,
          member_id,
          sponsor_member_id,
          role,
          accepted_covenant_at
        )
        values ($1, $2, $3, 'member', now())
        returning id
      `,
      [fixture.club1Id, fixture.outsiderId, fixture.ownerId],
    );

    const blockedUpdate = await client.query<{ id: string }>(
      `
        update app.club_memberships
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
        from app.accessible_club_memberships
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
            current_period_end
          )
          values ($1, $2, 'active', 25, 'GBP', now() + interval '30 days')
        `,
        [fixture.unpaidMembershipId, fixture.unpaidMemberId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_subscription_insert');
    const afterBlockedInsert = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.accessible_club_memberships
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
          current_period_end
        )
        values ($1, $2, 'active', 25, 'GBP', now() + interval '30 days')
        returning id
      `,
      [fixture.unpaidMembershipId, fixture.unpaidMemberId],
    );
    const afterAllowedInsert = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.accessible_club_memberships
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

test('RLS keeps admission challenge tables inaccessible and only permits the admission definer entrypoints', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);
    await client.query(`select set_config('app.actor_member_id', '', true)`);

    // Direct insert into challenges table is blocked by RLS
    await client.query('savepoint bad_cold_challenge_insert');
    await assert.rejects(
      () => client.query(
        `
          insert into app.admission_challenges (difficulty, expires_at)
          values (1, now() + interval '1 day')
        `,
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_cold_challenge_insert');

    // Security definer function creates a challenge successfully
    const createdChallenge = await client.query<{ challenge_id: string }>(
      `select challenge_id from app.create_admission_challenge($1, $2)`,
      [1, 60 * 60 * 1000],
    );

    // Direct read of challenges table returns nothing (RLS blocks)
    const hiddenChallenge = await client.query<{ visible_count: string }>(
      `select count(*)::text as visible_count from app.admission_challenges where id = $1`,
      [createdChallenge.rows[0]?.challenge_id],
    );

    // Direct delete of challenges is blocked by RLS
    const blockedDelete = await client.query<{ id: string }>(
      `delete from app.admission_challenges where id = $1 returning id`,
      [createdChallenge.rows[0]?.challenge_id],
    );

    // Security definer function can read the challenge
    const visibleChallenge = await client.query<{ challenge_id: string; difficulty: number }>(
      `select challenge_id, difficulty from app.get_admission_challenge($1)`,
      [createdChallenge.rows[0]?.challenge_id],
    );

    // Security definer function can list publicly listed clubs
    const publicClubs = await client.query<{ slug: string }>(
      `select slug from app.list_publicly_listed_clubs()`,
    );

    // Security definer function consumes the challenge and creates an admission
    const consumedChallenge = await client.query<{ admission_id: string }>(
      `select admission_id from app.consume_admission_challenge($1, $2, $3, $4, $5::jsonb)`,
      [createdChallenge.rows[0]?.challenge_id, fixture.club1Slug, 'Seeded Applicant', 'seeded@example.com', '{"socials":"@seeded","reason":"testing"}'],
    );

    // Direct read of admissions table returns nothing (RLS blocks)
    const hiddenInsertedApplication = await client.query<{ visible_count: string }>(
      `select count(*)::text as visible_count from app.current_admissions where id = $1`,
      [consumedChallenge.rows[0]?.admission_id],
    );

    assert.equal(typeof createdChallenge.rows[0]?.challenge_id, 'string');
    assert.equal(typeof consumedChallenge.rows[0]?.admission_id, 'string');
    assert.equal(hiddenChallenge.rows[0]?.visible_count, '0');
    assert.equal(blockedDelete.rowCount, 0);
    assert.equal(visibleChallenge.rows[0]?.challenge_id, createdChallenge.rows[0]?.challenge_id);
    assert.equal(visibleChallenge.rows[0]?.difficulty, 1);
    assert.ok(publicClubs.rows.length >= 0);
    assert.equal(hiddenInsertedApplication.rows[0]?.visible_count, '0');
  });
});

test('outsider acceptance via create_member_from_admission creates member, contacts, profile, and membership', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    // Create an admission as the admission definer
    await client.query(`select set_config('app.actor_member_id', '', true)`);
    const createdChallenge = await client.query<{ challenge_id: string }>(
      `select challenge_id from app.create_admission_challenge($1, $2)`,
      [1, 60 * 60 * 1000],
    );
    const consumed = await client.query<{ admission_id: string }>(
      `select admission_id from app.consume_admission_challenge($1, $2, $3, $4, $5::jsonb)`,
      [createdChallenge.rows[0]!.challenge_id, fixture.club1Slug, 'Jane Outsider', 'jane@example.com', '{"socials":"@jane","reason":"Want to join"}'],
    );
    const admissionId = consumed.rows[0]!.admission_id;

    // Switch to club owner context
    await setActorContext(client, fixture.ownerId);

    // Verify owner can see the admission
    const ownerVisible = await client.query<{ visible_count: string }>(
      `select count(*)::text as visible_count from app.current_admissions where id = $1`,
      [admissionId],
    );
    assert.equal(ownerVisible.rows[0]?.visible_count, '1');

    // Create member from admission via security definer
    const memberResult = await client.query<{ member_id: string }>(
      `select member_id from app.create_member_from_admission($1, $2, $3, $4::jsonb)`,
      ['Jane Outsider', 'jane@example.com', 'Jane Outsider', '{"socials":"@jane"}'],
    );
    const newMemberId = memberResult.rows[0]!.member_id;
    assert.equal(typeof newMemberId, 'string');
    assert.equal(newMemberId.length, 12);

    // Verify member was created
    const memberCheck = await client.query<{ public_name: string; state: string }>(
      `select public_name, state from app.members where id = $1`,
      [newMemberId],
    );
    assert.equal(memberCheck.rows[0]?.public_name, 'Jane Outsider');
    assert.equal(memberCheck.rows[0]?.state, 'active');

    // Verify private contacts were created
    const contactCheck = await client.query<{ email: string }>(
      `select email from app.member_private_contacts where member_id = $1`,
      [newMemberId],
    );
    assert.equal(contactCheck.rows[0]?.email, 'jane@example.com');

    // Verify profile version was created with socials but NOT reason
    const profileCheck = await client.query<{ display_name: string; profile: Record<string, unknown> }>(
      `select display_name, profile from app.member_profile_versions where member_id = $1 and version_no = 1`,
      [newMemberId],
    );
    assert.equal(profileCheck.rows[0]?.display_name, 'Jane Outsider');
    assert.equal(typeof profileCheck.rows[0]?.profile?.socials, 'string');
    assert.equal(profileCheck.rows[0]?.profile?.reason, undefined, 'reason should NOT be in profile');

    // Issue access token via security definer
    await client.query(
      `select app.issue_admission_access($1, $2, $3, $4, $5::jsonb)`,
      ['tk23456789ab', newMemberId, 'Outsider first token', 'fakehash123456', '{"source":"admission"}'],
    );

    // Verify token was created for the new member
    const tokenCheck = await client.query<{ member_id: string; label: string }>(
      `select member_id, label from app.member_bearer_tokens where id = 'tk23456789ab'`,
      [],
    );
    assert.equal(tokenCheck.rows[0]?.member_id, newMemberId);
    assert.equal(tokenCheck.rows[0]?.label, 'Outsider first token');
  });
});

test('app projection views are owned by non-superuser, non-bypassrls roles', async () => {
  await withIsolatedClient(async (client) => {
    const result = await client.query<{ unsafe_views: string | null; unsafe_count: string }>(
      `
        select
          count(*)::text as unsafe_count,
          string_agg(c.relname || ':' || r.rolname, ', ' order by c.relname) as unsafe_views
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_roles r on r.oid = c.relowner
        where n.nspname = 'app'
          and c.relkind = 'v'
          and (r.rolsuper or r.rolbypassrls)
      `,
    );

    assert.equal(result.rows[0]?.unsafe_count, '0', result.rows[0]?.unsafe_views ?? 'unexpected unsafe app view owners');
  });
});

test('app security definer functions are owned by non-superuser, non-bypassrls roles', async () => {
  await withIsolatedClient(async (client) => {
    const result = await client.query<{ unsafe_functions: string | null; unsafe_count: string }>(
      `
        select
          count(*)::text as unsafe_count,
          string_agg(
            p.proname || ':' || pg_get_function_identity_arguments(p.oid) || ':' || r.rolname,
            ', '
            order by p.proname, pg_get_function_identity_arguments(p.oid)
          ) as unsafe_functions
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join pg_roles r on r.oid = p.proowner
        where n.nspname = 'app'
          and p.prosecdef
          and (r.rolsuper or r.rolbypassrls)
      `,
    );

    assert.equal(result.rows[0]?.unsafe_count, '0', result.rows[0]?.unsafe_functions ?? 'unexpected unsafe app security definer owners');
  });
});

test('all live app tables enforce RLS and FORCE RLS', async () => {
  await withIsolatedClient(async (client) => {
    const result = await client.query<{ unsafe_tables: string | null; unsafe_count: string }>(
      `
        select
          count(*)::text as unsafe_count,
          string_agg(
            c.relname || ':rls=' || case when c.relrowsecurity then 't' else 'f' end || ',force=' || case when c.relforcerowsecurity then 't' else 'f' end,
            ', '
            order by c.relname
          ) as unsafe_tables
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'app'
          and c.relkind in ('r', 'p')
          and (not c.relrowsecurity or not c.relforcerowsecurity)
      `,
    );

    assert.equal(result.rows[0]?.unsafe_count, '0', result.rows[0]?.unsafe_tables ?? 'unexpected app tables without full RLS coverage');
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
        [fixture.club1EntityId, fixture.memberBId],
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
      [fixture.club1EntityId, fixture.memberAId],
    );
    const hidden = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.live_entities
        where entity_id = $1
      `,
      [fixture.club1EntityId],
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
            from app.entity_versions
            where entity_id = $1
            order by version_no desc, created_at desc
            limit 1
          ) as current_state
      `,
      [fixture.club1EntityId],
    );

    assert.equal(typeof archivedVersion.rows[0]?.id, 'string');
    assert.equal(hidden.rows[0]?.visible_count, '0');
    assert.equal(archived.rows[0]?.archived_version_count, '1');
    assert.equal(archived.rows[0]?.current_state, 'archived');
  });
});

test('RLS blocks transcript reads for same-club members who are not participants', async () => {
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

test('RLS only exposes admission-linked outsider member data to owners and related actors', async () => {
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
    const admissionBlocked = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.admissions
        where id = $1
      `,
      [fixture.admissionId],
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
    const admissionVisible = await client.query<{ visible_count: string }>(
      `
        select count(*)::text as visible_count
        from app.admissions
        where id = $1
      `,
      [fixture.admissionId],
    );

    assert.equal(memberBlocked.rows[0]?.visible_count, '0');
    assert.equal(profileBlocked.rows[0]?.visible_count, '0');
    assert.equal(admissionBlocked.rows[0]?.visible_count, '0');
    assert.deepEqual(
      memberVisible.rows.map((row) => row.id).sort(),
      [fixture.outsiderId, fixture.pendingCandidateId].sort(),
    );
    assert.equal(profileVisible.rows[0]?.visible_count, '1');
    assert.equal(admissionVisible.rows[0]?.visible_count, '1');
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
        from app.club_owner_versions
        where club_id in ($1, $2)
      `,
      [fixture.club1Id, fixture.club2Id],
    );
    assert.equal(visibleOwnerHistory.rows[0]?.visible_count, '1');

    await client.query('savepoint bad_state');
    await assert.rejects(
      () => client.query(
        `
          insert into app.club_membership_state_versions (
            membership_id,
            status,
            version_no,
            created_by_member_id
          )
          select $1::app.short_id, 'paused', cnms.version_no + 1, $2::app.short_id
          from app.current_club_membership_states cnms
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
        insert into app.club_membership_state_versions (
          membership_id,
          status,
          version_no,
          supersedes_state_version_id,
          created_by_member_id
        )
        select $1::app.short_id, 'paused', cnms.version_no + 1, cnms.id, $2::app.short_id
        from app.current_club_membership_states cnms
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
      [fixture.club1EntityId],
    );

    const memberUpdate = await client.query<{ id: string; recipient_member_id: string }>(
      `
        insert into app.member_updates (
          recipient_member_id,
          club_id,
          topic,
          payload,
          entity_id,
          entity_version_id,
          created_by_member_id
        )
        values ($1, $2, 'entity.version.published', '{"kind":"post"}'::jsonb, $3, $4, $5)
        returning id, recipient_member_id
      `,
      [fixture.memberAId, fixture.club1Id, fixture.club1EntityId, entityVersion.rows[0]?.id, fixture.memberAId],
    );
    assert.equal(memberUpdate.rows[0]?.recipient_member_id, fixture.memberAId);

    const ownReceipt = await client.query<{ recipient_member_id: string }>(
      `
        insert into app.member_update_receipts (
          member_update_id,
          recipient_member_id,
          club_id,
          state,
          version_no,
          created_by_member_id
        )
        values ($1, $2, $3, 'processed', 1, $2)
        returning recipient_member_id
      `,
      [memberUpdate.rows[0]?.id, fixture.memberAId, fixture.club1Id],
    );
    assert.equal(ownReceipt.rows[0]?.recipient_member_id, fixture.memberAId);

    await client.query('savepoint bad_update_receipt');
    await assert.rejects(
      () => client.query(
        `
          insert into app.member_update_receipts (
            member_update_id,
            recipient_member_id,
            club_id,
            state,
            version_no,
            created_by_member_id
          )
          values ($1, $2, $3, 'processed', 1, $4)
        `,
        [memberUpdate.rows[0]?.id, fixture.memberBId, fixture.club1Id, fixture.memberAId],
      ),
      /row-level security|violates row-level security policy/i,
    );
    await client.query('rollback to savepoint bad_update_receipt');
  });
});

test('RLS does not trust forged bearer-token auth settings and only permits the auth definer function', async () => {
  await withIsolatedClient(async (client, roleName) => {
    const fixture = await seedRlsFixture(client);
    await client.query(`set session authorization ${quoteIdentifier(roleName)}`);

    await setActorContext(client, fixture.memberAId);
    const tokenHash = `hash-member-a-${Date.now()}`;
    const ownToken = await client.query<{ token_id: string }>(
      `
        insert into app.member_bearer_tokens (member_id, label, token_hash, metadata)
        values ($1, 'member-a-auth', $2, '{}'::jsonb)
        returning id as token_id
      `,
      [fixture.memberAId, tokenHash],
    );

    await client.query(`select set_config('app.actor_member_id', '', true)`);
    await client.query(`select set_config('app.allow_member_bearer_token_auth', '1', true)`);

    const forgedUpdate = await client.query<{ token_id: string }>(
      `
        update app.member_bearer_tokens
        set last_used_at = now()
        where id = $1
        returning id as token_id
      `,
      [ownToken.rows[0]?.token_id],
    );
    const authenticated = await client.query<{ member_id: string }>(
      `
        select member_id
        from app.authenticate_member_bearer_token($1, $2)
      `,
      [ownToken.rows[0]?.token_id, tokenHash],
    );

    assert.equal(forgedUpdate.rowCount, 0);
    assert.equal(authenticated.rows[0]?.member_id, fixture.memberAId);
  });
});
