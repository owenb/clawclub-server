/**
 * Postgres implementation of the Repository interface.
 *
 * Composes domain modules (identity, messaging, clubs) against a single
 * database pool. Operations that span modules (admission acceptance,
 * update streams, admin aggregation) are coordinated here.
 */

import type { Pool } from 'pg';
import { AppError, type Repository, type EntitySummary, type MembershipVouchSummary, type AdmissionStatus, type PendingUpdate } from './contract.ts';
import { withTransaction } from './db.ts';
import { createIdentityRepository, type IdentityRepository } from './identity/index.ts';
import { generateAdmissionClubProfile, normalizeClubProfileFields } from './identity/profiles.ts';
import { createMessagingRepository, type MessagingRepository } from './messages/index.ts';
import { createClubsRepository, batchListVouches, type ClubsRepository } from './clubs/index.ts';
import * as admissionsModule from './clubs/admissions.ts';
import { encodeCursor as paginationEncodeCursor } from './schemas/fields.ts';

// ── Cursor helpers ──────────────────────────────────────────

/**
 * Compound cursor: independent positions for activity, signals, and inbox.
 * Encoded as base64url JSON: { a: activitySeq, s: signalSeq, t: inboxTimestamp }
 *
 * Backward compatible: old-format cursors { s: N, t: T } are read as
 * { a: N, s: 0, t: T }, defaulting signal position to 0 so the first
 * poll returns all unacknowledged signals.
 *
 * Also accepts buggy cursors previously emitted as { a: "123", s: 0, t: T }.
 */
type UpdateCursor = { a: number; s: number; t: string };

function encodeCursor(cursor: UpdateCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function parseCursorSeq(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function decodeCursor(raw: string): UpdateCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (typeof parsed === 'object' && parsed !== null) {
      const hasActivityKey = Object.prototype.hasOwnProperty.call(parsed, 'a');
      // New compound format: { a, s, t }
      if (hasActivityKey) {
        const activitySeq = parseCursorSeq(parsed.a);
        if (activitySeq === null) return null;
        return {
          a: activitySeq,
          s: parseCursorSeq(parsed.s) ?? 0,
          t: typeof parsed.t === 'string' ? parsed.t : new Date(0).toISOString(),
        };
      }
      // Old format: { s: activitySeq, t: inboxTimestamp }
      const activitySeq = parseCursorSeq(parsed.s);
      if (activitySeq !== null) {
        return {
          a: activitySeq,
          s: 0,
          t: typeof parsed.t === 'string' ? parsed.t : new Date(0).toISOString(),
        };
      }
    }
  } catch {
    // Fall through
  }
  // Legacy: try parsing as plain number (very old cursor format)
  const n = parseCursorSeq(raw);
  if (n !== null) return { a: n, s: 0, t: new Date(0).toISOString() };
  return null;
}

// ── Enrichment helpers ──────────────────────────────────────

function mapVouchToSummary(v: { edgeId: string; fromMemberId: string; fromPublicName: string; fromHandle: string | null; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null }): MembershipVouchSummary {
  return {
    edgeId: v.edgeId,
    fromMember: { memberId: v.fromMemberId, publicName: v.fromPublicName, handle: v.fromHandle },
    reason: v.reason,
    metadata: v.metadata,
    createdAt: v.createdAt,
    createdByMemberId: v.createdByMemberId,
  };
}

/** Read an admission by ID with member display info resolved via JOIN. */
async function readAdmissionEnriched(
  db: Pool | import('pg').PoolClient,
  admissionId: string,
): Promise<import('./contract.ts').AdmissionSummary | null> {
  const result = await db.query<Record<string, unknown>>(
    `select ca.id as admission_id, ca.club_id, ca.applicant_member_id, ca.applicant_email,
            ca.applicant_name, ca.sponsor_member_id, ca.membership_id, ca.origin,
            ca.intake_kind, ca.intake_price_amount, ca.intake_price_currency,
            ca.intake_booking_url, ca.intake_booked_at::text as intake_booked_at,
            ca.intake_completed_at::text as intake_completed_at,
            ca.status, ca.notes, ca.version_no, ca.version_created_at::text as version_created_at,
            ca.version_created_by_member_id, ca.admission_details, ca.metadata,
            ca.created_at::text as created_at,
            am.public_name as applicant_public_name, am.handle as applicant_handle,
            sm.public_name as sponsor_public_name, sm.handle as sponsor_handle
     from current_admissions ca
     left join members am on am.id = ca.applicant_member_id
     left join members sm on sm.id = ca.sponsor_member_id
     where ca.id = $1 limit 1`,
    [admissionId],
  );
  const r = result.rows[0];
  if (!r) return null;
  return {
    admissionId: r.admission_id as string,
    clubId: r.club_id as string,
    applicant: {
      memberId: (r.applicant_member_id as string) ?? null,
      publicName: (r.applicant_public_name as string) ?? (r.applicant_name as string) ?? 'Unknown applicant',
      handle: (r.applicant_handle as string) ?? null,
      email: (r.applicant_email as string) ?? null,
    },
    sponsor: r.sponsor_member_id ? {
      memberId: r.sponsor_member_id as string,
      publicName: (r.sponsor_public_name as string) ?? 'Unknown sponsor',
      handle: (r.sponsor_handle as string) ?? null,
    } : null,
    membershipId: (r.membership_id as string) ?? null,
    origin: r.origin as 'self_applied' | 'member_sponsored' | 'owner_nominated',
    intake: {
      kind: (r.intake_kind as 'fit_check' | 'advice_call' | 'other') ?? 'other',
      price: { amount: r.intake_price_amount != null ? Number(r.intake_price_amount) : null, currency: (r.intake_price_currency as string) ?? null },
      bookingUrl: (r.intake_booking_url as string) ?? null,
      bookedAt: (r.intake_booked_at as string) ?? null,
      completedAt: (r.intake_completed_at as string) ?? null,
    },
    state: {
      status: r.status as AdmissionStatus,
      notes: (r.notes as string) ?? null,
      versionNo: Number(r.version_no),
      createdAt: r.version_created_at as string,
      createdByMemberId: (r.version_created_by_member_id as string) ?? null,
    },
    admissionDetails: (r.admission_details as Record<string, unknown>) ?? {},
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: r.created_at as string,
  };
}

// ── Shared-club helpers for DMs ─────────────────────────────
// DMs are not club-scoped. These helpers resolve clubs currently shared
// between two members, used only for eligibility checks and response enrichment.

type SharedClubRow = { club_id: string; slug: string; name: string };

/** Resolve shared clubs between actor and another member, scoped to actor's accessible clubs. */
async function resolveSharedClubs(
  pool: Pool, actorMemberId: string, otherMemberId: string, accessibleClubIds: string[],
): Promise<Array<{ clubId: string; slug: string; name: string }>> {
  const result = await pool.query<SharedClubRow>(
    `select c.id as club_id, c.slug, c.name
     from accessible_club_memberships a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = $3
     join clubs c on c.id = a.club_id and c.archived_at is null
     where a.member_id = $1 and a.club_id = any($2::text[])
     order by c.name asc`,
    [actorMemberId, accessibleClubIds, otherMemberId],
  );
  return result.rows.map(r => ({ clubId: r.club_id, slug: r.slug, name: r.name }));
}

/** Resolve shared clubs between two members without scoping to accessible clubs. */
async function resolveSharedClubsUnscoped(
  pool: Pool, memberA: string, memberB: string,
): Promise<Array<{ clubId: string; slug: string; name: string }>> {
  const result = await pool.query<SharedClubRow>(
    `select c.id as club_id, c.slug, c.name
     from accessible_club_memberships a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = $2
     join clubs c on c.id = a.club_id and c.archived_at is null
     where a.member_id = $1
     order by c.name asc`,
    [memberA, memberB],
  );
  return result.rows.map(r => ({ clubId: r.club_id, slug: r.slug, name: r.name }));
}

/** Batch-resolve shared clubs for multiple counterparts in one query. */
async function batchResolveSharedClubs(
  pool: Pool, actorMemberId: string, counterpartMemberIds: string[],
): Promise<Map<string, Array<{ clubId: string; slug: string; name: string }>>> {
  const map = new Map<string, Array<{ clubId: string; slug: string; name: string }>>();
  if (counterpartMemberIds.length === 0) return map;

  const result = await pool.query<SharedClubRow & { counterpart_member_id: string }>(
    `select b.member_id as counterpart_member_id, c.id as club_id, c.slug, c.name
     from accessible_club_memberships a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = any($2::text[])
     join clubs c on c.id = a.club_id and c.archived_at is null
     where a.member_id = $1
     order by b.member_id, c.name asc`,
    [actorMemberId, counterpartMemberIds],
  );

  for (const r of result.rows) {
    let arr = map.get(r.counterpart_member_id);
    if (!arr) {
      arr = [];
      map.set(r.counterpart_member_id, arr);
    }
    arr.push({ clubId: r.club_id, slug: r.slug, name: r.name });
  }
  return map;
}

/** Batch-resolve shared clubs for multiple member pairs keyed by an opaque ID (e.g. threadId). */
async function batchResolveSharedClubsPairs(
  pool: Pool, pairs: Map<string, [string, string]>,
): Promise<Map<string, Array<{ clubId: string; slug: string; name: string }>>> {
  const result = new Map<string, Array<{ clubId: string; slug: string; name: string }>>();
  if (pairs.size === 0) return result;

  // Build VALUES list for all pairs
  const values: string[] = [];
  const params: string[] = [];
  let idx = 1;
  for (const [key, [a, b]] of pairs) {
    values.push(`($${idx}::text, $${idx + 1}::text, $${idx + 2}::text)`);
    params.push(key, a, b);
    idx += 3;
  }

  const rows = await pool.query<{ pair_key: string; club_id: string; slug: string; name: string }>(
    `with pairs(pair_key, member_a, member_b) as (values ${values.join(', ')})
     select p.pair_key, c.id as club_id, c.slug, c.name
     from pairs p
     join accessible_club_memberships a on a.member_id = p.member_a
     join accessible_club_memberships b on b.club_id = a.club_id and b.member_id = p.member_b
     join clubs c on c.id = a.club_id and c.archived_at is null
     order by p.pair_key, c.name asc`,
    params,
  );

  for (const r of rows.rows) {
    let arr = result.get(r.pair_key);
    if (!arr) {
      arr = [];
      result.set(r.pair_key, arr);
    }
    arr.push({ clubId: r.club_id, slug: r.slug, name: r.name });
  }
  return result;
}

