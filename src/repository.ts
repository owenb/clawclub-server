/**
 * Composition layer — implements the Repository interface from contract.ts
 * by routing operations to identity, messaging, and clubs pools.
 *
 * This is the only file that knows about all three databases.
 * Cross-plane operations, enrichment, and saga coordination live here.
 */

import type { Pool } from 'pg';
import { AppError, type Repository, type EntitySummary, type EventSummary, type MembershipVouchSummary, type AdmissionStatus, type PendingUpdate } from './contract.ts';
import { fetchMemberDisplayBatch, requireMember, type MemberDisplay } from './db.ts';
import { createIdentityRepository, type IdentityRepository } from './identity/index.ts';
import { createMessagingRepository, type MessagingRepository } from './messages/index.ts';
import { createClubsRepository, type ClubsRepository } from './clubs/index.ts';
import * as admissionsModule from './clubs/admissions.ts';

// ── Cursor helpers ──────────────────────────────────────────

/**
 * Compound cursor: independent positions for activity, signals, and inbox.
 * Encoded as base64url JSON: { a: activitySeq, s: signalSeq, t: inboxTimestamp }
 *
 * Backward compatible: old-format cursors { s: N, t: T } are read as
 * { a: N, s: 0, t: T }, defaulting signal position to 0 so the first
 * poll returns all unacknowledged signals.
 */
type UpdateCursor = { a: number; s: number; t: string };

function encodeCursor(cursor: UpdateCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): UpdateCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString());
    if (typeof parsed === 'object' && parsed !== null) {
      // New compound format: { a, s, t }
      if (typeof parsed.a === 'number') {
        return {
          a: parsed.a,
          s: typeof parsed.s === 'number' ? parsed.s : 0,
          t: typeof parsed.t === 'string' ? parsed.t : new Date(0).toISOString(),
        };
      }
      // Old format: { s: activitySeq, t: inboxTimestamp }
      if (typeof parsed.s === 'number') {
        return {
          a: parsed.s,
          s: 0,
          t: typeof parsed.t === 'string' ? parsed.t : new Date(0).toISOString(),
        };
      }
    }
  } catch {
    // Fall through
  }
  // Legacy: try parsing as plain number (very old cursor format)
  const n = Number(raw);
  if (Number.isFinite(n)) return { a: n, s: 0, t: new Date(0).toISOString() };
  return null;
}

// ── Enrichment helpers ──────────────────────────────────────

/** Batch-enrich event author + attendee names from identity. Mutates in place. */
async function enrichEvents(identityPool: Pool, events: EventSummary[]): Promise<void> {
  const memberIds: string[] = [];
  for (const event of events) {
    memberIds.push(event.author.memberId);
    for (const a of event.rsvps.attendees) memberIds.push(a.memberId);
  }
  const members = await fetchMemberDisplayBatch(identityPool, memberIds);
  for (const event of events) {
    const m = members.get(event.author.memberId);
    if (m) { event.author.publicName = m.publicName; event.author.handle = m.handle; }
    for (const a of event.rsvps.attendees) {
      const am = members.get(a.memberId);
      if (am) { a.publicName = am.publicName; a.handle = am.handle; }
    }
  }
}

/** Batch-enrich entity author names from identity. Mutates in place. */
async function enrichEntities(identityPool: Pool, entities: EntitySummary[]): Promise<void> {
  const ids = entities.map((e) => e.author.memberId);
  const members = await fetchMemberDisplayBatch(identityPool, ids);
  for (const entity of entities) {
    const m = members.get(entity.author.memberId);
    if (m) {
      entity.author.publicName = m.publicName;
      entity.author.handle = m.handle;
    }
  }
}

function enrichVouches(
  vouches: Array<{ edgeId: string; fromMemberId: string; reason: string; metadata: Record<string, unknown>; createdAt: string; createdByMemberId: string | null }>,
  members: Map<string, MemberDisplay>,
): MembershipVouchSummary[] {
  return vouches.map((v) => {
    const m = requireMember(members, v.fromMemberId);
    return {
      edgeId: v.edgeId,
      fromMember: { memberId: m.id, publicName: m.publicName, handle: m.handle },
      reason: v.reason,
      metadata: v.metadata,
      createdAt: v.createdAt,
      createdByMemberId: v.createdByMemberId,
    };
  });
}

/** Enrich an admission row from the clubs module with member display names from identity. */
async function enrichAdmission(
  identityPool: Pool,
  mapped: ReturnType<typeof admissionsModule.mapAdmissionRow>,
): Promise<import('./contract.ts').AdmissionSummary> {
  const memberIds = [mapped.applicantMemberId, mapped.sponsorMemberId].filter(Boolean) as string[];
  const members = await fetchMemberDisplayBatch(identityPool, memberIds);
  const applicantM = mapped.applicantMemberId ? members.get(mapped.applicantMemberId) : null;
  const sponsorM = mapped.sponsorMemberId ? members.get(mapped.sponsorMemberId) : null;

  const { applicantMemberId, applicantName, applicantEmail, sponsorMemberId, ...rest } = mapped;
  return {
    ...rest,
    applicant: {
      memberId: applicantMemberId,
      publicName: applicantM?.publicName ?? applicantName ?? 'Unknown applicant',
      handle: applicantM?.handle ?? null,
      email: applicantEmail,
    },
    sponsor: sponsorMemberId ? {
      memberId: sponsorMemberId,
      publicName: sponsorM?.publicName ?? 'Unknown sponsor',
      handle: sponsorM?.handle ?? null,
    } : null,
  };
}

