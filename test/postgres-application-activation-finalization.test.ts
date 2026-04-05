import test from 'node:test';
import assert from 'node:assert/strict';
import { createPostgresRepository } from '../src/postgres.ts';

test('postgres repository transition to accepted creates membership for existing member admission', async () => {
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

      if (sql.includes('from app.current_admissions ca') && sql.includes('actor_is_club_admin')) {
        return {
          rows: [{
            admission_id: 'application-9',
            club_id: 'club-2',
            applicant_member_id: 'member-9',
            applicant_name: null,
            applicant_email: null,
            current_status: 'interview_completed',
            current_version_no: 2,
            current_version_id: 'appver-2',
            current_metadata: { source: 'operator' },
            current_admission_details: null,
            current_intake_kind: 'fit_check',
            current_intake_price_amount: '49.00',
            current_intake_price_currency: 'GBP',
            current_intake_booking_url: 'https://cal.example.test/fit-check',
            current_intake_booked_at: '2026-03-14T10:00:00Z',
            current_intake_completed_at: '2026-03-14T10:30:00Z',
            current_membership_id: null,
            sponsor_member_id: 'member-1',
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('update app.admissions a')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('insert into app.admission_versions')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('insert into app.club_memberships')) {
        return { rows: [{ id: 'membership-new' }], rowCount: 1 };
      }

      if (sql.includes('insert into app.club_membership_state_versions')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('create_comped_subscription')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('update app.admissions') && sql.includes('membership_id')) {
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('from app.current_admissions ca') && sql.includes('where ca.id = $1')) {
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
            membership_id: 'membership-new',
            linked_membership_status: 'active',
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

      throw new Error(`Unexpected query: ${sql} :: ${JSON.stringify(params)}`);
    },
    release() {},
  };

  const repository = createPostgresRepository({ pool: { connect: async () => client } as any });
  const result = await repository.transitionAdmission({
    actorMemberId: 'member-1',
    admissionId: 'application-9',
    nextStatus: 'accepted',
    notes: 'Strong yes',
    accessibleClubIds: ['club-2'],
    intake: { completedAt: '2026-03-14T10:30:00Z' },
    metadataPatch: { outcome: 'strong_yes' },
  });

  assert.ok(result);
  assert.equal(result?.state.status, 'accepted');
  assert.equal(result?.membershipId, 'membership-new');
  assert.equal(result?.origin, 'member_sponsored');
});
