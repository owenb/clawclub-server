import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository rejects activation-through-application when interview completion metadata is missing', async () => {
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (sql === 'begin' || sql === 'rollback') {
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set_config('app.actor_member_id'")) {
        return { rows: [{ set_config: 'member-1' }], rowCount: 1 };
      }

      if (sql.includes('from app.current_applications ca') && sql.includes('current_membership_id')) {
        return {
          rows: [{
            application_id: 'application-9',
            network_id: 'network-2',
            applicant_member_id: 'member-9',
            current_status: 'interview_completed',
            current_version_no: 2,
            current_version_id: 'appver-2',
            current_metadata: { source: 'operator' },
            current_intake_kind: 'fit_check',
            current_intake_price_amount: '49.00',
            current_intake_price_currency: 'GBP',
            current_intake_booking_url: 'https://cal.example.test/fit-check',
            current_intake_booked_at: '2026-03-14T10:00:00Z',
            current_intake_completed_at: null,
            current_membership_id: 'membership-10',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('select cnm.id as membership_id') && sql.includes('where cnm.id = $1')) {
        return { rows: [{ membership_id: 'membership-10' }], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${sql} :: ${JSON.stringify(params)}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });

  await assert.rejects(
    () => repository.transitionApplication({
      actorMemberId: 'member-1',
      applicationId: 'application-9',
      nextStatus: 'accepted',
      notes: 'Strong yes',
      accessibleNetworkIds: ['network-2'],
      membershipId: 'membership-10',
      activateMembership: true,
      activationReason: 'Interview passed',
    }),
    /interview completion metadata/,
  );
});
