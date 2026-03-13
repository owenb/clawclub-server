import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for membership state sync tests');
  }
  return databaseUrl;
}

test('network membership root status and left_at mirror the latest state version', async () => {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const client = await pool.connect();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  try {
    await client.query('begin');

    const ownerId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
      [`Mirror Owner ${suffix}`, `auth|mirror-owner-${suffix}`, `mirror-owner-${suffix}`],
    )).rows[0]!.id;

    const memberId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
      [`Mirror Member ${suffix}`, `auth|mirror-member-${suffix}`, `mirror-member-${suffix}`],
    )).rows[0]!.id;

    await client.query(
      `
        insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
        values ($1, 'superadmin', 'active', 1, $1)
      `,
      [ownerId],
    );

    await client.query(
      `select set_config('app.actor_member_id', $1, true)`,
      [ownerId],
    );

    const networkId = (await client.query<{ id: string }>(
      `insert into app.networks (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
      [`mirror-network-${suffix}`, `Mirror Network ${suffix}`, ownerId, 'Compatibility sync test'],
    )).rows[0]!.id;

    const membershipId = (await client.query<{ id: string }>(
      `
        insert into app.network_memberships (
          network_id,
          member_id,
          sponsor_member_id,
          status
        )
        values ($1, $2, $3, 'invited')
        returning id
      `,
      [networkId, memberId, ownerId],
    )).rows[0]!.id;

    const invitedAt = (await client.query<{ created_at: string }>(
      `
        insert into app.network_membership_state_versions (
          membership_id,
          status,
          version_no,
          created_by_member_id
        )
        values ($1, 'invited', 1, $2)
        returning created_at::text
      `,
      [membershipId, ownerId],
    )).rows[0]!.created_at;

    const invited = await client.query<{ status: string; left_at: string | null }>(
      `select status::text, left_at::text from app.network_memberships where id = $1`,
      [membershipId],
    );

    assert.equal(invited.rows[0]?.status, 'invited');
    assert.equal(invited.rows[0]?.left_at, null);
    assert.equal(typeof invitedAt, 'string');

    const revokedAt = (await client.query<{ created_at: string }>(
      `
        insert into app.network_membership_state_versions (
          membership_id,
          status,
          version_no,
          supersedes_state_version_id,
          created_by_member_id
        )
        select $1::app.short_id, 'revoked', 2, cnms.id, $2::app.short_id
        from app.current_network_membership_states cnms
        where cnms.membership_id = $1::app.short_id
        returning created_at::text
      `,
      [membershipId, ownerId],
    )).rows[0]!.created_at;

    const revoked = await client.query<{ status: string; left_at: string | null }>(
      `select status::text, left_at::text from app.network_memberships where id = $1`,
      [membershipId],
    );

    assert.equal(revoked.rows[0]?.status, 'revoked');
    assert.equal(revoked.rows[0]?.left_at, revokedAt);

    await client.query(
      `
        insert into app.network_membership_state_versions (
          membership_id,
          status,
          version_no,
          supersedes_state_version_id,
          created_by_member_id
        )
        select $1::app.short_id, 'active', 3, cnms.id, $2::app.short_id
        from app.current_network_membership_states cnms
        where cnms.membership_id = $1::app.short_id
      `,
      [membershipId, ownerId],
    );

    const reactivated = await client.query<{ status: string; left_at: string | null }>(
      `select status::text, left_at::text from app.network_memberships where id = $1`,
      [membershipId],
    );

    assert.equal(reactivated.rows[0]?.status, 'active');
    assert.equal(reactivated.rows[0]?.left_at, null);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end();
  }
});
