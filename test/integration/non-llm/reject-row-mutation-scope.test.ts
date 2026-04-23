import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { TestHarness } from '../harness.ts';
import { seedPublishedContent } from '../helpers.ts';

let h: TestHarness;

async function expectImmutableDeleteBlocked(client: PoolClient, tableName: string, id: string): Promise<void> {
  await client.query('savepoint immutable_delete_guard');
  await assert.rejects(
    client.query(`delete from ${tableName} where id = $1`, [id]),
    (error: unknown) => {
      const err = error as { message?: string };
      assert.match(
        String(err.message ?? ''),
        new RegExp(`Rows in public\\.${tableName} are immutable`),
      );
      return true;
    },
  );
  await client.query('rollback to savepoint immutable_delete_guard');
}

before(async () => {
  h = await TestHarness.start();
}, { timeout: 60_000 });

after(async () => {
  await h?.stop();
}, { timeout: 15_000 });

describe('reject_row_mutation scope narrowing', () => {
  it('permits deletes only for the immutable table whose local GUC is enabled', async () => {
    const owner = await h.seedOwner('immutable-scope-club', 'Immutable Scope Club');
    const member = await h.seedCompedMember(owner.club.id, 'Immutable Scope Member');
    const applicant = await h.seedMember('Immutable Scope Applicant');
    const application = await h.seedApplication(owner.club.id, applicant.id);
    const seededContent = await seedPublishedContent(h, {
      clubId: owner.club.id,
      authorMemberId: member.id,
      kind: 'post',
      title: 'Immutable Scope Content',
      body: 'Used to exercise append-only version table deletes.',
    });

    const [membershipState] = await h.sqlClubs<{ id: string }>(
      `select id
         from current_club_membership_states
        where membership_id = $1`,
      [member.membership.id],
    );
    const [profileVersion] = await h.sqlClubs<{ id: string }>(
      `select id
         from current_member_club_profiles
        where membership_id = $1`,
      [member.membership.id],
    );
    const [applicationRevision] = await h.sqlClubs<{ id: string }>(
      `select id
         from club_application_revisions
        where application_id = $1
        order by version_no desc
        limit 1`,
      [application.id],
    );

    assert.ok(membershipState, 'expected a membership state version');
    assert.ok(profileVersion, 'expected a club profile version');
    assert.ok(applicationRevision, 'expected an application revision');

    const client = await h.pools.super.connect();
    try {
      await client.query('begin');
      await client.query(`set local app.allow_delete_content_versions = '1'`);

      const deletedContentVersion = await client.query(
        `delete from content_versions where id = $1`,
        [seededContent.contentVersionId],
      );
      assert.equal(deletedContentVersion.rowCount, 1);

      await expectImmutableDeleteBlocked(client, 'club_application_revisions', applicationRevision.id);
      await expectImmutableDeleteBlocked(client, 'club_membership_state_versions', membershipState.id);
      await expectImmutableDeleteBlocked(client, 'member_club_profile_versions', profileVersion.id);

      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
