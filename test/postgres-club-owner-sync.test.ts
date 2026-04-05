import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

function requireDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set for club version sync tests');
  }
  return databaseUrl;
}

test('club versioned fields mirror club_versions and reject direct updates', async () => {
  const pool = new Pool({ connectionString: requireDatabaseUrl() });
  const client = await pool.connect();
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  try {
    await client.query('begin');

    const originalOwnerId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, handle) values ($1, $2) returning id`,
      [`Original Owner ${suffix}`, `original-owner-${suffix}`],
    )).rows[0]!.id;

    const nextOwnerId = (await client.query<{ id: string }>(
      `insert into app.members (public_name, handle) values ($1, $2) returning id`,
      [`Next Owner ${suffix}`, `next-owner-${suffix}`],
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

    const clubId = (await client.query<{ id: string }>(
      `insert into app.clubs (slug, name, owner_member_id, summary) values ($1, $2, $3, $4) returning id`,
      [`ver-sync-${suffix}`, `Version Sync ${suffix}`, originalOwnerId, 'Version compatibility sync test'],
    )).rows[0]!.id;

    await client.query(
      `
        insert into app.club_versions (
          club_id, owner_member_id, name, summary,
          admission_policy,
          version_no, created_by_member_id
        )
        values ($1, $2, $3, $4, null, 1, $5)
      `,
      [clubId, originalOwnerId, `Version Sync ${suffix}`, 'Version compatibility sync test', originalOwnerId],
    );

    // Owner change via club_versions
    await client.query(
      `
        insert into app.club_versions (
          club_id, owner_member_id, name, summary,
          admission_policy,
          version_no, supersedes_version_id, created_by_member_id
        )
        select $1::app.short_id, $2::app.short_id, cv.name, cv.summary,
               cv.admission_policy,
               2, cv.id, $3::app.short_id
        from app.current_club_versions cv
        where cv.club_id = $1::app.short_id
      `,
      [clubId, nextOwnerId, originalOwnerId],
    );

    const mirroredOwner = await client.query<{ owner_member_id: string }>(
      `select owner_member_id from app.clubs where id = $1`,
      [clubId],
    );

    assert.equal(mirroredOwner.rows[0]?.owner_member_id, nextOwnerId);

    // Direct mutation of owner_member_id is rejected
    await client.query('savepoint sp1');
    await assert.rejects(
      client.query(`update app.clubs set owner_member_id = $2 where id = $1`, [clubId, originalOwnerId]),
      /club_versions/,
    );
    await client.query('rollback to savepoint sp1');

    // Direct mutation of name is rejected
    await client.query('savepoint sp2');
    await assert.rejects(
      client.query(`update app.clubs set name = 'Direct Change' where id = $1`, [clubId]),
      /club_versions/,
    );
    await client.query('rollback to savepoint sp2');
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
    await pool.end();
  }
});