// ── Factory ─────────────────────────────────────────────────

export function createRepository(pool: Pool): Repository {
  const identity = createIdentityRepository(pool);
  const messaging = createMessagingRepository(pool);
  const clubs = createClubsRepository(pool);

  return {
    // ── Auth ───────────────────────────────────────────────
    authenticateBearerToken: (bearerToken) => identity.authenticateBearerToken(bearerToken),
    validateBearerTokenPassive: (bearerToken) => identity.validateBearerTokenPassive(bearerToken),

    // ── Clubs ──────────────────────────────────────────────
    listClubs: (input) => identity.listClubs(input),
    createClub: (input) => identity.createClub(input),
    archiveClub: (input) => identity.archiveClub(input),
    assignClubOwner: (input) => identity.assignClubOwner(input),
    updateClub: (input) => identity.updateClub(input),

    // ── Memberships ────────────────────────────────────────
    listMemberships: (input) => identity.listMemberships(input),
    createMembership: (input) => identity.createMembership(input),
    transitionMembershipState: (input) => identity.transitionMembershipState(input),
    listMembers: (input) => identity.listMembers(input),
    promoteMemberToAdmin: (input) => identity.promoteMemberToAdmin!(input),
    demoteMemberFromAdmin: (input) => identity.demoteMemberFromAdmin!(input),

    async listMembershipReviews(input) {
      const paginated = await identity.listMembershipReviews(input);
      if (paginated.results.length === 0) return paginated;

      // Batch-load vouches for all target members on the page in one query.
      // Reviews are always scoped to a single club (clubIds comes from the action's clubId).
      const clubId = paginated.results[0].clubId;
      const targetMemberIds = [...new Set(paginated.results.map(r => r.member.memberId))];
      const vouchMap = await batchListVouches(pool, {
        clubId,
        targetMemberIds,
        perTargetLimit: 50,
      });

      for (const review of paginated.results) {
        const rawVouches = vouchMap.get(review.member.memberId) ?? [];
        review.vouches = rawVouches.map(mapVouchToSummary);
      }

      return paginated;
    },

    // ── Profiles ───────────────────────────────────────────
    listMemberProfiles: ({ actorMemberId, targetMemberId, actorClubIds, clubId }) => {
      return identity.listMemberProfiles({ actorMemberId, targetMemberId, actorClubIds, clubId });
    },
    buildMembershipSeedProfile: (input) => identity.buildMembershipSeedProfile(input),
    updateMemberIdentity: (input) => identity.updateMemberIdentity(input),
    updateClubProfile: (input) => identity.updateClubProfile(input),

    // ── Tokens ─────────────────────────────────────────────
    listBearerTokens: (input) => identity.listBearerTokens(input),
    createBearerToken: (input) => identity.createBearerToken(input),
    revokeBearerToken: (input) => identity.revokeBearerToken(input),

    // ── Search ─────────────────────────────────────────────
    fullTextSearchMembers: (input) => identity.fullTextSearchMembers(input),
    findMembersViaEmbedding: (input) => identity.findMembersViaEmbedding(input),

    // ── Entities ──────────────────────────────────────────
    async createEntity(input) {
      const actor = await identity.readActor(input.authorMemberId);
      const accessibleClubIds = actor?.memberships.map((membership) => membership.clubId) ?? [];
      const quotaClubId = input.clubId
        ?? (input.threadId
          ? (await pool.query<{ club_id: string }>(
            `select club_id
             from content_threads
             where id = $1
               and archived_at is null
               and club_id = any($2::text[])`,
            [input.threadId, accessibleClubIds],
          )).rows[0]?.club_id
          : null);
      if (!quotaClubId) {
        throw new AppError(404, 'not_found', 'Club or thread not found inside the actor scope');
      }
      const membership = actor?.memberships.find((m) => m.clubId === quotaClubId);
      const actorInfo = { role: membership?.role ?? 'member' as const, isOwner: membership?.isOwner ?? false };
      await clubs.enforceQuota(input.authorMemberId, quotaClubId, 'content.create', actorInfo);
      return clubs.createEntity(input);
    },

    async updateEntity(input) {
      return clubs.updateEntity(input);
    },

    closeEntityLoop: (input) => clubs.closeEntityLoop(input),

    reopenEntityLoop: (input) => clubs.reopenEntityLoop(input),

    removeEntity: (input) => clubs.removeEntity({
      entityId: input.entityId,
      clubIds: input.accessibleClubIds,
      actorMemberId: input.actorMemberId,
      reason: input.reason,
      skipAuthCheck: input.skipAuthCheck,
    }),

    listEntities: (input) => clubs.listEntities(input),
    readContentThread: (input) => clubs.readContentThread(input),

    // ── Events ──────────────────────────────────────────
    listEvents: (input) => clubs.listEvents(input),
    rsvpEvent: (input) => clubs.rsvpEvent(input),
    cancelEventRsvp: (input) => clubs.cancelEventRsvp(input),

    // ── Vouches ──────────────────────────────────────────
    async createVouch(input) {
      // Verify the target member has an accessible membership in this club (identity check)
      const targetCheck = await pool.query<{ ok: boolean }>(
        `select exists(
           select 1 from accessible_club_memberships
           where member_id = $1 and club_id = $2
         ) as ok`,
        [input.targetMemberId, input.clubId],
      );
      if (!targetCheck.rows[0]?.ok) return null;

      const raw = await clubs.createVouch(input);
      if (!raw) return null;
      return mapVouchToSummary(raw);
    },

    async listVouches(input) {
      const raw = await clubs.listVouches({
        clubIds: input.clubIds,
        targetMemberId: input.targetMemberId,
        limit: input.limit,
        cursor: input.cursor,
      });
      return {
        results: raw.results.map(mapVouchToSummary),
        hasMore: raw.hasMore,
        nextCursor: raw.nextCursor,
      };
    },

    // ── Admissions ─────────────────────────────────────────
    async createAdmissionSponsorship(input) {
      const sponsorRow = await pool.query<{ public_name: string; handle: string | null }>(
        `select public_name, handle from members where id = $1 and state = 'active'`,
        [input.actorMemberId],
      );
      const sponsorName = sponsorRow.rows[0]?.public_name ?? 'Unknown';
      const sponsorHandle = sponsorRow.rows[0]?.handle ?? null;

      // Insert admission
      const result = await pool.query<{
        admission_id: string; club_id: string; sponsor_member_id: string;
        created_at: string;
      }>(
        `with inserted_admission as (
           insert into admissions (club_id, sponsor_member_id, origin, applicant_email, applicant_name, admission_details)
           values ($1, $2, 'member_sponsored', $3, $4, $5::jsonb)
           returning id, club_id, sponsor_member_id, created_at
         )
         select id as admission_id, club_id, sponsor_member_id, created_at::text as created_at
         from inserted_admission`,
        [input.clubId, input.actorMemberId, input.candidateEmail, input.candidateName,
         JSON.stringify({ ...input.candidateDetails, reason: input.reason })],
      );

      const row = result.rows[0];
      if (!row) throw new Error('Admission row was not returned after insert');

      await pool.query(
        `insert into admission_versions (admission_id, status, notes, version_no, created_by_member_id)
         values ($1, 'submitted', 'Sponsored admission created by member', 1, $2)`,
        [row.admission_id, input.actorMemberId],
      );

      return {
        admissionId: row.admission_id,
        clubId: row.club_id,
        applicant: { memberId: null, publicName: input.candidateName, handle: null, email: input.candidateEmail },
        sponsor: { memberId: row.sponsor_member_id, publicName: sponsorName, handle: sponsorHandle },
        membershipId: null,
        origin: 'member_sponsored' as const,
        intake: { kind: 'other' as const, price: { amount: null, currency: null }, bookingUrl: null, bookedAt: null, completedAt: null },
        state: { status: 'submitted' as const, notes: 'Sponsored admission created by member', versionNo: 1, createdAt: row.created_at, createdByMemberId: input.actorMemberId },
        admissionDetails: { ...input.candidateDetails, reason: input.reason },
        metadata: {},
        createdAt: row.created_at,
      };
    },

    async listAdmissions(input) {
      if (!input.clubIds || input.clubIds.length === 0) return { results: [], hasMore: false, nextCursor: null };
      const fetchLimit = input.limit + 1;
      const cursorVersionCreatedAt = input.cursor?.versionCreatedAt ?? null;
      const cursorId = input.cursor?.id ?? null;

      const result = await pool.query<Record<string, unknown>>(
        `select ca.id as admission_id, ca.club_id, ca.applicant_member_id, ca.applicant_email,
                ca.applicant_name, ca.sponsor_member_id, ca.membership_id, ca.origin,
                ca.intake_kind, ca.intake_price_amount, ca.intake_price_currency,
                ca.intake_booking_url, ca.intake_booked_at::text as intake_booked_at,
                ca.intake_completed_at::text as intake_completed_at,
                ca.status, ca.notes, ca.version_no, ca.version_created_at::text as version_created_at,
                ca.version_created_by_member_id, ca.admission_details, ca.metadata,
                ca.created_at::text as created_at,
                am.public_name as applicant_public_name, am.handle as applicant_handle,
                sm.public_name as sponsor_public_name, sm.handle as sponsor_handle
         from current_admissions ca
         left join members am on am.id = ca.applicant_member_id
         left join members sm on sm.id = ca.sponsor_member_id
         where ca.club_id = any($1::text[])
           and ($2::text[] is null or ca.status::text = any($2::text[]))
           and ($4::timestamptz is null
             or ca.version_created_at < $4
             or (ca.version_created_at = $4 and ca.id < $5))
         order by ca.version_created_at desc, ca.id desc
         limit $3`,
        [input.clubIds, input.statuses ?? null, fetchLimit, cursorVersionCreatedAt, cursorId],
      );

      const rows = result.rows.map((r) => ({
        admissionId: r.admission_id as string,
        clubId: r.club_id as string,
        applicant: {
          memberId: (r.applicant_member_id as string) ?? null,
          publicName: (r.applicant_public_name as string) ?? (r.applicant_name as string) ?? 'Unknown applicant',
          handle: (r.applicant_handle as string) ?? null,
          email: (r.applicant_email as string) ?? null,
        },
        sponsor: r.sponsor_member_id ? {
          memberId: r.sponsor_member_id as string,
          publicName: (r.sponsor_public_name as string) ?? 'Unknown sponsor',
          handle: (r.sponsor_handle as string) ?? null,
        } : null,
        membershipId: (r.membership_id as string) ?? null,
        origin: r.origin as 'self_applied' | 'member_sponsored' | 'owner_nominated',
        intake: {
          kind: (r.intake_kind as 'fit_check' | 'advice_call' | 'other') ?? 'other',
          price: { amount: r.intake_price_amount != null ? Number(r.intake_price_amount) : null, currency: (r.intake_price_currency as string) ?? null },
          bookingUrl: (r.intake_booking_url as string) ?? null,
          bookedAt: (r.intake_booked_at as string) ?? null,
          completedAt: (r.intake_completed_at as string) ?? null,
        },
        state: {
          status: r.status as AdmissionStatus,
          notes: (r.notes as string) ?? null,
          versionNo: Number(r.version_no),
          createdAt: r.version_created_at as string,
          createdByMemberId: (r.version_created_by_member_id as string) ?? null,
        },
        admissionDetails: (r.admission_details as Record<string, unknown>) ?? {},
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        createdAt: r.created_at as string,
      }));

      const hasMore = rows.length > input.limit;
      if (hasMore) rows.pop();
      const last = rows[rows.length - 1];
      const nextCursor = last
        ? paginationEncodeCursor([last.state.createdAt, last.admissionId])
        : null;

      return { results: rows, hasMore, nextCursor };
    },

    getAdmissionsForMember: (input) => admissionsModule.getAdmissionsForMember(pool, input),

    async transitionAdmission(input) {
      let storedProfileDraft = null;
      let skipTransition = false;
      let currentAdmission: {
        admission_id: string;
        club_id: string;
        applicant_member_id: string | null;
        applicant_email: string | null;
        applicant_name: string | null;
        sponsor_member_id: string | null;
        membership_id: string | null;
        admission_details: Record<string, unknown> | null;
        status: AdmissionStatus;
        club_name: string;
        club_summary: string | null;
        admission_policy: string | null;
        generated_profile_draft: Record<string, unknown> | null;
      } | null = null;

      if (input.nextStatus === 'accepted') {
        const admissionContext = await pool.query<{
          admission_id: string;
          club_id: string;
          applicant_member_id: string | null;
          applicant_email: string | null;
          applicant_name: string | null;
          sponsor_member_id: string | null;
          membership_id: string | null;
          admission_details: Record<string, unknown> | null;
          status: AdmissionStatus;
          club_name: string;
          club_summary: string | null;
          admission_policy: string | null;
          generated_profile_draft: Record<string, unknown> | null;
        }>(
          `select
             ca.id as admission_id,
             ca.club_id,
             ca.applicant_member_id,
             ca.applicant_email,
             ca.applicant_name,
             ca.sponsor_member_id,
             ca.membership_id,
             ca.admission_details,
             ca.status,
             c.name as club_name,
             c.summary as club_summary,
             c.admission_policy,
             a.generated_profile_draft
           from current_admissions ca
           join admissions a on a.id = ca.id
           join clubs c on c.id = ca.club_id
           where ca.id = $1 and ca.club_id = any($2::text[])
           limit 1`,
          [input.admissionId, input.accessibleClubIds],
        );
        currentAdmission = admissionContext.rows[0] ?? null;
        if (!currentAdmission) return null;

        skipTransition = currentAdmission.status === 'accepted';
        if (currentAdmission.generated_profile_draft) {
          storedProfileDraft = normalizeClubProfileFields(currentAdmission.generated_profile_draft);
        } else {
          const admissionDetails = currentAdmission.admission_details ?? {};
          const generatedDraft = await generateAdmissionClubProfile({
            club: {
              name: currentAdmission.club_name,
              summary: currentAdmission.club_summary,
              admissionPolicy: currentAdmission.admission_policy,
            },
            applicantName: currentAdmission.applicant_name ?? 'New Member',
            application: typeof admissionDetails.application === 'string' ? admissionDetails.application : '',
            socials: typeof admissionDetails.socials === 'string' ? admissionDetails.socials : '',
          });

          const persistedDraft = await pool.query<{ generated_profile_draft: Record<string, unknown> }>(
            `update admissions
             set generated_profile_draft = $2::jsonb
             where id = $1
               and generated_profile_draft is null
             returning generated_profile_draft`,
            [currentAdmission.admission_id, JSON.stringify(generatedDraft)],
          );

          if (persistedDraft.rows[0]?.generated_profile_draft) {
            storedProfileDraft = normalizeClubProfileFields(persistedDraft.rows[0].generated_profile_draft);
          } else {
            const rereadDraft = await pool.query<{ generated_profile_draft: Record<string, unknown> | null }>(
              `select generated_profile_draft from admissions where id = $1 limit 1`,
              [currentAdmission.admission_id],
            );
            storedProfileDraft = normalizeClubProfileFields(rereadDraft.rows[0]?.generated_profile_draft ?? generatedDraft);
          }
        }
      }

      const result = skipTransition
        ? {
            admission: currentAdmission!,
            isAcceptance: true,
            isOutsider: currentAdmission!.applicant_member_id === null,
          }
        : await admissionsModule.transitionAdmission(pool, {
            admissionId: input.admissionId,
            clubIds: input.accessibleClubIds,
            actorMemberId: input.actorMemberId,
            nextStatus: input.nextStatus,
            notes: input.notes,
            intake: input.intake,
            metadataPatch: input.metadataPatch,
          });
      if (!result) return null;

      // On acceptance, create member + membership
      if (result.isAcceptance) {
        const adm = result.admission;
        const clubId = adm.club_id;
        let memberId = adm.applicant_member_id;
        let membershipId = adm.membership_id;

        if (result.isOutsider) {
          // Retry safety — three-layer lookup:
          // 1. Check if membership already exists (source_admission_id anchor)
          const existingMembership = await pool.query<{ member_id: string; id: string }>(
            `select member_id, id from club_memberships where source_admission_id = $1 limit 1`,
            [adm.admission_id],
          );
          if (existingMembership.rows[0]) {
            memberId = existingMembership.rows[0].member_id;
            membershipId = existingMembership.rows[0].id;
            await admissionsModule.linkAdmissionToMember(pool, adm.admission_id, memberId, membershipId);
          } else {
            // 2. Check if member was created but membership wasn't (clubs-side link exists)
            const clubsSideLink = await pool.query<{ applicant_member_id: string | null }>(
              `select applicant_member_id from admissions where id = $1`,
              [adm.admission_id],
            );
            if (clubsSideLink.rows[0]?.applicant_member_id) {
              // Member exists from prior attempt — reuse it
              memberId = clubsSideLink.rows[0].applicant_member_id;
            } else {
              // 3. No prior state — create the member
              const displayName = adm.applicant_name ?? 'New Member';
              const email = adm.applicant_email;
              if (!email) throw new AppError(409, 'admission_missing_email', 'Cannot accept an outsider admission without an email address');

              memberId = await identity.createMemberFromAdmission({
                name: adm.applicant_name ?? displayName,
                email,
                displayName,
                details: adm.admission_details ?? {},
                admissionId: adm.admission_id,
              });

              // Immediately link the member in clubs so retries can find it
              await pool.query(
                `update admissions set applicant_member_id = $2 where id = $1`,
                [adm.admission_id, memberId],
              );
            }
          }
        }

        if (memberId) {
          if (!membershipId) {
            const existingMembership = await pool.query<{ id: string; member_id: string }>(
              `select id, member_id from club_memberships where source_admission_id = $1 limit 1`,
              [adm.admission_id],
            );
            if (existingMembership.rows[0]) {
              membershipId = existingMembership.rows[0].id;
              memberId = existingMembership.rows[0].member_id;
              await admissionsModule.linkAdmissionToMember(pool, adm.admission_id, memberId, membershipId);
            }
          }

          // Check if this is a paid club — determines initial membership state
          const clubPriceResult = await pool.query<{ membership_price_amount: string | null; membership_price_currency: string }>(
            `select membership_price_amount, membership_price_currency from clubs where id = $1`,
            [clubId],
          );
          const isPaidClub = clubPriceResult.rows[0]?.membership_price_amount != null;

          if (!membershipId) {
            const sponsorId = adm.sponsor_member_id ?? input.actorMemberId;
            const membershipResult = await identity.createMembership({
              actorMemberId: input.actorMemberId,
              clubId,
              memberId,
              sponsorMemberId: sponsorId,
              role: 'member',
              initialStatus: isPaidClub ? 'payment_pending' : 'active',
              sourceAdmissionId: adm.admission_id,
              reason: isPaidClub ? 'Admitted — awaiting payment' : 'Admitted from accepted admission',
              metadata: {},
              initialProfile: {
                fields: storedProfileDraft ?? normalizeClubProfileFields(null),
                generationSource: 'admission_generated',
              },
            });

            if (membershipResult) {
              membershipId = membershipResult.membershipId;
              // Snapshot the approved price on the membership for paid clubs
              if (isPaidClub) {
                const priceRow = clubPriceResult.rows[0]!;
                await pool.query(
                  `update club_memberships set approved_price_amount = $2, approved_price_currency = $3
                   where id = $1`,
                  [membershipResult.membershipId, priceRow.membership_price_amount, priceRow.membership_price_currency],
                );
              }

              await admissionsModule.linkAdmissionToMember(pool, adm.admission_id, memberId, membershipResult.membershipId);
            }
          }
        }
      }

      // Re-read with member info resolved via JOIN
      return readAdmissionEnriched(pool, input.admissionId);
    },

    async createAdmissionChallenge(input) {
      // Look up club
      const clubResult = await pool.query<{
        club_id: string; name: string; summary: string | null;
        admission_policy: string; owner_member_id: string;
      }>(
        `select c.id as club_id, c.name, c.summary, c.admission_policy, c.owner_member_id
         from clubs c
         where c.slug = $1 and c.archived_at is null and c.admission_policy is not null
         limit 1`,
        [input.clubSlug],
      );
      const club = clubResult.rows[0];
      if (!club) throw new AppError(404, 'club_not_found', 'Club not found or is not accepting applications');

      // Get owner name
      const ownerInfo = await identity.getMemberPublicContact(club.owner_member_id);
      const ownerName = ownerInfo?.memberName ?? 'Club Owner';

      // Create challenge
      const challenge = await admissionsModule.createAdmissionChallenge(pool, {
        clubSlug: input.clubSlug,
        clubId: club.club_id,
        clubName: club.name,
        clubSummary: club.summary,
        admissionPolicy: club.admission_policy,
        ownerName,
      });

      return {
        ...challenge,
        club: {
          slug: input.clubSlug,
          name: club.name,
          summary: club.summary,
          ownerName,
          admissionPolicy: club.admission_policy,
        },
      };
    },

    async solveAdmissionChallenge(input) {
      return admissionsModule.solveAdmissionChallenge(pool, input);
    },

    async createCrossAdmissionChallenge(input) {
      // Look up club by slug
      const clubResult = await pool.query<{
        club_id: string; name: string; summary: string | null;
        admission_policy: string; owner_member_id: string;
      }>(
        `select c.id as club_id, c.name, c.summary, c.admission_policy, c.owner_member_id
         from clubs c
         where c.slug = $1 and c.archived_at is null and c.admission_policy is not null
         limit 1`,
        [input.clubSlug],
      );
      const club = clubResult.rows[0];
      if (!club) throw new AppError(404, 'club_not_found', 'Club not found or is not accepting applications');

      const ownerInfo = await identity.getMemberPublicContact(club.owner_member_id);
      const ownerName = ownerInfo?.memberName ?? 'Club Owner';

      const challenge = await admissionsModule.createCrossChallenge(pool, {
        memberId: input.actorMemberId,
        clubId: club.club_id,
        clubName: club.name,
        clubSummary: club.summary,
        admissionPolicy: club.admission_policy,
        ownerName,
      });

      return {
        ...challenge,
        club: {
          slug: input.clubSlug,
          name: club.name,
          summary: club.summary,
          ownerName,
          admissionPolicy: club.admission_policy,
        },
      };
    },

    async solveCrossAdmissionChallenge(input) {
      return admissionsModule.solveCrossChallenge(pool, {
        memberId: input.actorMemberId,
        challengeId: input.challengeId,
        nonce: input.nonce,
        socials: input.socials,
        application: input.application,
      });
    },

    async issueAdmissionAccess(input) {
      // Look up admission
      const admResult = await pool.query<{
        admission_id: string; applicant_member_id: string | null; status: string;
      }>(
        `select ca.id as admission_id, ca.applicant_member_id, ca.status
         from current_admissions ca
         where ca.id = $1 and ca.club_id = any($2::text[])
         limit 1`,
        [input.admissionId, input.accessibleClubIds],
      );
      const admission = admResult.rows[0];
      if (!admission) return null;
      if (admission.status !== 'accepted') throw new AppError(409, 'admission_not_accepted', 'Access can only be issued for accepted admissions');
      if (!admission.applicant_member_id) throw new AppError(409, 'admission_not_finalized', 'Admission has no linked member');

      // Create token
      const { bearerToken } = await identity.issueTokenForMember(
        admission.applicant_member_id,
        input.label ?? 'Issued from admission acceptance',
        { source: 'admission', admissionId: input.admissionId },
      );

      // Re-read admission for response
      const enriched = await readAdmissionEnriched(pool, input.admissionId);
      if (!enriched) return null;
      return { admission: enriched, bearerToken };
    },

    // ── Messages ─────────────────────────────────────────
    // DMs are not club-scoped. Clubs are only an eligibility check for starting
    // a conversation. Existing threads continue even if clubs diverge.

    async sendDirectMessage(input) {
      // Clubs are an eligibility check for *starting* a DM. If an existing
      // thread already exists between the two members, sending is always
      // allowed (the thread was started when they did share a club).
      const sharedClubs = await resolveSharedClubs(pool, input.actorMemberId, input.recipientMemberId, input.accessibleClubIds);
      if (sharedClubs.length === 0) {
        const hasThread = await messaging.hasExistingThread(input.actorMemberId, input.recipientMemberId);
        if (!hasThread) return null;
      }

      const msg = await messaging.sendMessage({
        senderMemberId: input.actorMemberId,
        recipientMemberId: input.recipientMemberId,
        messageText: input.messageText,
        clientKey: input.clientKey,
      });

      return {
        threadId: msg.threadId,
        sharedClubs,
        senderMemberId: msg.senderMemberId,
        recipientMemberId: msg.recipientMemberId,
        messageId: msg.messageId,
        messageText: msg.messageText,
        createdAt: msg.createdAt,
        updateCount: 1,
      };
    },

    async listDirectMessageThreads({ actorMemberId, limit }) {
      const threads = await messaging.listThreads({ memberId: actorMemberId, limit });
      const counterpartIds = threads.map((t) => t.counterpartMemberId);
      const sharedClubsMap = await batchResolveSharedClubs(pool, actorMemberId, counterpartIds);

      return threads.map((t) => ({
        threadId: t.threadId,
        sharedClubs: sharedClubsMap.get(t.counterpartMemberId) ?? [],
        counterpartMemberId: t.counterpartMemberId,
        counterpartPublicName: t.counterpartPublicName,
        counterpartHandle: t.counterpartHandle,
        latestMessage: t.latestMessage,
        messageCount: t.messageCount,
      }));
    },

    async listDirectMessageInbox(input) {
      const paginated = await messaging.listInbox({
        memberId: input.actorMemberId,
        limit: input.limit,
        unreadOnly: input.unreadOnly,
        cursor: input.cursor,
      });
      const entries = paginated.results;
      const counterpartIds = entries.map((e) => e.counterpartMemberId);
      const sharedClubsMap = await batchResolveSharedClubs(pool, input.actorMemberId, counterpartIds);

      return {
        results: entries.map((e) => ({
          threadId: e.threadId,
          sharedClubs: sharedClubsMap.get(e.counterpartMemberId) ?? [],
          counterpartMemberId: e.counterpartMemberId,
          counterpartPublicName: e.counterpartPublicName,
          counterpartHandle: e.counterpartHandle,
          latestMessage: e.latestMessage,
          messageCount: e.messageCount,
          unread: {
            hasUnread: e.hasUnread,
            unreadMessageCount: e.unreadCount,
            unreadUpdateCount: e.unreadCount,
            latestUnreadMessageCreatedAt: e.latestUnreadAt,
          },
        })),
        hasMore: paginated.hasMore,
        nextCursor: paginated.nextCursor,
      };
    },

    async readDirectMessageThread(input) {
      const result = await messaging.readThread({
        memberId: input.actorMemberId,
        threadId: input.threadId,
        limit: input.limit,
        cursor: input.cursor,
      });
      if (!result) return null;

      const sharedClubs = await resolveSharedClubsUnscoped(pool, input.actorMemberId, result.thread.counterpartMemberId);

      return {
        thread: {
          threadId: result.thread.threadId,
          sharedClubs,
          counterpartMemberId: result.thread.counterpartMemberId,
          counterpartPublicName: result.thread.counterpartPublicName,
          counterpartHandle: result.thread.counterpartHandle,
          latestMessage: result.thread.latestMessage,
          messageCount: result.thread.messageCount,
        },
        messages: result.messages.map((msg) => ({
          ...msg,
          updateReceipts: [],
        })),
        hasMore: result.hasMore,
        nextCursor: result.nextCursor,
      };
    },

    // ── Removals ───────────────────────────────────────────
    async removeMessage(input) {
      const result = await messaging.removeMessage({
        messageId: input.messageId,
        removedByMemberId: input.actorMemberId,
        reason: input.reason,
        skipAuthCheck: input.skipAuthCheck,
      });
      if (!result) return null;
      return {
        messageId: result.messageId,
        removedByMemberId: result.removedByMemberId,
        reason: result.reason,
        removedAt: result.removedAt,
      };
    },

    // ── Updates ─────────────────────────────────────────────
    async listMemberUpdates(input) {
      // Resolve actor's roles for audience filtering
      const actor = await identity.readActor(input.actorMemberId);
      const adminClubIds = actor?.memberships.filter((m) => m.role === 'clubadmin').map((m) => m.clubId) ?? [];
      const ownerClubIds = actor?.memberships.filter((m) => m.isOwner).map((m) => m.clubId) ?? [];

      const cursor = input.after ? decodeCursor(input.after) : null;

      // Budget: distribute limit across sources so total never exceeds input.limit
      // AND no source is starved under sustained load from another.
      // Each source gets a guaranteed share; any underflow redistributes to later sources.
      const activityShare = Math.ceil(input.limit / 3);
      let remaining = input.limit;

      // ── Source 1: Club activity ──
      const activity = await clubs.listClubActivity({
        memberId: input.actorMemberId,
        clubIds: input.clubIds,
        limit: activityShare,
        afterSeq: cursor?.a ?? null,
        adminClubIds,
        ownerClubIds,
      });
      remaining -= activity.items.length;

      // ── Source 2: Member signals ──
      const afterSignalSeq = cursor?.s ?? null;
      let signalSeq: number;
      let signalItems: PendingUpdate[] = [];
      // Signals get half the remaining budget (after activity consumed its share).
      const signalShare = Math.ceil(remaining / 2);

      if (afterSignalSeq == null) {
        // First poll: seed signal cursor from max(seq)
        const seedResult = await pool.query<{ max_seq: string }>(
          `select coalesce(max(seq), 0)::text as max_seq from signal_deliveries
           where recipient_member_id = $1 and club_id = any($2::text[])`,
          [input.actorMemberId, input.clubIds],
        );
        signalSeq = parseInt(seedResult.rows[0]?.max_seq ?? '0', 10);
      } else if (signalShare > 0) {
        const signalResult = await pool.query<{
          id: string; club_id: string; recipient_member_id: string; seq: string;
          topic: string; payload: Record<string, unknown>; entity_id: string | null;
          match_id: string | null; created_at: string;
        }>(
          `select id, club_id, recipient_member_id, seq::text as seq, topic, payload,
                  entity_id, match_id, created_at::text as created_at
           from signal_deliveries ms
           where recipient_member_id = $1
             and club_id = any($2::text[])
             and acknowledged_state is null
             and seq > $3
             and (
               ms.entity_id is null
               or exists (
                 select 1 from current_entity_versions cev
                 where cev.entity_id = ms.entity_id and cev.state = 'published'
               )
             )
             and (
               ms.topic <> 'signal.offer_match'
               or ms.payload->>'yourAskEntityId' is null
               or exists (
                 select 1 from current_entity_versions cev
                 where cev.entity_id = ms.payload->>'yourAskEntityId' and cev.state = 'published'
               )
             )
           order by seq asc limit $4`,
          [input.actorMemberId, input.clubIds, afterSignalSeq, signalShare],
        );

        signalItems = signalResult.rows.map(s => ({
          updateId: `signal:${s.id}`,
          streamSeq: parseInt(s.seq, 10),
          source: 'signal' as const,
          recipientMemberId: s.recipient_member_id,
          clubId: s.club_id,
          entityId: s.entity_id,
          entityVersionId: null,
          dmMessageId: null,
          topic: s.topic,
          payload: s.payload,
          createdAt: s.created_at,
          createdByMemberId: null,
        }));

        signalSeq = signalResult.rows.length > 0
          ? parseInt(signalResult.rows[signalResult.rows.length - 1].seq, 10)
          : afterSignalSeq;
      } else {
        // No budget left for signals — keep cursor unchanged
        signalSeq = afterSignalSeq;
      }
      remaining -= signalItems.length;

      // ── Source 3: Inbox (DMs) ──
      // Order ASC (oldest first) so repeated polls drain the backlog in order.
      // Cursor.t advances to the last item's created_at, not wall-clock time.
      // Inbox gets whatever budget remains after activity and signals.
      const cursorTimestamp = cursor?.t ?? null;
      const inboxBudget = Math.max(0, remaining);
      const inboxResult = inboxBudget > 0
        ? await pool.query<{
            id: string; recipient_member_id: string; thread_id: string;
            message_id: string; created_at: string;
          }>(
            `select ie.id, ie.recipient_member_id, ie.thread_id, ie.message_id,
                    ie.created_at::text as created_at
             from dm_inbox_entries ie
             where ie.recipient_member_id = $1 and ie.acknowledged = false
               and ($3::timestamptz is null or ie.created_at > $3)
               and not exists (
                 select 1 from dm_message_removals rmv where rmv.message_id = ie.message_id
               )
             order by ie.created_at asc limit $2`,
            [input.actorMemberId, inboxBudget, cursorTimestamp],
          )
        : { rows: [] as Array<{ id: string; recipient_member_id: string; thread_id: string; message_id: string; created_at: string }> };

      // Advance inbox cursor to the last (most recent) item returned, not wall-clock.
      // If no items, keep the existing cursor timestamp unchanged.
      const nextInboxTimestamp = inboxResult.rows.length > 0
        ? inboxResult.rows[inboxResult.rows.length - 1].created_at
        : cursorTimestamp;

      // Get sender info for DM updates in one query
      const inboxMessageIds = inboxResult.rows.map((ie) => ie.message_id);
      const dmDetails = new Map<string, {
        sender_member_id: string | null; message_text: string | null;
        thread_id: string; sender_public_name: string | null; sender_handle: string | null;
      }>();
      if (inboxMessageIds.length > 0) {
        const dmResult = await pool.query<{
          message_id: string; sender_member_id: string | null; message_text: string | null;
          thread_id: string; sender_public_name: string | null; sender_handle: string | null;
        }>(
          `select m.id as message_id, m.sender_member_id, m.message_text, m.thread_id,
                  mbr.public_name as sender_public_name, mbr.handle as sender_handle
           from dm_messages m
           left join members mbr on mbr.id = m.sender_member_id
           where m.id = any($1::text[])`,
          [inboxMessageIds],
        );
        for (const r of dmResult.rows) {
          dmDetails.set(r.message_id, r);
        }
      }

      // ── Map sources to PendingUpdate shape ──

      const activityItems = activity.items.map((item) => ({
        updateId: `activity:${item.seq}`,
        streamSeq: Number(item.seq),
        source: 'activity' as const,
        recipientMemberId: input.actorMemberId,
        clubId: item.clubId as string,
        entityId: (item.entityId as string) ?? null,
        entityVersionId: (item.entityVersionId as string) ?? null,
        dmMessageId: null,
        topic: item.topic as string,
        payload: (item.payload as Record<string, unknown>) ?? {},
        createdAt: item.createdAt as string,
        createdByMemberId: (item.createdByMemberId as string) ?? null,
      }));

      // Resolve shared clubs for DM senders in batch
      const dmSenderIds = [...new Set(
        inboxResult.rows.map(ie => dmDetails.get(ie.message_id)?.sender_member_id).filter((id): id is string => !!id),
      )];
      const dmSharedClubsMap = await batchResolveSharedClubs(pool, input.actorMemberId, dmSenderIds);

      const inboxItems = inboxResult.rows.map((ie, idx) => {
        const dm = dmDetails.get(ie.message_id);
        const tsMs = Date.parse(ie.created_at) || Date.now();
        const senderSharedClubs = dm?.sender_member_id ? (dmSharedClubsMap.get(dm.sender_member_id) ?? []) : [];
        return {
          updateId: `inbox:${ie.id}`,
          streamSeq: tsMs + idx,
          source: 'inbox' as const,
          recipientMemberId: ie.recipient_member_id,
          clubId: null,
          entityId: null,
          entityVersionId: null,
          dmMessageId: ie.message_id,
          topic: 'dm.message.created',
          payload: {
            kind: 'dm',
            threadId: dm?.thread_id ?? ie.thread_id,
            messageId: ie.message_id,
            senderMemberId: dm?.sender_member_id ?? null,
            senderPublicName: dm?.sender_public_name ?? 'Unknown',
            senderHandle: dm?.sender_handle ?? null,
            recipientMemberId: ie.recipient_member_id,
            messageText: dm?.message_text ?? null,
            sharedClubs: senderSharedClubs,
          },
          createdAt: ie.created_at,
          createdByMemberId: dm?.sender_member_id ?? null,
        };
      });

      // Merge all three sources
      const allItems = [...activityItems, ...signalItems, ...inboxItems];
      const polledAt = new Date().toISOString();

      // Build cursor: always produce a cursor even when activity has no clubs.
      // Activity seq: from activity result, or keep existing cursor value, or 0.
      const nextActivitySeq = activity.nextAfterSeq ?? cursor?.a ?? 0;

      return {
        items: allItems,
        nextAfter: encodeCursor({ a: nextActivitySeq, s: signalSeq, t: nextInboxTimestamp ?? polledAt }),
        polledAt,
      };
    },

    async getLatestCursor(input) {
      const activity = await clubs.listClubActivity({
        memberId: input.actorMemberId,
        clubIds: input.clubIds,
        limit: 0,
        afterSeq: null,
      });
      // Seed signal cursor from max(seq)
      const signalSeed = await pool.query<{ max_seq: string }>(
        `select coalesce(max(seq), 0)::text as max_seq from signal_deliveries
         where recipient_member_id = $1 and club_id = any($2::text[])`,
        [input.actorMemberId, input.clubIds],
      );
      const signalSeq = parseInt(signalSeed.rows[0]?.max_seq ?? '0', 10);

      return encodeCursor({ a: activity.nextAfterSeq ?? 0, s: signalSeq, t: new Date().toISOString() });
    },

    async acknowledgeUpdates(input) {
      return withTransaction(pool, async (client) => {
        const nowIso = new Date().toISOString();

        const inboxIds = input.updateIds
          .filter((id) => id.startsWith('inbox:'))
          .map((id) => id.replace('inbox:', ''));

        const inboxReceipts = new Map<string, {
          receiptId: string;
          updateId: string;
          recipientMemberId: string;
          clubId: string | null;
          state: typeof input.state;
          suppressionReason: string | null;
          versionNo: number;
          supersedesReceiptId: null;
          createdAt: string;
          createdByMemberId: string | null;
        }>();

        if (inboxIds.length > 0) {
          const result = await client.query<{ id: string }>(
            `update dm_inbox_entries
             set acknowledged = true
             where id = any($1::text[]) and recipient_member_id = $2
             returning id`,
            [inboxIds, input.actorMemberId],
          );

          for (const row of result.rows) {
            const updateId = `inbox:${row.id}`;
            inboxReceipts.set(updateId, {
              receiptId: updateId,
              updateId,
              recipientMemberId: input.actorMemberId,
              clubId: null,
              state: input.state,
              suppressionReason: input.suppressionReason ?? null,
              versionNo: 1,
              supersedesReceiptId: null,
              createdAt: nowIso,
              createdByMemberId: input.actorMemberId,
            });
          }
        }

        const signalIds = input.updateIds
          .filter((id) => id.startsWith('signal:'))
          .map((id) => id.replace('signal:', ''));

        const signalReceipts = new Map<string, {
          receiptId: string;
          updateId: string;
          recipientMemberId: string;
          clubId: string | null;
          state: typeof input.state;
          suppressionReason: string | null;
          versionNo: number;
          supersedesReceiptId: null;
          createdAt: string;
          createdByMemberId: string | null;
        }>();

        if (signalIds.length > 0) {
          const result = await client.query<{
            id: string; club_id: string; acknowledged_at: string;
            acknowledged_state: string; suppression_reason: string | null;
          }>(
            `update signal_deliveries
             set acknowledged_state = coalesce(acknowledged_state, $3),
                 acknowledged_at = coalesce(acknowledged_at, now()),
                 suppression_reason = case when acknowledged_state is null then $4 else suppression_reason end
             where id = any($1::text[])
               and recipient_member_id = $2
             returning id, club_id, acknowledged_at::text as acknowledged_at,
                      acknowledged_state, suppression_reason`,
            [signalIds, input.actorMemberId, input.state, input.suppressionReason ?? null],
          );

          for (const row of result.rows) {
            const updateId = `signal:${row.id}`;
            signalReceipts.set(updateId, {
              receiptId: updateId,
              updateId,
              recipientMemberId: input.actorMemberId,
              clubId: row.club_id,
              state: row.acknowledged_state as typeof input.state,
              suppressionReason: row.suppression_reason,
              versionNo: 1,
              supersedesReceiptId: null,
              createdAt: row.acknowledged_at,
              createdByMemberId: input.actorMemberId,
            });
          }
        }

        return input.updateIds
          .map((updateId) => (
            inboxReceipts.get(updateId)
            ?? signalReceipts.get(updateId)
          ))
          .filter((receipt): receipt is NonNullable<typeof receipt> => receipt !== undefined);
      });
    },

    // ── Quotas ─────────────────────────────────────────────
    getQuotaStatus: (input) => clubs.getQuotaStatus({
      ...input,
      memberships: input.memberships ?? [],
    }),

    // ── LLM ────────────────────────────────────────────────
    logLlmUsage: (input) => clubs.logLlmUsage(input),

    // ── Embeddings ─────────────────────────────────────────
    findEntitiesViaEmbedding: (input) => clubs.findEntitiesViaEmbedding(input),

    // ── Admin: member/membership creation ───────────────
    adminCreateMember: (input) => identity.createMemberDirect(input),
    adminCreateMembership: (input) => identity.createMembershipAsSuperadmin(input),

    // ── Admin ───────────────────────────────────────────
    async adminGetOverview() {
      const [totalMemberCount, activeMemberCount, clubCount, entityCount, messageCount, admissionCount] = await Promise.all([
        pool.query<{ count: string }>(`select count(*)::text as count from members`),
        pool.query<{ count: string }>(`select count(*)::text as count from members where state = 'active'`),
        pool.query<{ count: string }>(`select count(*)::text as count from clubs where archived_at is null`),
        pool.query<{ count: string }>(`select count(*)::text as count from entities where deleted_at is null`),
        pool.query<{ count: string }>(`select count(*)::text as count from dm_messages`),
        pool.query<{ count: string }>(`select count(*)::text as count from admissions`),
      ]);

      const recentMembers = await pool.query<{
        member_id: string; public_name: string; handle: string | null; created_at: string;
      }>(
        `select id as member_id, public_name, handle, created_at::text as created_at
         from members
         order by created_at desc limit 5`,
      );

      return {
        totalMembers: Number(totalMemberCount.rows[0]?.count ?? 0),
        activeMembers: Number(activeMemberCount.rows[0]?.count ?? 0),
        totalClubs: Number(clubCount.rows[0]?.count ?? 0),
        totalEntities: Number(entityCount.rows[0]?.count ?? 0),
        totalMessages: Number(messageCount.rows[0]?.count ?? 0),
        totalAdmissions: Number(admissionCount.rows[0]?.count ?? 0),
        recentMembers: recentMembers.rows.map((r) => ({
          memberId: r.member_id,
          publicName: r.public_name,
          handle: r.handle,
          createdAt: r.created_at,
        })),
      };
    },

    async adminListMembers({ limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        member_id: string; public_name: string; handle: string | null;
        state: string; created_at: string; membership_count: number; token_count: number;
      }>(
        `select m.id as member_id, m.public_name, m.handle, m.state::text as state,
                m.created_at::text as created_at,
                (select count(*)::int from club_memberships cm where cm.member_id = m.id) as membership_count,
                (select count(*)::int from member_bearer_tokens t where t.member_id = m.id and t.revoked_at is null) as token_count
         from members m
         where ($1::timestamptz is null or m.created_at < $1 or (m.created_at = $1 and m.id < $2))
         order by m.created_at desc, m.id desc
         limit $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, fetchLimit],
      );

      const rows = result.rows.map((r) => ({
        memberId: r.member_id, publicName: r.public_name, handle: r.handle,
        state: r.state, createdAt: r.created_at,
        membershipCount: r.membership_count, tokenCount: r.token_count,
      }));
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const last = rows[rows.length - 1];
      const nextCursor = last ? paginationEncodeCursor([last.createdAt, last.memberId]) : null;
      return { results: rows, hasMore, nextCursor };
    },

    async adminGetMember({ memberId }) {
      const memberResult = await pool.query<{
        member_id: string; public_name: string; handle: string | null; display_name: string;
        state: string; created_at: string;
      }>(
        `select id as member_id, public_name, handle, display_name, state::text as state, created_at::text as created_at
         from members where id = $1 limit 1`,
        [memberId],
      );
      if (!memberResult.rows[0]) return null;
      const m = memberResult.rows[0];

      const membershipsResult = await pool.query<{
        membership_id: string; club_id: string; club_name: string; club_slug: string;
        role: string; status: string; joined_at: string;
      }>(
        `select cm.id as membership_id, cm.club_id, c.name as club_name, c.slug as club_slug,
                cm.role::text as role, cm.status::text as status, cm.joined_at::text as joined_at
         from club_memberships cm
         join clubs c on c.id = cm.club_id
         where cm.member_id = $1
         order by cm.joined_at desc`,
        [memberId],
      );

      const tokenCount = await pool.query<{ count: string }>(
        `select count(*)::text as count from member_bearer_tokens where member_id = $1 and revoked_at is null`,
        [memberId],
      );

      const profileRows = await pool.query<{
        club_id: string;
        club_slug: string;
        club_name: string;
        tagline: string | null;
        summary: string | null;
        what_i_do: string | null;
        known_for: string | null;
        services_summary: string | null;
        website_url: string | null;
        links: unknown[] | null;
        profile: Record<string, unknown> | null;
        version_id: string;
        version_no: number;
        version_created_at: string;
        version_created_by_member_id: string | null;
      }>(
        `select
           c.id as club_id,
           c.slug as club_slug,
           c.name as club_name,
           cmp.tagline,
           cmp.summary,
           cmp.what_i_do,
           cmp.known_for,
           cmp.services_summary,
           cmp.website_url,
           cmp.links,
           cmp.profile,
           cmp.id as version_id,
           cmp.version_no,
           cmp.created_at::text as version_created_at,
           cmp.created_by_member_id as version_created_by_member_id
         from current_member_club_profiles cmp
         join clubs c on c.id = cmp.club_id
         where cmp.member_id = $1
         order by c.name asc, c.id asc`,
        [memberId],
      );

      return {
        memberId: m.member_id, publicName: m.public_name, handle: m.handle,
        displayName: m.display_name,
        state: m.state, createdAt: m.created_at,
        memberships: membershipsResult.rows.map((r) => ({
          membershipId: r.membership_id, clubId: r.club_id, clubName: r.club_name,
          clubSlug: r.club_slug, role: r.role, status: r.status, joinedAt: r.joined_at,
        })),
        tokenCount: Number(tokenCount.rows[0]?.count ?? 0),
        profiles: profileRows.rows.map((row) => ({
          club: { clubId: row.club_id, slug: row.club_slug, name: row.club_name },
          tagline: row.tagline,
          summary: row.summary,
          whatIDo: row.what_i_do,
          knownFor: row.known_for,
          servicesSummary: row.services_summary,
          websiteUrl: row.website_url,
          links: row.links ?? [],
          profile: row.profile ?? {},
          version: {
            id: row.version_id,
            versionNo: Number(row.version_no),
            createdAt: row.version_created_at,
            createdByMemberId: row.version_created_by_member_id,
          },
        })),
      };
    },

    async adminGetClubStats({ clubId }) {
      const [clubResult, memberCounts, entityCount, admissionCounts] = await Promise.all([
        pool.query<{ club_id: string; slug: string; name: string; archived_at: string | null }>(
          `select id as club_id, slug, name, archived_at::text as archived_at from clubs where id = $1 limit 1`,
          [clubId],
        ),
        pool.query<{ status: string; count: string }>(
          `select cm.status::text as status, count(*)::text as count
           from club_memberships cm where cm.club_id = $1 group by cm.status`,
          [clubId],
        ),
        pool.query<{ count: string }>(
          `select count(*)::text as count from entities where club_id = $1 and deleted_at is null`,
          [clubId],
        ),
        pool.query<{ status: string; count: string }>(
          `select cav.status::text as status, count(*)::text as count
           from current_admissions cav where cav.club_id = $1 group by cav.status`,
          [clubId],
        ),
      ]);

      const club = clubResult.rows[0];
      if (!club) return null;

      const messageCount = await pool.query<{ count: string }>(
        `select count(*)::text as count
         from dm_messages m
         join dm_threads t on t.id = m.thread_id
         where exists (
           select 1 from accessible_club_memberships am
           where am.member_id = t.member_a_id and am.club_id = $1
         )
         and exists (
           select 1 from accessible_club_memberships am
           where am.member_id = t.member_b_id and am.club_id = $1
         )`,
        [clubId],
      );

      return {
        clubId: club.club_id, slug: club.slug, name: club.name, archivedAt: club.archived_at,
        memberCounts: Object.fromEntries(memberCounts.rows.map((r) => [r.status, Number(r.count)])),
        entityCount: Number(entityCount.rows[0]?.count ?? 0),
        messageCount: Number(messageCount.rows[0]?.count ?? 0),
        admissionCounts: Object.fromEntries(admissionCounts.rows.map((r) => [r.status, Number(r.count)])),
      };
    },

    async adminListContent({ clubId, kind, limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        entity_id: string; content_thread_id: string; club_id: string; club_name: string; kind: string;
        author_member_id: string; author_public_name: string; author_handle: string | null;
        title: string | null; state: string; created_at: string;
      }>(
        `select e.id as entity_id, e.content_thread_id, e.club_id, c.name as club_name,
                e.kind::text as kind, e.author_member_id,
                m.public_name as author_public_name, m.handle as author_handle,
                cev.title, cev.state::text as state, e.created_at::text as created_at
         from entities e
         join current_entity_versions cev on cev.entity_id = e.id
         join members m on m.id = e.author_member_id
         join clubs c on c.id = e.club_id
         where e.deleted_at is null
           and ($1::text is null or e.club_id = $1)
           and ($2::text is null or e.kind::text = $2)
           and ($3::timestamptz is null or e.created_at < $3 or (e.created_at = $3 and e.id < $4))
         order by e.created_at desc, e.id desc limit $5`,
        [clubId ?? null, kind ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, fetchLimit],
      );

      const rows = result.rows.map((r) => {
        return {
          entityId: r.entity_id, contentThreadId: r.content_thread_id, clubId: r.club_id, clubName: r.club_name,
          kind: r.kind as any, author: { memberId: r.author_member_id, publicName: r.author_public_name, handle: r.author_handle },
          title: r.title, state: r.state as any, createdAt: r.created_at,
        };
      });
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const last = rows[rows.length - 1];
      const nextCursor = last ? paginationEncodeCursor([last.createdAt, last.entityId]) : null;
      return { results: rows, hasMore, nextCursor };
    },

    async adminListThreads({ limit, cursor }) {
      const fetchLimit = limit + 1;
      const result = await pool.query<{
        thread_id: string; message_count: number; latest_message_at: string;
        participants: Array<{ memberId: string; publicName: string; handle: string | null }>;
        created_at: string;
      }>(
        `select t.id as thread_id,
                (select count(*)::int from dm_messages m where m.thread_id = t.id) as message_count,
                (select max(m.created_at)::text from dm_messages m where m.thread_id = t.id) as latest_message_at,
                t.created_at::text as created_at,
                (select coalesce(json_agg(json_build_object(
                  'memberId', mbr.id, 'publicName', mbr.public_name, 'handle', mbr.handle
                )), '[]'::json)
                from dm_thread_participants tp
                join members mbr on mbr.id = tp.member_id
                where tp.thread_id = t.id) as participants
         from dm_threads t
         where ($1::timestamptz is null or t.created_at < $1 or (t.created_at = $1 and t.id < $2))
         order by t.created_at desc, t.id desc limit $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, fetchLimit],
      );

      // Batch-resolve shared clubs for all thread participant pairs
      const pairMap = new Map<string, [string, string]>();
      for (const r of result.rows) {
        const ids = r.participants.map(p => p.memberId);
        if (ids.length === 2) pairMap.set(r.thread_id, [ids[0], ids[1]]);
      }
      const sharedClubsByThread = await batchResolveSharedClubsPairs(pool, pairMap);

      const rows = result.rows.map((r) => ({
        threadId: r.thread_id,
        sharedClubs: sharedClubsByThread.get(r.thread_id) ?? [],
        participants: r.participants,
        messageCount: r.message_count,
        latestMessageAt: r.latest_message_at ?? '',
      }));
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
      const lastRow = hasMore || rows.length === limit ? result.rows[rows.length - 1] : null;
      const nextCursor = lastRow && rows.length > 0
        ? paginationEncodeCursor([lastRow.created_at, lastRow.thread_id])
        : null;
      return { results: rows, hasMore, nextCursor };
    },

    async adminReadThread({ threadId, limit }) {
      const thread = await pool.query<{
        thread_id: string;
        participants: Array<{ memberId: string; publicName: string; handle: string | null }>;
        message_count: number;
      }>(
        `select t.id as thread_id,
                (select coalesce(json_agg(json_build_object(
                  'memberId', mbr.id, 'publicName', mbr.public_name, 'handle', mbr.handle
                )), '[]'::json)
                from dm_thread_participants tp
                join members mbr on mbr.id = tp.member_id
                where tp.thread_id = t.id) as participants,
                (select count(*)::int from dm_messages mm where mm.thread_id = t.id) as message_count
         from dm_threads t where t.id = $1 limit 1`,
        [threadId],
      );
      if (!thread.rows[0]) return null;

      const messages = await pool.query<{
        message_id: string; thread_id: string; sender_member_id: string | null;
        role: string; message_text: string | null; payload: Record<string, unknown> | null;
        created_at: string; in_reply_to_message_id: string | null;
      }>(
        `select m.id as message_id, m.thread_id, m.sender_member_id,
                m.role::text as role,
                case when rmv.message_id is not null then '[Message removed]' else m.message_text end as message_text,
                case when rmv.message_id is not null then null else m.payload end as payload,
                m.created_at::text as created_at, m.in_reply_to_message_id
         from dm_messages m
         left join dm_message_removals rmv on rmv.message_id = m.id
         where m.thread_id = $1
         order by m.created_at desc, m.id desc limit $2`,
        [threadId, limit],
      );

      const latestMsg = messages.rows[0];

      const participantIds = thread.rows[0].participants.map(p => p.memberId);
      const threadSharedClubs = participantIds.length === 2
        ? await resolveSharedClubsUnscoped(pool, participantIds[0], participantIds[1])
        : [];

      return {
        thread: {
          threadId: thread.rows[0].thread_id,
          sharedClubs: threadSharedClubs,
          participants: thread.rows[0].participants,
          messageCount: thread.rows[0].message_count,
          latestMessageAt: latestMsg?.created_at ?? '',
        },
        messages: messages.rows.map((r) => ({
          messageId: r.message_id, threadId: r.thread_id, senderMemberId: r.sender_member_id,
          role: r.role as 'member' | 'agent' | 'system',
          messageText: r.message_text, payload: r.payload ?? {},
          createdAt: r.created_at, inReplyToMessageId: r.in_reply_to_message_id,
          updateReceipts: [],
        })).reverse(),
      };
    },

    adminListMemberTokens: ({ memberId }) => identity.listBearerTokens({ actorMemberId: memberId }),

    async adminRevokeMemberToken({ memberId, tokenId }) {
      return identity.revokeBearerToken({ actorMemberId: memberId, tokenId });
    },

    async adminGetDiagnostics() {
      const [migrationResult, memberCount, clubCount, tableCount, dbSize] = await Promise.all([
        pool.query<{ count: string; latest: string | null }>(
          `select count(*)::text as count, max(filename) as latest from public.schema_migrations
           where exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'schema_migrations')`,
        ).catch(() => ({ rows: [{ count: '0', latest: null }] })),
        pool.query<{ count: string }>(`select count(*)::text as count from members`),
        pool.query<{ count: string }>(`select count(*)::text as count from clubs`),
        pool.query<{ count: string }>(
          `select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name <> 'schema_migrations'`,
        ),
        pool.query<{ size: string }>(`select pg_size_pretty(pg_database_size(current_database())) as size`),
      ]);

      return {
        migrationCount: Number(migrationResult.rows[0]?.count ?? 0),
        latestMigration: migrationResult.rows[0]?.latest ?? null,
        memberCount: Number(memberCount.rows[0]?.count ?? 0),
        clubCount: Number(clubCount.rows[0]?.count ?? 0),
        tablesWithRls: 0,
        totalAppTables: Number(tableCount.rows[0]?.count ?? 0),
        databaseSize: dbSize.rows[0]?.size ?? '0 bytes',
      };
    },

    // ── Billing helpers ────────────────────────────────────────

    async getBillingStatus({ memberId, clubId }) {
      const result = await pool.query<{
        membership_id: string;
        status: string;
        is_comped: boolean;
        current_period_end: string | null;
        approved_price_amount: string | null;
        approved_price_currency: string | null;
      }>(
        `select
           m.id as membership_id,
           m.status,
           m.is_comped,
           s.current_period_end::text as current_period_end,
           m.approved_price_amount::text as approved_price_amount,
           m.approved_price_currency
         from club_memberships m
         left join club_subscriptions s on s.membership_id = m.id
           and s.status in ('trialing', 'active', 'past_due')
         where m.club_id = $1 and m.member_id = $2
         limit 1`,
        [clubId, memberId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        membershipId: row.membership_id,
        state: row.status,
        isComped: row.is_comped,
        paidThrough: row.current_period_end,
        approvedPrice: {
          amount: row.approved_price_amount != null ? Number(row.approved_price_amount) : null,
          currency: row.approved_price_currency,
        },
      };
    },

    async isPaidClub(clubId: string): Promise<boolean> {
      const result = await pool.query<{ is_paid: boolean }>(
        `select (membership_price_amount is not null) as is_paid from clubs where id = $1`,
        [clubId],
      );
      return result.rows[0]?.is_paid === true;
    },

    // ── Billing sync ─────────────────────────────────────────

    async billingActivateMembership({ membershipId, paidThrough }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; member_id: string; club_id: string;
          status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.member_id, cnm.club_id,
                  cnm.status::text as status, cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status === 'active') {
          const subRow = await client.query<{ id: string; current_period_end: string | null }>(
            `select id, current_period_end::text as current_period_end from club_subscriptions
             where membership_id = $1 and status in ('active', 'trialing')
             order by started_at desc limit 1`,
            [membershipId],
          );
          const liveSubscription = subRow.rows[0];
          if (liveSubscription?.current_period_end &&
              new Date(liveSubscription.current_period_end) >= new Date(paidThrough)) {
            return;
          }

          const priceRow = await client.query<{ approved_price_amount: string | null }>(
            `select approved_price_amount::text from club_memberships where id = $1`,
            [membershipId],
          );
          const amount = priceRow.rows[0]?.approved_price_amount != null
            ? Number(priceRow.rows[0].approved_price_amount) : 0;

          if (liveSubscription) {
            await client.query(
              `update club_subscriptions
               set current_period_end = $2,
                   status = 'active',
                   ended_at = null
               where id = $1`,
              [liveSubscription.id, paidThrough],
            );
          } else {
            await client.query(
              `insert into club_subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
               values ($1::short_id, $2::short_id, 'active', $3, $4)`,
              [membershipId, m.member_id, amount, paidThrough],
            );
          }
          return;
        }

        // Only payment_pending can transition to active via this action
        if (m.status !== 'payment_pending') {
          throw new AppError(409, 'invalid_state', `Cannot activate membership in state '${m.status}'; expected 'payment_pending'`);
        }

        // Transition membership state: payment_pending → active
        await client.query(
          `insert into club_membership_state_versions
           (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
           values ($1, 'active', 'Billing activation', $2, $3, null)`,
          [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
        );

        // Create subscription row
        const priceRow = await client.query<{ approved_price_amount: string | null }>(
          `select approved_price_amount::text from club_memberships where id = $1`,
          [membershipId],
        );
        const amount = priceRow.rows[0]?.approved_price_amount != null
          ? Number(priceRow.rows[0].approved_price_amount) : 0;
        await client.query(
          `insert into club_subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
           values ($1::short_id, $2::short_id, 'active', $3, $4)`,
          [membershipId, m.member_id, amount, paidThrough],
        );
      });
    },

    async billingRenewMembership({ membershipId, newPaidThrough }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status !== 'active' && m.status !== 'cancelled' && m.status !== 'renewal_pending') {
          throw new AppError(409, 'invalid_state', `Cannot renew membership in state '${m.status}'; expected 'active', 'cancelled', or 'renewal_pending'`);
        }

        // If cancelled or renewal_pending, transition back to active
        if (m.status === 'cancelled' || m.status === 'renewal_pending') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'active', 'Billing renewal', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }

        // Update subscription current_period_end forward only, and ensure status is active
        const updated = await client.query<{ id: string }>(
          `update club_subscriptions
           set current_period_end = greatest(current_period_end, $2::timestamptz),
               status = 'active',
               ended_at = null
           where membership_id = $1
             and status in ('active', 'trialing', 'past_due')
           returning id`,
          [membershipId, newPaidThrough],
        );

        // If no live subscription exists (e.g., was ended), create one
        if (updated.rows.length === 0) {
          await client.query(
            `insert into club_subscriptions (membership_id, payer_member_id, status, amount, current_period_end)
             select $1, ms.member_id, 'active',
                    coalesce(ms.approved_price_amount, 0), $2
             from club_memberships ms where ms.id = $1`,
            [membershipId, newPaidThrough],
          );
        }
      });
    },

    async billingMarkRenewalPending({ membershipId }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status !== 'active' && m.status !== 'renewal_pending') {
          throw new AppError(409, 'invalid_state', `Cannot mark renewal pending for membership in state '${m.status}'; expected 'active'`);
        }

        if (m.status === 'active') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'renewal_pending', 'Payment past due', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }

        await client.query(
          `update club_subscriptions set status = 'past_due'
           where membership_id = $1 and status in ('active', 'trialing')
           returning id`,
          [membershipId],
        );
      });
    },

    async billingExpireMembership({ membershipId }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        const allowedStates = ['active', 'renewal_pending', 'cancelled', 'payment_pending'];
        if (m.status !== 'expired' && !allowedStates.includes(m.status)) {
          throw new AppError(409, 'invalid_state', `Cannot expire membership in state '${m.status}'`);
        }

        if (m.status !== 'expired') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'expired', 'Billing expiration', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }

        await client.query(
          `update club_subscriptions set status = 'ended', ended_at = now()
           where membership_id = $1 and status in ('active', 'trialing', 'past_due')
           returning id`,
          [membershipId],
        );
      });
    },

    async billingCancelAtPeriodEnd({ membershipId }) {
      await withTransaction(pool, async (client) => {
        const row = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.id = $1 limit 1`,
          [membershipId],
        );
        const m = row.rows[0];
        if (!m) throw new AppError(404, 'not_found', 'Membership not found');

        if (m.status !== 'active' && m.status !== 'cancelled') {
          throw new AppError(409, 'invalid_state', `Cannot cancel membership in state '${m.status}'; expected 'active'`);
        }

        if (m.status === 'active') {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'cancelled', 'Cancelled at period end', $2, $3, null)`,
            [membershipId, Number(m.state_version_no) + 1, m.state_version_id],
          );
        }
      });
    },

    async billingBanMember({ memberId, reason }) {
      await withTransaction(pool, async (client) => {
        // Check member exists and current state
        const memberRow = await client.query<{ id: string; state: string }>(
          `select id, state::text as state from members where id = $1 limit 1`,
          [memberId],
        );
        const member = memberRow.rows[0];
        if (!member) throw new AppError(404, 'not_found', 'Member not found');

        if (member.state !== 'banned') {
          await client.query(
            `update members set state = 'banned' where id = $1`,
            [memberId],
          );
        }

        // Find all non-terminal memberships
        const terminalStates = ['banned', 'expired', 'revoked', 'rejected', 'left', 'removed'];
        const membershipsResult = await client.query<{
          membership_id: string; status: string; state_version_no: number; state_version_id: string;
        }>(
          `select cnm.id as membership_id, cnm.status::text as status,
                  cnm.state_version_no, cnm.state_version_id
           from current_club_memberships cnm
           where cnm.member_id = $1
             and cnm.status::text <> all($2::text[])`,
          [memberId, terminalStates],
        );
        // Transition each non-terminal membership to banned
        for (const ms of membershipsResult.rows) {
          await client.query(
            `insert into club_membership_state_versions
             (membership_id, status, reason, version_no, supersedes_state_version_id, created_by_member_id)
             values ($1, 'banned', $2, $3, $4, null)`,
            [ms.membership_id, reason, Number(ms.state_version_no) + 1, ms.state_version_id],
          );
        }

        // End all live subscriptions for this member
        await client.query(
          `update club_subscriptions set status = 'ended', ended_at = now()
           where payer_member_id = $1 and status in ('active', 'trialing', 'past_due')
           returning id`,
          [memberId],
        );
      });
    },

    async billingSetClubPrice({ clubId, amount, currency }) {
      await withTransaction(pool, async (client) => {
        const currentResult = await client.query<{
          club_id: string; current_version_id: string; current_version_no: number;
          owner_member_id: string; name: string; summary: string | null;
          admission_policy: string | null;
          membership_price_amount: string | null; membership_price_currency: string;
        }>(
          `select n.id as club_id, cv.id as current_version_id, cv.version_no as current_version_no,
                  cv.owner_member_id, cv.name, cv.summary, cv.admission_policy,
                  cv.membership_price_amount::text as membership_price_amount,
                  cv.membership_price_currency
           from clubs n
           join current_club_versions cv on cv.club_id = n.id
           where n.id = $1 limit 1`,
          [clubId],
        );

        const current = currentResult.rows[0];
        if (!current) throw new AppError(404, 'not_found', 'Club not found');

        const currentAmount = current.membership_price_amount != null ? Number(current.membership_price_amount) : null;
        if (currentAmount === amount && (amount === null || current.membership_price_currency === currency)) {
          return;
        }

        // Create new club version with updated price
        await client.query(
          `insert into club_versions
           (club_id, owner_member_id, name, summary, admission_policy,
            membership_price_amount, membership_price_currency,
            version_no, supersedes_version_id, created_by_member_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null)`,
          [clubId, current.owner_member_id, current.name, current.summary,
           current.admission_policy, amount, currency,
           Number(current.current_version_no) + 1, current.current_version_id],
        );
      });
    },

    async billingArchiveClub({ clubId }) {
      const result = await pool.query<{ club_id: string }>(
        `update clubs set archived_at = coalesce(archived_at, now())
         where id = $1 returning id as club_id`,
        [clubId],
      );
      if (!result.rows[0]) {
        throw new AppError(404, 'not_found', 'Club not found');
      }
    },
  };
}
