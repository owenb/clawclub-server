import type { Pool } from 'pg';
import type { DbClient } from '../db.ts';
import { withTransaction } from '../db.ts';
import { AppError } from '../errors.ts';
import { withIdempotency } from '../idempotency.ts';
import type { RemoveMemberInput, RemovedMemberSummary } from '../repository.ts';

type LockedMemberRow = {
  member_id: string;
  public_name: string;
};

type BlockingClubRow = {
  club_id: string;
  slug: string;
  name: string;
};

async function lockMemberForRemoval(client: DbClient, memberId: string): Promise<LockedMemberRow | null> {
  const result = await client.query<LockedMemberRow>(
    `select id as member_id, public_name
     from members
     where id = $1
     for update
     limit 1`,
    [memberId],
  );
  return result.rows[0] ?? null;
}

async function loadActorPublicName(client: DbClient, actorMemberId: string): Promise<string> {
  const result = await client.query<{ public_name: string }>(
    `select public_name
     from members
     where id = $1
     limit 1`,
    [actorMemberId],
  );
  return result.rows[0]?.public_name ?? actorMemberId;
}

async function loadOwnedClubs(client: DbClient, memberId: string): Promise<BlockingClubRow[]> {
  const result = await client.query<BlockingClubRow>(
    `select id as club_id, slug, name
     from clubs
     where owner_member_id = $1
     order by name asc, id asc`,
    [memberId],
  );
  return result.rows;
}

