import test from 'node:test';
import assert from 'node:assert/strict';
import { TestHarness } from '../integration/harness.ts';
import { passthroughGate } from '../unit/fixtures.ts';

test('club lifecycle FK delete rules match the removal matrix', { concurrency: false, timeout: 60_000 }, async (t) => {
  const h = await TestHarness.start({ llmGate: passthroughGate });
  t.after(async () => {
    await h.stop();
  });

  const expected = new Map<string, 'c' | 'n'>([
    ['ai_club_spend_reservations_club_fkey', 'c'],
    ['ai_llm_quota_reservations_club_fkey', 'c'],
    ['ai_llm_usage_log_club_fkey', 'n'],
    ['club_activity_club_fkey', 'c'],
    ['club_activity_content_fkey', 'c'],
    ['club_activity_cursors_club_fkey', 'c'],
    ['club_activity_cursors_member_fkey', 'c'],
    ['club_applicant_blocks_club_id_fkey', 'c'],
    ['club_applicant_blocks_created_by_member_id_fkey', 'n'],
    ['club_applicant_blocks_member_id_fkey', 'c'],
    ['club_applications_activated_membership_id_fkey', 'n'],
    ['club_applications_applicant_member_id_fkey', 'c'],
    ['club_applications_club_id_fkey', 'c'],
    ['club_applications_decided_by_member_id_fkey', 'n'],
    ['club_applications_invitation_id_fkey', 'n'],
    ['club_applications_sponsor_member_id_fkey', 'n'],
    ['club_edges_club_fkey', 'c'],
    ['club_edges_from_content_fkey', 'c'],
    ['club_edges_from_content_version_fkey', 'c'],
    ['club_edges_to_content_fkey', 'c'],
    ['club_edges_to_content_version_fkey', 'c'],
    ['club_membership_state_versions_membership_fkey', 'c'],
    ['club_membership_state_versions_supersedes_fkey', 'c'],
    ['club_memberships_club_fkey', 'c'],
    ['club_subscriptions_membership_fkey', 'c'],
    ['club_versions_club_fkey', 'c'],
    ['club_versions_supersedes_fkey', 'c'],
    ['consumed_pow_challenges_club_fkey', 'c'],
    ['content_embeddings_content_fkey', 'c'],
    ['content_embeddings_version_fkey', 'c'],
    ['content_threads_club_fkey', 'c'],
    ['content_version_mentions_version_fkey', 'c'],
    ['content_versions_content_fkey', 'c'],
    ['content_versions_supersedes_fkey', 'c'],
    ['contents_club_fkey', 'c'],
    ['dm_threads_subject_content_fkey', 'n'],
    ['event_rsvps_event_content_fkey', 'c'],
    ['event_rsvps_membership_fkey', 'c'],
    ['event_rsvps_supersedes_fkey', 'c'],
    ['event_version_details_content_version_fkey', 'c'],
    ['invite_requests_candidate_member_fkey', 'n'],
    ['invite_requests_club_fkey', 'c'],
    ['invite_requests_sponsor_fkey', 'n'],
    ['invite_requests_used_membership_fkey', 'n'],
    ['member_club_profile_versions_club_fkey', 'c'],
    ['member_club_profile_versions_membership_fkey', 'c'],
    ['member_notifications_club_fkey', 'c'],
    ['member_bearer_tokens_member_fkey', 'c'],
    ['member_profile_embeddings_club_fkey', 'c'],
    ['member_profile_embeddings_member_fkey', 'c'],
    ['member_profile_embeddings_version_fkey', 'c'],
  ]);
  const trackedTables = [
    'ai_club_spend_reservations',
    'ai_llm_quota_reservations',
    'ai_llm_usage_log',
    'club_activity',
    'club_activity_cursors',
    'club_applicant_blocks',
    'club_applications',
    'club_edges',
    'club_membership_state_versions',
    'club_memberships',
    'club_subscriptions',
    'club_versions',
    'consumed_pow_challenges',
    'content_embeddings',
    'content_threads',
    'content_version_mentions',
    'content_versions',
    'contents',
    'dm_threads',
    'event_rsvps',
    'event_version_details',
    'invite_requests',
    'member_bearer_tokens',
    'member_club_profile_versions',
    'member_notifications',
    'member_profile_embeddings',
  ];

  const rows = await h.sql<{ conname: string; confdeltype: 'a' | 'r' | 'c' | 'n' | 'd' }>(
    `select conname, confdeltype
       from pg_constraint
      where contype = 'f'
        and conrelid::regclass::text = any($1::text[])
        and confdeltype in ('c', 'n')
      order by conname`,
    [trackedTables],
  );

  const actual = new Map(rows.map((row) => [row.conname, row.confdeltype]));
  assert.deepEqual(
    Object.fromEntries(actual),
    Object.fromEntries(expected),
    'club lifecycle cascade/set-null delete rules should match the removal matrix exactly',
  );
});
