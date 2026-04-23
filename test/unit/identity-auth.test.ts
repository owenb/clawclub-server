import test from 'node:test';
import assert from 'node:assert/strict';
import { readActor } from '../../src/identity/auth.ts';

test('readActor accepts JSONB role arrays and filters unknown roles', async () => {
  const actor = await readActor({
    async query() {
      return {
        rows: [{
          member_id: 'member-1',
          public_name: 'Alice',
          global_roles: ['superadmin', 'mystery_role'],
          membership_id: null,
          club_id: null,
          slug: null,
          club_name: null,
          club_summary: null,
          role: null,
          is_owner: null,
          status: null,
          sponsor_member_id: null,
          sponsor_public_name: null,
          joined_at: null,
        }],
      };
    },
  } as never, 'member-1');

  assert.deepEqual(actor?.globalRoles, ['superadmin']);
});

