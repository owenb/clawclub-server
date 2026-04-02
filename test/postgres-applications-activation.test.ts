import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository lists applications with derived activation state from linked memberships', async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });

      if (sql === 'begin' || sql === 'commit' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('from app.current_applications ca')) {
        return {
          rows: [{
            application_id: 'application-9',
            club_id: 'club-2',
            applicant_member_id: 'member-9',
            applicant_public_name: 'Member Nine',
            applicant_handle: 'member-nine',
            sponsor_member_id: 'member-1',
            sponsor_public_name: 'Member One',
            sponsor_handle: 'member-one',
            membership_id: 'membership-10',
            linked_membership_status: 'pending_review',
            linked_membership_accepted_covenant_at: null,
            path: 'sponsored',
            intake_kind: 'fit_check',
            intake_price_amount: '49.00',
            intake_price_currency: 'GBP',
            intake_booking_url: 'https://cal.example.test/fit-check',
            intake_booked_at: '2026-03-14T10:00:00Z',
            intake_completed_at: '2026-03-14T10:30:00Z',
            status: 'accepted',
            notes: 'Strong yes',
            version_no: 3,
            version_created_at: '2026-03-14T10:30:00Z',
            version_created_by_member_id: 'member-1',
            metadata: { source: 'operator' },
            created_at: '2026-03-12T00:00:00Z',
          }],
          rowCount: 1,
        };
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const applications = await repository.listApplications({
    actorMemberId: 'member-1',
    clubIds: ['club-2'],
    limit: 5,
    statuses: ['accepted'],
  });

  assert.equal(applications[0]?.applicationId, 'application-9');
  assert.deepEqual(applications[0]?.activation, {
    linkedMembershipId: 'membership-10',
    membershipStatus: 'pending_review',
    acceptedCovenantAt: null,
    readyForActivation: true,
  });
  assert.match(calls[2]?.sql ?? '', /left join app\.current_club_memberships cnm on cnm\.id = ca\.membership_id/);
});
