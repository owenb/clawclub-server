import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository lists admissions with derived membership state from linked memberships', async () => {
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

      if (sql.includes('from app.current_admissions ca')) {
        return {
          rows: [{
            admission_id: 'application-9',
            club_id: 'club-2',
            applicant_member_id: 'member-9',
            applicant_public_name: 'Member Nine',
            applicant_handle: 'member-nine',
            applicant_email: null,
            applicant_name: null,
            sponsor_member_id: 'member-1',
            sponsor_public_name: 'Member One',
            sponsor_handle: 'member-one',
            membership_id: 'membership-10',
            linked_membership_status: 'pending_review',
            linked_membership_accepted_covenant_at: null,
            origin: 'member_sponsored',
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
            admission_details: null,
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
  const admissions = await repository.listAdmissions({
    actorMemberId: 'member-1',
    clubIds: ['club-2'],
    limit: 5,
    statuses: ['accepted'],
  });

  assert.equal(admissions[0]?.admissionId, 'application-9');
  assert.equal(admissions[0]?.membershipId, 'membership-10');
  assert.equal(admissions[0]?.origin, 'member_sponsored');
  assert.match(calls[2]?.sql ?? '', /left join app\.current_club_memberships cnm on cnm\.id = ca\.membership_id/);
});
