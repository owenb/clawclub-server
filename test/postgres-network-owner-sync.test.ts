import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for network owner sync tests');
  }
  return databaseUrl;
}

test('network owner root column mirrors owner history and rejects direct updates', async () => {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const client = await pool.connect();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  try {
    await client.query('begin');

    const originalOwnerId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
      [`Original Owner ${suffix}`, `auth|original-owner-${suffix}`, `original-owner-${suffix}`],
    )).rows[0]!.id;

    const nextOwnerId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, auth_subject, handle) values ($1, $2, $3) returning id`,
      [`Next Owner ${suffix}`, `auth|next-owner-${suffix}`, `next-owner-${suffix}`],
    )).rows[0]!.id;

    await client.query(
      `
        insert into app.member_global_role_versions (member_id, role, status, version_no, created_by_member_id)
        values ($1, 'superadmin', 'active', 1, $1)
      `,
      [originalOwnerId],
    );

    await client.query(
      `select set_config('app.actor_member_id', $1, true)`,
      [originalOwnerId],
    );

    const networkId = (await client.query<{ id: string }>(
      `insert into app.networks (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
      [`owner-sync-${suffix}`, `Owner Sync ${suffix}`, originalOwnerId, 'Owner compatibility sync test'],
    )).rows[0]!.id;

    await client.query(
      `
        insert into app.network_owner_versions (
          network_id,
          owner_member_id,
          version_no,
          created_by_member_id
        )
        values ($1, $2, 1, $3)
      `,
      [networkId, originalOwnerId, originalOwnerId],
    );

    await client.query(
      `
        insert into app.network_owner_versions (
          network_id,
          owner_member_id,
          version_no,
          supersedes_owner_version_id,
          created_by_member_id
        )
        select $1::app.short_id, $2::app.short_id, 2, cno.id, $3::app.short_id
        from app.current_network_owners cno
        where cno.network_id = $1::app.short_id
      `,
      [networkId, nextOwnerId, originalOwnerId],
    );

    const mirroredOwner = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from app.networks where id = $1`,
      [networkId],
    );

    assert.equal(mirroredOwner.rows[0]?.owner_member_id, nextOwnerId);

    await assert.rejects(
      client.query(`update app.networks set owner_member_id = $2 where id = $1`, [networkId, originalOwnerId]),
      /network_owner_versions/,
    );
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end();
  }
});