// ── Factory ─────────────────────────────────────────────────

export function createRepository(pools: {
  identity: Pool;
  messaging: Pool;
  clubs: Pool;
}): Repository {
  const identity = createIdentityRepository(pools.identity);
  const messaging = createMessagingRepository(pools.messaging);
  const clubs = createClubsRepository(pools.clubs);

  return {
    // ── Auth ───────────────────────────────────────────────
    authenticateBearerToken: (bearerToken) => identity.authenticateBearerToken(bearerToken),

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
      // Reviews from identity (with sponsorStats but empty vouches)
      const reviews = await identity.listMembershipReviews(input);

      // Fetch vouches from clubs for each member in the reviews
      for (const review of reviews) {
        const vouches = await clubs.listVouches({
          clubIds: [review.clubId],
          targetMemberId: review.member.memberId,
          limit: 50,
        });
        const memberIds = vouches.map((v) => v.fromMemberId);
        const members = await fetchMemberDisplayBatch(pools.identity, memberIds);
        review.vouches = enrichVouches(vouches, members);
      }

      return reviews;
    },

    // ── Profiles ───────────────────────────────────────────
    getMemberProfile: ({ actorMemberId, targetMemberId }) => {
      // Need actor's accessible club IDs for shared club calculation
      return identity.readActor(actorMemberId).then((actor) => {
        if (!actor) return null;
        const clubIds = actor.memberships.map((m) => m.clubId);
        return identity.getMemberProfile({ actorMemberId, targetMemberId, actorClubIds: clubIds });
      });
    },
    updateOwnProfile: (input) => identity.updateOwnProfile(input),

    // ── Tokens ─────────────────────────────────────────────
    listBearerTokens: (input) => identity.listBearerTokens(input),
    createBearerToken: (input) => identity.createBearerToken(input),
    revokeBearerToken: (input) => identity.revokeBearerToken(input),

    // ── Search ─────────────────────────────────────────────
    fullTextSearchMembers: (input) => identity.fullTextSearchMembers(input),
    findMembersViaEmbedding: (input) => identity.findMembersViaEmbedding(input),

    // ── Entities (clubs + enrichment) ──────────────────────
    async createEntity(input) {
      await clubs.enforceQuota(input.authorMemberId, input.clubId, 'entities.create');
      const entity = await clubs.createEntity(input);
      await enrichEntities(pools.identity, [entity]);
      return entity;
    },

    async updateEntity(input) {
      const entity = await clubs.updateEntity(input);
      if (entity) await enrichEntities(pools.identity, [entity]);
      return entity;
    },

    async removeEntity(input) {
      const entity = await clubs.removeEntity({
        entityId: input.entityId,
        clubIds: input.accessibleClubIds,
        actorMemberId: input.actorMemberId,
        reason: input.reason,
        skipAuthCheck: input.skipAuthCheck,
      });
      if (entity) await enrichEntities(pools.identity, [entity]);
      return entity;
    },

    async listEntities(input) {
      const entities = await clubs.listEntities(input);
      await enrichEntities(pools.identity, entities);
      return entities;
    },

    // ── Events (clubs + enrichment) ────────────────────────
    async createEvent(input) {
      await clubs.enforceQuota(input.authorMemberId, input.clubId, 'events.create');
      const event = await clubs.createEvent(input);
      await enrichEvents(pools.identity, [event]);
      return event;
    },

    async listEvents(input) {
      // Get viewer's membership IDs for RSVP state
      const actor = await identity.readActor(input.actorMemberId);
      const viewerMembershipIds = actor?.memberships.map((m) => m.membershipId) ?? [];
      const eventList = await clubs.listEvents({
        clubIds: input.clubIds,
        limit: input.limit,
        query: input.query,
        viewerMembershipIds,
      });
      await enrichEvents(pools.identity, eventList);
      return eventList;
    },

    async rsvpEvent(input) {
      // Look up the event's club in the clubs DB to find the right membership
      const eventClubResult = await pools.clubs.query<{ club_id: string }>(
        `select e.club_id from app.entities e where e.id = $1 and e.kind = 'event' limit 1`,
        [input.eventEntityId],
      );
      const eventClubId = eventClubResult.rows[0]?.club_id;
      if (!eventClubId) return null;

      // Find the actor's membership for that specific club
      const membership = input.accessibleMemberships.find((m) => m.clubId === eventClubId);
      if (!membership) return null;

      const event = await clubs.rsvpEvent({
        eventEntityId: input.eventEntityId,
        membershipId: membership.membershipId,
        memberId: input.actorMemberId,
        response: input.response,
        note: input.note,
        clubIds: [eventClubId],
      });
      if (event) await enrichEvents(pools.identity, [event]);
      return event;
    },

    async removeEvent(input) {
      const event = await clubs.removeEvent({
        entityId: input.entityId,
        clubIds: input.accessibleClubIds,
        actorMemberId: input.actorMemberId,
        reason: input.reason,
        skipAuthCheck: input.skipAuthCheck,
      });
      if (event) await enrichEvents(pools.identity, [event]);
      return event;
    },

    // ── Vouches (clubs + enrichment) ───────────────────────
    async createVouch(input) {
      // Verify the target member has an accessible membership in this club (identity check)
      const targetCheck = await pools.identity.query<{ ok: boolean }>(
        `select exists(
           select 1 from app.accessible_club_memberships
           where member_id = $1 and club_id = $2
         ) as ok`,
        [input.targetMemberId, input.clubId],
      );
      if (!targetCheck.rows[0]?.ok) return null;

      const raw = await clubs.createVouch(input);
      if (!raw) return null;
      const members = await fetchMemberDisplayBatch(pools.identity, [raw.fromMemberId]);
      return enrichVouches([raw], members)[0];
    },

    async listVouches(input) {
      const raw = await clubs.listVouches({
        clubIds: input.clubIds,
        targetMemberId: input.targetMemberId,
        limit: input.limit,
      });
      const memberIds = raw.map((v) => v.fromMemberId);
      const members = await fetchMemberDisplayBatch(pools.identity, memberIds);
      return enrichVouches(raw, members);
    },

    // ── Admissions ─────────────────────────────────────────
    async createAdmissionSponsorship(input) {
      // Sponsorship data goes to clubs, sponsor name comes from identity
      const sponsorInfo = await identity.getMemberPublicContact(input.actorMemberId);
      const sponsorName = sponsorInfo?.memberName ?? 'Unknown';
      const sponsorHandle = (await fetchMemberDisplayBatch(pools.identity, [input.actorMemberId])).get(input.actorMemberId)?.handle ?? null;

      // Insert admission in clubs DB
      const result = await pools.clubs.query<{
        admission_id: string; club_id: string; sponsor_member_id: string;
        created_at: string;
      }>(
        `with inserted_admission as (
           insert into app.admissions (club_id, sponsor_member_id, origin, applicant_email, applicant_name, admission_details)
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

      await pools.clubs.query(
        `insert into app.admission_versions (admission_id, status, notes, version_no, created_by_member_id)
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
      if (!input.clubIds || input.clubIds.length === 0) return [];
      const result = await pools.clubs.query<Record<string, unknown>>(
        `select ca.id as admission_id, ca.club_id, ca.applicant_member_id, ca.applicant_email,
                ca.applicant_name, ca.sponsor_member_id, ca.membership_id, ca.origin,
                ca.intake_kind, ca.intake_price_amount, ca.intake_price_currency,
                ca.intake_booking_url, ca.intake_booked_at::text as intake_booked_at,
                ca.intake_completed_at::text as intake_completed_at,
                ca.status, ca.notes, ca.version_no, ca.version_created_at::text as version_created_at,
                ca.version_created_by_member_id, ca.admission_details, ca.metadata,
                ca.created_at::text as created_at
         from app.current_admissions ca
         where ca.club_id = any($1::text[])
           and ($2::text[] is null or ca.status::text = any($2::text[]))
         order by ca.version_created_at desc, ca.id asc
         limit $3`,
        [input.clubIds, input.statuses ?? null, input.limit],
      );

      // Batch enrich member names
      const memberIds = result.rows.flatMap((r) => [r.applicant_member_id as string, r.sponsor_member_id as string].filter(Boolean));
      const members = await fetchMemberDisplayBatch(pools.identity, memberIds);

      return result.rows.map((r) => {
        const applicant = r.applicant_member_id ? members.get(r.applicant_member_id as string) : null;
        const sponsor = r.sponsor_member_id ? members.get(r.sponsor_member_id as string) : null;
        return {
          admissionId: r.admission_id as string,
          clubId: r.club_id as string,
          applicant: {
            memberId: (r.applicant_member_id as string) ?? null,
            publicName: applicant?.publicName ?? (r.applicant_name as string) ?? 'Unknown applicant',
            handle: applicant?.handle ?? null,
            email: (r.applicant_email as string) ?? null,
          },
          sponsor: r.sponsor_member_id ? {
            memberId: r.sponsor_member_id as string,
            publicName: sponsor?.publicName ?? 'Unknown sponsor',
            handle: sponsor?.handle ?? null,
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
      });
    },

    async transitionAdmission(input) {
      const result = await admissionsModule.transitionAdmission(pools.clubs, {
        admissionId: input.admissionId,
        clubIds: input.accessibleClubIds,
        actorMemberId: input.actorMemberId,
        nextStatus: input.nextStatus,
        notes: input.notes,
        intake: input.intake,
        metadataPatch: input.metadataPatch,
      });
      if (!result) return null;

      // Cross-plane saga: on acceptance, create member + membership in identity
      if (result.isAcceptance) {
        const adm = result.admission;
        const clubId = adm.club_id;
        let memberId = adm.applicant_member_id;

        if (result.isOutsider) {
          // Retry safety — three-layer lookup:
          // 1. Check if membership already exists (source_admission_id anchor)
          const existingMembership = await pools.identity.query<{ member_id: string; id: string }>(
            `select member_id, id from app.club_memberships where source_admission_id = $1 limit 1`,
            [adm.admission_id],
          );
          if (existingMembership.rows[0]) {
            memberId = existingMembership.rows[0].member_id;
            await admissionsModule.linkAdmissionToMember(pools.clubs, adm.admission_id, memberId, existingMembership.rows[0].id);
          } else {
            // 2. Check if member was created but membership wasn't (clubs-side link exists)
            const clubsSideLink = await pools.clubs.query<{ applicant_member_id: string | null }>(
              `select applicant_member_id from app.admissions where id = $1`,
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
              await pools.clubs.query(
                `update app.admissions set applicant_member_id = $2 where id = $1`,
                [adm.admission_id, memberId],
              );
            }
          }
        }

        if (memberId) {
          // Create membership in identity (idempotent via source_admission_id unique index)
          const sponsorId = adm.sponsor_member_id ?? input.actorMemberId;
          const membershipResult = await identity.createMembership({
            actorMemberId: input.actorMemberId,
            clubId,
            memberId,
            sponsorMemberId: sponsorId,
            role: 'member',
            initialStatus: 'active',
            sourceAdmissionId: adm.admission_id,
            reason: 'Admitted from accepted admission',
            metadata: {},
          });

          if (membershipResult) {
            // Link admission to member and membership in clubs DB
            await admissionsModule.linkAdmissionToMember(pools.clubs, adm.admission_id, memberId, membershipResult.membershipId);
          }
        }
      }

      // Re-read and enrich
      const finalAdm = await admissionsModule.readAdmission(pools.clubs, input.admissionId);
      if (!finalAdm) return null;
      return enrichAdmission(pools.identity, admissionsModule.mapAdmissionRow(finalAdm));
    },

    async createAdmissionChallenge(input) {
      // Look up club in identity DB
      const clubResult = await pools.identity.query<{
        club_id: string; name: string; summary: string | null;
        admission_policy: string; owner_member_id: string;
      }>(
        `select c.id as club_id, c.name, c.summary, c.admission_policy, c.owner_member_id
         from app.clubs c
         where c.slug = $1 and c.archived_at is null and c.admission_policy is not null
         limit 1`,
        [input.clubSlug],
      );
      const club = clubResult.rows[0];
      if (!club) throw new AppError(404, 'club_not_found', 'Club not found or is not accepting applications');

      // Get owner name from identity
      const ownerInfo = await identity.getMemberPublicContact(club.owner_member_id);
      const ownerName = ownerInfo?.memberName ?? 'Club Owner';

      // Create challenge in clubs DB
      const challenge = await admissionsModule.createAdmissionChallenge(pools.clubs, {
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
      return admissionsModule.solveAdmissionChallenge(pools.clubs, input);
    },

    async issueAdmissionAccess(input) {
      // Look up admission in clubs DB
      const admResult = await pools.clubs.query<{
        admission_id: string; applicant_member_id: string | null; status: string;
      }>(
        `select ca.id as admission_id, ca.applicant_member_id, ca.status
         from app.current_admissions ca
         where ca.id = $1 and ca.club_id = any($2::text[])
         limit 1`,
        [input.admissionId, input.accessibleClubIds],
      );
      const admission = admResult.rows[0];
      if (!admission) return null;
      if (admission.status !== 'accepted') throw new AppError(409, 'admission_not_accepted', 'Access can only be issued for accepted admissions');
      if (!admission.applicant_member_id) throw new AppError(409, 'admission_not_finalized', 'Admission has no linked member');

      // Create token in identity DB
      const { bearerToken } = await identity.issueTokenForMember(
        admission.applicant_member_id,
        input.label ?? 'Issued from admission acceptance',
        { source: 'admission', admissionId: input.admissionId },
      );

      // Re-read admission for response
      const finalAdm = await admissionsModule.readAdmission(pools.clubs, input.admissionId);
      if (!finalAdm) return null;
      const enriched = await enrichAdmission(pools.identity, admissionsModule.mapAdmissionRow(finalAdm));
      return { admission: enriched, bearerToken };
    },

    // ── Messages (messaging + enrichment) ──────────────────
    async sendDirectMessage(input) {
      // Check shared clubs in identity — the messaging plane has no club concept
      const sharedClubResult = await pools.identity.query<{ club_id: string }>(
        `with actor_scope as (
           select distinct club_id from app.accessible_club_memberships
           where member_id = $1 and club_id = any($2::text[])
         )
         select actor_scope.club_id
         from actor_scope
         join app.accessible_club_memberships recipient_scope
           on recipient_scope.club_id = actor_scope.club_id
         where recipient_scope.member_id = $3
           and ($4::text is null or actor_scope.club_id = $4)
         order by actor_scope.club_id asc`,
        [input.actorMemberId, input.accessibleClubIds, input.recipientMemberId, input.clubId ?? null],
      );

      if (sharedClubResult.rows.length === 0) return null;

      if (!input.clubId && sharedClubResult.rows.length > 1) {
        throw new AppError(400, 'invalid_input', 'Sender and recipient share multiple clubs. Provide clubId to specify which club context to use.');
      }

      const clubId = sharedClubResult.rows[0]!.club_id;

      const msg = await messaging.sendMessage({
        senderMemberId: input.actorMemberId,
        recipientMemberId: input.recipientMemberId,
        messageText: input.messageText,
        clientKey: input.clientKey,
      });

      return {
        threadId: msg.threadId,
        clubId,
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
      const memberIds = threads.map((t) => t.counterpartMemberId);
      const members = await fetchMemberDisplayBatch(pools.identity, memberIds);

      return threads.map((t) => {
        const m = requireMember(members, t.counterpartMemberId);
        return {
          threadId: t.threadId,
          clubId: '', // messaging plane has no club_id
          counterpartMemberId: t.counterpartMemberId,
          counterpartPublicName: m.publicName,
          counterpartHandle: m.handle,
          latestMessage: t.latestMessage,
          messageCount: t.messageCount,
        };
      });
    },

    async listDirectMessageInbox({ actorMemberId, limit, unreadOnly }) {
      const entries = await messaging.listInbox({ memberId: actorMemberId, limit, unreadOnly });
      const memberIds = entries.map((e) => e.counterpartMemberId);
      const members = await fetchMemberDisplayBatch(pools.identity, memberIds);

      return entries.map((e) => {
        const m = requireMember(members, e.counterpartMemberId);
        return {
          threadId: e.threadId,
          clubId: '',
          counterpartMemberId: e.counterpartMemberId,
          counterpartPublicName: m.publicName,
          counterpartHandle: m.handle,
          latestMessage: e.latestMessage,
          messageCount: e.messageCount,
          unread: {
            hasUnread: e.hasUnread,
            unreadMessageCount: e.unreadCount,
            unreadUpdateCount: e.unreadCount,
            latestUnreadMessageCreatedAt: e.latestUnreadAt,
          },
        };
      });
    },

    async readDirectMessageThread({ actorMemberId, threadId, limit }) {
      const result = await messaging.readThread({ memberId: actorMemberId, threadId, limit });
      if (!result) return null;

      const m = (await fetchMemberDisplayBatch(pools.identity, [result.thread.counterpartMemberId]))
        .get(result.thread.counterpartMemberId);

      return {
        thread: {
          threadId: result.thread.threadId,
          clubId: '',
          counterpartMemberId: result.thread.counterpartMemberId,
          counterpartPublicName: m?.publicName ?? 'Unknown',
          counterpartHandle: m?.handle ?? null,
          latestMessage: result.thread.latestMessage,
          messageCount: result.thread.messageCount,
        },
        messages: result.messages.map((msg) => ({
          ...msg,
          updateReceipts: [],
        })),
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
        clubId: '', // messaging has no club_id
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

      // ── Source 1: Club activity ──
      const activity = await clubs.listClubActivity({
        memberId: input.actorMemberId,
        clubIds: input.clubIds,
        limit: input.limit,
        afterSeq: cursor?.a ?? null,
        adminClubIds,
        ownerClubIds,
      });

      // ── Source 2: Member signals ──
      const afterSignalSeq = cursor?.s ?? null;
      let signalSeq: number;
      let signalItems: PendingUpdate[] = [];

      if (afterSignalSeq == null) {
        // First poll: seed signal cursor from max(seq)
        const seedResult = await pools.clubs.query<{ max_seq: string }>(
          `select coalesce(max(seq), 0)::text as max_seq from app.member_signals
           where recipient_member_id = $1 and club_id = any($2::text[])`,
          [input.actorMemberId, input.clubIds],
        );
        signalSeq = parseInt(seedResult.rows[0]?.max_seq ?? '0', 10);
      } else {
        const signalResult = await pools.clubs.query<{
          id: string; club_id: string; recipient_member_id: string; seq: string;
          topic: string; payload: Record<string, unknown>; entity_id: string | null;
          match_id: string | null; created_at: string;
        }>(
          `select id, club_id, recipient_member_id, seq::text as seq, topic, payload,
                  entity_id, match_id, created_at::text as created_at
           from app.member_signals ms
           where recipient_member_id = $1
             and club_id = any($2::text[])
             and acknowledged_state is null
             and seq > $3
             and (
               ms.entity_id is null
               or exists (
                 select 1 from app.current_entity_versions cev
                 where cev.entity_id = ms.entity_id and cev.state = 'published'
               )
             )
             and (
               ms.topic <> 'signal.offer_match'
               or ms.payload->>'yourAskEntityId' is null
               or exists (
                 select 1 from app.current_entity_versions cev
                 where cev.entity_id = ms.payload->>'yourAskEntityId' and cev.state = 'published'
               )
             )
           order by seq asc limit $4`,
          [input.actorMemberId, input.clubIds, afterSignalSeq, input.limit],
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
      }

      // ── Source 3: Inbox (DMs) ──
      const cursorTimestamp = cursor?.t ?? null;
      const inboxResult = await pools.messaging.query<{
        id: string; recipient_member_id: string; thread_id: string;
        message_id: string; created_at: string;
      }>(
        `select ie.id, ie.recipient_member_id, ie.thread_id, ie.message_id,
                ie.created_at::text as created_at
         from app.messaging_inbox_entries ie
         where ie.recipient_member_id = $1 and ie.acknowledged = false
           and ($3::timestamptz is null or ie.created_at > $3)
           and not exists (
             select 1 from app.messaging_message_removals rmv where rmv.message_id = ie.message_id
           )
         order by ie.created_at desc limit $2`,
        [input.actorMemberId, input.limit, cursorTimestamp],
      );

      // Get sender info for DM updates
      const dmMemberIds: string[] = [];
      const messageData = new Map<string, { sender_member_id: string | null; message_text: string | null; thread_id: string }>();
      for (const ie of inboxResult.rows) {
        const msgResult = await pools.messaging.query<{
          sender_member_id: string | null; message_text: string | null;
        }>(
          `select m.sender_member_id, m.message_text from app.messaging_messages m where m.id = $1`,
          [ie.message_id],
        );
        if (msgResult.rows[0]) {
          messageData.set(ie.message_id, { ...msgResult.rows[0], thread_id: ie.thread_id });
          if (msgResult.rows[0].sender_member_id) dmMemberIds.push(msgResult.rows[0].sender_member_id);
        }
      }
      const dmMembers = await fetchMemberDisplayBatch(pools.identity, dmMemberIds);

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

      const inboxItems = inboxResult.rows.map((ie, idx) => {
        const msg = messageData.get(ie.message_id);
        const sender = msg?.sender_member_id ? dmMembers.get(msg.sender_member_id) : null;
        const tsMs = Date.parse(ie.created_at) || Date.now();
        return {
          updateId: `inbox:${ie.id}`,
          streamSeq: tsMs + idx,
          source: 'inbox' as const,
          recipientMemberId: ie.recipient_member_id,
          clubId: '',
          entityId: null,
          entityVersionId: null,
          dmMessageId: ie.message_id,
          topic: 'dm.message.created',
          payload: {
            kind: 'dm',
            threadId: msg?.thread_id ?? ie.thread_id,
            messageId: ie.message_id,
            senderMemberId: msg?.sender_member_id ?? null,
            senderPublicName: sender?.publicName ?? 'Unknown',
            senderHandle: sender?.handle ?? null,
            recipientMemberId: ie.recipient_member_id,
            messageText: msg?.message_text ?? null,
          },
          createdAt: ie.created_at,
          createdByMemberId: msg?.sender_member_id ?? null,
        };
      });

      // Merge all three sources
      const allItems = [...activityItems, ...signalItems, ...inboxItems];
      const polledAt = new Date().toISOString();

      return {
        items: allItems,
        nextAfter: activity.nextAfterSeq != null
          ? encodeCursor({ a: activity.nextAfterSeq, s: signalSeq, t: polledAt })
          : null,
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
      const signalSeed = await pools.clubs.query<{ max_seq: string }>(
        `select coalesce(max(seq), 0)::text as max_seq from app.member_signals
         where recipient_member_id = $1 and club_id = any($2::text[])`,
        [input.actorMemberId, input.clubIds],
      );
      const signalSeq = parseInt(signalSeed.rows[0]?.max_seq ?? '0', 10);

      if (activity.nextAfterSeq == null) return null;
      return encodeCursor({ a: activity.nextAfterSeq, s: signalSeq, t: new Date().toISOString() });
    },

    async acknowledgeUpdates(input) {
      // ── Inbox acknowledgements ──
      const inboxIds = input.updateIds
        .filter((id) => id.startsWith('inbox:'))
        .map((id) => id.replace('inbox:', ''));

      const updatedInboxIds = new Set<string>();
      if (inboxIds.length > 0) {
        const result = await pools.messaging.query<{ id: string }>(
          `update app.messaging_inbox_entries
           set acknowledged = true
           where id = any($1::text[]) and recipient_member_id = $2 and acknowledged = false
           returning id`,
          [inboxIds, input.actorMemberId],
        );
        for (const row of result.rows) updatedInboxIds.add(row.id);
      }

      // ── Signal acknowledgements (durable state) ──
      const signalIds = input.updateIds
        .filter((id) => id.startsWith('signal:'))
        .map((id) => id.replace('signal:', ''));

      const updatedSignalIds = new Set<string>();
      if (signalIds.length > 0) {
        const result = await pools.clubs.query<{ id: string }>(
          `update app.member_signals
           set acknowledged_state = $3,
               acknowledged_at = now(),
               suppression_reason = $4
           where id = any($1::text[])
             and recipient_member_id = $2
             and acknowledged_state is null
           returning id`,
          [signalIds, input.actorMemberId, input.state, input.suppressionReason ?? null],
        );
        for (const row of result.rows) updatedSignalIds.add(row.id);
      }

      // Return receipts for activity (always), inbox (if updated), and signal (if updated) IDs
      return input.updateIds
        .filter((id) => {
          if (id.startsWith('inbox:')) return updatedInboxIds.has(id.replace('inbox:', ''));
          if (id.startsWith('signal:')) return updatedSignalIds.has(id.replace('signal:', ''));
          return true; // activity IDs always get receipts
        })
        .map((updateId) => ({
          receiptId: updateId,
          updateId,
          recipientMemberId: input.actorMemberId,
          clubId: '',
          state: input.state,
          suppressionReason: input.suppressionReason ?? null,
          versionNo: 1,
          supersedesReceiptId: null,
          createdAt: new Date().toISOString(),
          createdByMemberId: input.actorMemberId,
        }));
    },

    // ── Quotas ─────────────────────────────────────────────
    getQuotaStatus: (input) => clubs.getQuotaStatus(input),

    // ── LLM ────────────────────────────────────────────────
    logLlmUsage: (input) => clubs.logLlmUsage(input),

    // ── Embeddings ─────────────────────────────────────────
    async findEntitiesViaEmbedding(input) {
      const entities = await clubs.findEntitiesViaEmbedding(input);
      await enrichEntities(pools.identity, entities);
      return entities;
    },

    // ── Admin (cross-plane) ────────────────────────────────
    async adminGetOverview() {
      const [totalMemberCount, activeMemberCount, clubCount, entityCount, messageCount, admissionCount] = await Promise.all([
        pools.identity.query<{ count: string }>(`select count(*)::text as count from app.members`),
        pools.identity.query<{ count: string }>(`select count(*)::text as count from app.members where state = 'active'`),
        pools.identity.query<{ count: string }>(`select count(*)::text as count from app.clubs where archived_at is null`),
        pools.clubs.query<{ count: string }>(`select count(*)::text as count from app.entities where deleted_at is null`),
        pools.messaging.query<{ count: string }>(`select count(*)::text as count from app.messaging_messages`),
        pools.clubs.query<{ count: string }>(`select count(*)::text as count from app.admissions`),
      ]);

      const recentMembers = await pools.identity.query<{
        member_id: string; public_name: string; handle: string | null; created_at: string;
      }>(
        `select id as member_id, public_name, handle, created_at::text as created_at
         from app.members
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
      const result = await pools.identity.query<{
        member_id: string; public_name: string; handle: string | null;
        state: string; created_at: string; membership_count: number; token_count: number;
      }>(
        `select m.id as member_id, m.public_name, m.handle, m.state::text as state,
                m.created_at::text as created_at,
                (select count(*)::int from app.club_memberships cm where cm.member_id = m.id) as membership_count,
                (select count(*)::int from app.member_bearer_tokens t where t.member_id = m.id and t.revoked_at is null) as token_count
         from app.members m
         where ($1::timestamptz is null or m.created_at < $1 or (m.created_at = $1 and m.id < $2))
         order by m.created_at desc, m.id desc
         limit $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );

      return result.rows.map((r) => ({
        memberId: r.member_id, publicName: r.public_name, handle: r.handle,
        state: r.state, createdAt: r.created_at,
        membershipCount: r.membership_count, tokenCount: r.token_count,
      }));
    },

    async adminGetMember({ memberId }) {
      const memberResult = await pools.identity.query<{
        member_id: string; public_name: string; handle: string | null;
        state: string; created_at: string;
      }>(
        `select id as member_id, public_name, handle, state::text as state, created_at::text as created_at
         from app.members where id = $1 limit 1`,
        [memberId],
      );
      if (!memberResult.rows[0]) return null;
      const m = memberResult.rows[0];

      const membershipsResult = await pools.identity.query<{
        membership_id: string; club_id: string; club_name: string; club_slug: string;
        role: string; status: string; joined_at: string;
      }>(
        `select cm.id as membership_id, cm.club_id, c.name as club_name, c.slug as club_slug,
                cm.role::text as role, cm.status::text as status, cm.joined_at::text as joined_at
         from app.club_memberships cm
         join app.clubs c on c.id = cm.club_id
         where cm.member_id = $1
         order by cm.joined_at desc`,
        [memberId],
      );

      const tokenCount = await pools.identity.query<{ count: string }>(
        `select count(*)::text as count from app.member_bearer_tokens where member_id = $1 and revoked_at is null`,
        [memberId],
      );

      const profile = await identity.getMemberProfile({ actorMemberId: memberId, targetMemberId: memberId, actorClubIds: [] });

      return {
        memberId: m.member_id, publicName: m.public_name, handle: m.handle,
        state: m.state, createdAt: m.created_at,
        memberships: membershipsResult.rows.map((r) => ({
          membershipId: r.membership_id, clubId: r.club_id, clubName: r.club_name,
          clubSlug: r.club_slug, role: r.role, status: r.status, joinedAt: r.joined_at,
        })),
        tokenCount: Number(tokenCount.rows[0]?.count ?? 0),
        profile,
      };
    },

    async adminGetClubStats({ clubId }) {
      const [clubResult, memberCounts, entityCount, admissionCounts] = await Promise.all([
        pools.identity.query<{ club_id: string; slug: string; name: string; archived_at: string | null }>(
          `select id as club_id, slug, name, archived_at::text as archived_at from app.clubs where id = $1 limit 1`,
          [clubId],
        ),
        pools.identity.query<{ status: string; count: string }>(
          `select cm.status::text as status, count(*)::text as count
           from app.club_memberships cm where cm.club_id = $1 group by cm.status`,
          [clubId],
        ),
        pools.clubs.query<{ count: string }>(
          `select count(*)::text as count from app.entities where club_id = $1 and deleted_at is null`,
          [clubId],
        ),
        pools.clubs.query<{ status: string; count: string }>(
          `select cav.status::text as status, count(*)::text as count
           from app.current_admissions cav where cav.club_id = $1 group by cav.status`,
          [clubId],
        ),
      ]);

      const club = clubResult.rows[0];
      if (!club) return null;

      const messageCount = await pools.messaging.query<{ count: string }>(
        `select count(*)::text as count from app.messaging_messages`,
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
      const result = await pools.clubs.query<{
        entity_id: string; club_id: string; kind: string; author_member_id: string;
        title: string | null; state: string; created_at: string;
      }>(
        `select e.id as entity_id, e.club_id, e.kind::text as kind, e.author_member_id,
                cev.title, cev.state::text as state, e.created_at::text as created_at
         from app.entities e
         join app.current_entity_versions cev on cev.entity_id = e.id
         where e.deleted_at is null
           and ($1::text is null or e.club_id = $1)
           and ($2::text is null or e.kind::text = $2)
           and ($3::timestamptz is null or e.created_at < $3 or (e.created_at = $3 and e.id < $4))
         order by e.created_at desc, e.id desc limit $5`,
        [clubId ?? null, kind ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );

      const memberIds = result.rows.map((r) => r.author_member_id);
      const members = await fetchMemberDisplayBatch(pools.identity, memberIds);

      // Get club names from identity
      const clubIds = [...new Set(result.rows.map((r) => r.club_id))];
      const clubNames = new Map<string, string>();
      if (clubIds.length > 0) {
        const clubResult = await pools.identity.query<{ id: string; name: string }>(
          `select id, name from app.clubs where id = any($1::text[])`,
          [clubIds],
        );
        for (const c of clubResult.rows) clubNames.set(c.id, c.name);
      }

      return result.rows.map((r) => {
        const m = requireMember(members, r.author_member_id);
        return {
          entityId: r.entity_id, clubId: r.club_id, clubName: clubNames.get(r.club_id) ?? '',
          kind: r.kind as any, author: { memberId: m.id, publicName: m.publicName, handle: m.handle },
          title: r.title, state: r.state as any, createdAt: r.created_at,
        };
      });
    },

    async adminListThreads({ limit, cursor }) {
      const result = await pools.messaging.query<{
        thread_id: string; message_count: number; latest_message_at: string;
        participant_ids: string[];
      }>(
        `select t.id as thread_id,
                (select count(*)::int from app.messaging_messages m where m.thread_id = t.id) as message_count,
                (select max(m.created_at)::text from app.messaging_messages m where m.thread_id = t.id) as latest_message_at,
                array(select tp.member_id from app.messaging_thread_participants tp where tp.thread_id = t.id) as participant_ids
         from app.messaging_threads t
         where ($1::timestamptz is null or t.created_at < $1 or (t.created_at = $1 and t.id < $2))
         order by t.created_at desc, t.id desc limit $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, limit],
      );

      const allMemberIds = result.rows.flatMap((r) => r.participant_ids);
      const members = await fetchMemberDisplayBatch(pools.identity, allMemberIds);

      return result.rows.map((r) => ({
        threadId: r.thread_id, clubId: '', clubName: '',
        participants: r.participant_ids.map((id) => {
          const m = requireMember(members, id);
          return { memberId: m.id, publicName: m.publicName, handle: m.handle };
        }),
        messageCount: r.message_count,
        latestMessageAt: r.latest_message_at ?? '',
      }));
    },

    async adminReadThread({ threadId, limit }) {
      const thread = await pools.messaging.query<{
        thread_id: string; participant_ids: string[];
      }>(
        `select t.id as thread_id,
                array(select tp.member_id from app.messaging_thread_participants tp where tp.thread_id = t.id) as participant_ids
         from app.messaging_threads t where t.id = $1 limit 1`,
        [threadId],
      );
      if (!thread.rows[0]) return null;

      const messages = await pools.messaging.query<{
        message_id: string; thread_id: string; sender_member_id: string | null;
        role: string; message_text: string | null; payload: Record<string, unknown> | null;
        created_at: string; in_reply_to_message_id: string | null;
      }>(
        `select m.id as message_id, m.thread_id, m.sender_member_id,
                m.role::text as role,
                case when rmv.message_id is not null then '[Message removed]' else m.message_text end as message_text,
                case when rmv.message_id is not null then null else m.payload end as payload,
                m.created_at::text as created_at, m.in_reply_to_message_id
         from app.messaging_messages m
         left join app.messaging_message_removals rmv on rmv.message_id = m.id
         where m.thread_id = $1
         order by m.created_at desc, m.id desc limit $2`,
        [threadId, limit],
      );

      const allMemberIds = thread.rows[0].participant_ids;
      const members = await fetchMemberDisplayBatch(pools.identity, allMemberIds);

      const msgCount = await pools.messaging.query<{ count: string }>(
        `select count(*)::text as count from app.messaging_messages where thread_id = $1`,
        [threadId],
      );

      const latestMsg = messages.rows[0];

      return {
        thread: {
          threadId: thread.rows[0].thread_id, clubId: '', clubName: '',
          participants: allMemberIds.map((id) => {
            const m = requireMember(members, id);
            return { memberId: m.id, publicName: m.publicName, handle: m.handle };
          }),
          messageCount: Number(msgCount.rows[0]?.count ?? 0),
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
        pools.identity.query<{ count: string; latest: string | null }>(
          `select count(*)::text as count, max(filename) as latest from public.schema_migrations`,
        ),
        pools.identity.query<{ count: string }>(`select count(*)::text as count from app.members`),
        pools.identity.query<{ count: string }>(`select count(*)::text as count from app.clubs`),
        pools.identity.query<{ count: string }>(
          `select count(*)::text as count from information_schema.tables where table_schema = 'app'`,
        ),
        pools.identity.query<{ size: string }>(`select pg_size_pretty(pg_database_size(current_database())) as size`),
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
  };
}