async function countCrossMemberSubscriptions(client: DbClient, memberId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count
     from club_subscriptions s
     join club_memberships cm on cm.id = s.membership_id
     where s.payer_member_id = $1
       and cm.member_id <> $1`,
    [memberId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function assertRemovalAllowed(client: DbClient, input: RemoveMemberInput, target: LockedMemberRow): Promise<void> {
  if (input.reason.trim().length === 0) {
    throw new AppError('invalid_input', 'Removal reason must not be empty.');
  }
  if (input.memberId === input.actorMemberId) {
    throw new AppError('invalid_input', 'Superadmins cannot permanently delete themselves.');
  }
  if (target.public_name !== input.confirmPublicName) {
    throw new AppError('invalid_input', 'confirmPublicName must match the current member publicName exactly.');
  }

  const ownedClubs = await loadOwnedClubs(client, input.memberId);
  if (ownedClubs.length > 0) {
    throw new AppError('member_delete_blocked', 'Member cannot be removed while they still own clubs.', {
      details: {
        ownedClubs: ownedClubs.map((club) => ({
          clubId: club.club_id,
          slug: club.slug,
          name: club.name,
        })),
      },
    });
  }

  const superadminResult = await client.query<{
    target_is_active_superadmin: boolean;
    other_active_superadmins: number;
  }>(
    `select
       exists(
         select 1
         from current_member_global_roles gr
         join members m on m.id = gr.member_id
         where gr.member_id = $1
           and gr.role = 'superadmin'
           and m.state = 'active'
       ) as target_is_active_superadmin,
       (
         select count(*)::int
         from current_member_global_roles gr
         join members m on m.id = gr.member_id
         where gr.role = 'superadmin'
           and gr.member_id <> $1
           and m.state = 'active'
       ) as other_active_superadmins`,
    [input.memberId],
  );
  const superadmin = superadminResult.rows[0];
  if (superadmin?.target_is_active_superadmin && (superadmin.other_active_superadmins ?? 0) === 0) {
    throw new AppError('member_delete_blocked', 'Cannot remove the last active superadmin.', {
      details: {
        otherActiveSuperadmins: superadmin.other_active_superadmins ?? 0,
      },
    });
  }

  const crossMemberSubscriptions = await countCrossMemberSubscriptions(client, input.memberId);
  if (crossMemberSubscriptions > 0) {
    throw new AppError(
      'member_delete_blocked',
      'Member cannot be removed while they are the payer on another member\'s subscription.',
      {
        details: {
          crossMemberSubscriptionCount: crossMemberSubscriptions,
        },
      },
    );
  }
}

export async function removeMember(pool: Pool, input: RemoveMemberInput): Promise<RemovedMemberSummary | null> {
  const performRemove = async (client: DbClient): Promise<RemovedMemberSummary | null> => {
    // Hard delete is rare and destructive. Serialize it so concurrent
    // superadmin removals cannot race the "last active superadmin" guard.
    await client.query(`select pg_advisory_xact_lock(hashtext($1))`, ['superadmin.members.remove']);

    const target = await lockMemberForRemoval(client, input.memberId);
    if (!target) {
      throw new AppError('member_not_found', 'Member not found.');
    }

    await assertRemovalAllowed(client, input, target);

    const actorPublicName = await loadActorPublicName(client, input.actorMemberId);
    const removedAt = (
      await client.query<{ removed_at: string }>(`select now()::text as removed_at`)
    ).rows[0]?.removed_at ?? new Date().toISOString();

    await client.query(`set local app.allow_member_reference_detach = '1'`);
    await client.query(`set local app.allow_delete_club_application_revisions = '1'`);
    await client.query(`set local app.allow_delete_club_membership_state_versions = '1'`);
    await client.query(`set local app.allow_delete_content_versions = '1'`);
    await client.query(`set local app.allow_delete_member_club_profile_versions = '1'`);

    const deletedQuotaEventLogEntries = (
      await client.query(`delete from ai_quota_event_log where member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    const deletedAccessTokens = (
      await client.query(`delete from member_bearer_tokens where member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    const deletedNotifications = (
      await client.query(`delete from member_notifications where recipient_member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    // Count invitations where the target was the sponsor. After the member row is
    // deleted, invitations_sponsor_fkey (ON DELETE SET NULL) nulls sponsor_member_id
    // automatically; invitation rows are preserved as historical records.
    const sponsoredInvitationCount = Number((
      await client.query<{ count: string }>(
        `select count(*)::text as count from invite_requests where sponsor_member_id = $1`,
        [input.memberId],
      )
    ).rows[0]?.count ?? 0);

    const deletedClubEdges = (
      await client.query(
        `delete from club_edges
         where from_member_id = $1
            or to_member_id = $1
            or created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    await client.query(`delete from club_activity_cursors where member_id = $1`, [input.memberId]);
    await client.query(`delete from content_version_mentions where mentioned_member_id = $1`, [input.memberId]);
    await client.query(`delete from dm_message_mentions where mentioned_member_id = $1`, [input.memberId]);
    await client.query(`delete from member_profile_embeddings where member_id = $1`, [input.memberId]);
    // Clear direct recipient/remover rows first. The later thread-scoped pass cleans
    // up rows owned by other members inside threads that are being deleted.
    await client.query(`delete from dm_message_removals where removed_by_member_id = $1`, [input.memberId]);
    await client.query(`delete from dm_inbox_entries where recipient_member_id = $1`, [input.memberId]);

    const dmThreadRows = await client.query<{ thread_id: string }>(
      `select distinct thread_id
       from (
         select dtp.thread_id
         from dm_thread_participants dtp
         where dtp.member_id = $1

         union

         select dt.id as thread_id
         from dm_threads dt
         where dt.member_a_id = $1
            or dt.member_b_id = $1
            or dt.created_by_member_id = $1

         union

         select dm.thread_id
         from dm_messages dm
         where dm.sender_member_id = $1
       ) matched_threads
       order by thread_id asc`,
      [input.memberId],
    );
    const dmThreadIds = dmThreadRows.rows.map((row) => row.thread_id);

    let deletedDirectMessages = 0;
    let deletedDirectMessageThreads = 0;
    if (dmThreadIds.length > 0) {
      deletedDirectMessages = Number((
        await client.query<{ count: string }>(
          `select count(*)::text as count
           from dm_messages
           where thread_id = any($1::text[])`,
          [dmThreadIds],
        )
      ).rows[0]?.count ?? 0);

      await client.query(
        `delete from dm_message_mentions
         where message_id in (
           select id from dm_messages where thread_id = any($1::text[])
         )`,
        [dmThreadIds],
      );
      await client.query(
        `delete from dm_message_removals
         where message_id in (
              select id from dm_messages where thread_id = any($1::text[])
            )`,
        [dmThreadIds],
      );
      await client.query(
        `delete from dm_inbox_entries
         where thread_id = any($1::text[])
            or message_id in (
              select id from dm_messages where thread_id = any($1::text[])
            )`,
        [dmThreadIds],
      );
      await client.query(`delete from dm_messages where thread_id = any($1::text[])`, [dmThreadIds]);
      await client.query(`delete from dm_thread_participants where thread_id = any($1::text[])`, [dmThreadIds]);
      deletedDirectMessageThreads = (
        await client.query(`delete from dm_threads where id = any($1::text[])`, [dmThreadIds])
      ).rowCount ?? 0;
    }

    const authoredThreadRows = await client.query<{ thread_id: string }>(
      `select distinct thread_id
       from contents
       where author_member_id = $1
       order by thread_id asc`,
      [input.memberId],
    );
    const authoredThreadIds = authoredThreadRows.rows.map((row) => row.thread_id);

    const deletedContents = (
      await client.query(`delete from contents where author_member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    if (authoredThreadIds.length > 0) {
      await client.query(
        `delete from content_threads
         where id = any($1::text[])
           and not exists (
             select 1
             from contents
             where contents.thread_id = content_threads.id
           )`,
        [authoredThreadIds],
      );
    }

    const deletedApplications = (
      await client.query(`delete from club_applications where applicant_member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    await client.query(`delete from club_applicant_blocks where member_id = $1`, [input.memberId]);
    await client.query(`delete from member_club_profile_versions where member_id = $1`, [input.memberId]);

    const deletedMemberships = (
      await client.query(`delete from club_memberships where member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    const deletedGlobalRoleVersions = (
      await client.query(`delete from member_global_role_versions where member_id = $1`, [input.memberId])
    ).rowCount ?? 0;

    const detachedMembershipSponsors = (
      await client.query(
        `update club_memberships
         set sponsor_member_id = null
         where sponsor_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;
    await client.query(
      `update club_memberships
       set comped_by_member_id = null
       where comped_by_member_id = $1`,
      [input.memberId],
    );

    const detachedMembershipStateVersions = (
      await client.query(
        `update club_membership_state_versions
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedClubActivities = (
      await client.query(
        `update club_activity
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedClubVersionCreators = (
      await client.query(
        `update club_versions
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;
    const detachedClubVersionOwners = (
      await client.query(
        `update club_versions
         set owner_member_id = null
         where owner_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedContentVersions = (
      await client.query(
        `update content_versions
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedProfileVersions = (
      await client.query(
        `update member_club_profile_versions
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedContentThreads = (
      await client.query(
        `update content_threads
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedLlmOutputReservations = (
      await client.query(
        `update ai_llm_quota_reservations
         set member_id = null
         where member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedSpendReservations = (
      await client.query(
        `update ai_club_spend_reservations
         set member_id = null
         where member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedLlmUsageLogEntries = (
      await client.query(
        `update ai_llm_usage_log
         set member_id = null
         where member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedRoleVersionCreators = (
      await client.query(
        `update member_global_role_versions
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const detachedEventRsvps = (
      await client.query(
        `update event_rsvps
         set created_by_member_id = null
         where created_by_member_id = $1`,
        [input.memberId],
      )
    ).rowCount ?? 0;

    const deletedMembers = (
      await client.query(`delete from members where id = $1`, [input.memberId])
    ).rowCount ?? 0;

    if (deletedMembers !== 1) {
      throw new AppError('missing_row', 'Member row was not deleted.');
    }

    return {
      memberId: target.member_id,
      publicName: target.public_name,
      removedAt,
      removedByMember: {
        memberId: input.actorMemberId,
        publicName: actorPublicName,
      },
      reason: input.reason,
      deleted: {
        applications: deletedApplications,
        memberships: deletedMemberships,
        accessTokens: deletedAccessTokens,
        contents: deletedContents,
        directMessageThreads: deletedDirectMessageThreads,
        directMessages: deletedDirectMessages,
        notifications: deletedNotifications,
        clubEdges: deletedClubEdges,
        globalRoleVersions: deletedGlobalRoleVersions,
        quotaEventLogEntries: deletedQuotaEventLogEntries,
      },
      detached: {
        membershipSponsors: detachedMembershipSponsors,
        membershipStateVersions: detachedMembershipStateVersions,
        clubActivities: detachedClubActivities,
        clubVersions: detachedClubVersionCreators + detachedClubVersionOwners,
        contentVersions: detachedContentVersions,
        profileVersions: detachedProfileVersions,
        contentThreads: detachedContentThreads,
        llmOutputReservations: detachedLlmOutputReservations,
        spendReservations: detachedSpendReservations,
        llmUsageLogEntries: detachedLlmUsageLogEntries,
        roleVersionCreators: detachedRoleVersionCreators,
        eventRsvps: detachedEventRsvps,
        sponsoredInvitations: sponsoredInvitationCount,
      },
    };
  };

  if (!input.clientKey) {
    return withTransaction(pool, performRemove);
  }

  return withTransaction(pool, async (client) => withIdempotency(client, {
    clientKey: input.clientKey!,
    actorContext: input.idempotencyActorContext ?? `superadmin:${input.actorMemberId}:members.remove:${input.memberId}`,
    requestValue: input.idempotencyRequestValue ?? {
      memberId: input.memberId,
      confirmPublicName: input.confirmPublicName,
      reason: input.reason,
    },
    execute: async () => ({ responseValue: await performRemove(client) }),
  }));
}
