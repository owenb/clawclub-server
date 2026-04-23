import { z } from 'zod';
import { APPLICATION_SUBMISSION_PATH_DESCRIPTION, timestampString } from './fields.ts';

export const applicationPhase = z.enum(['revision_required', 'awaiting_review', 'active', 'declined', 'banned', 'removed', 'withdrawn']);

export const applicationDraft = z.object({
  name: z.string(),
  socials: z.string(),
  application: z.string(),
});

export const applicationNext = z.object({
  action: z.string(),
  requiredInputs: z.array(z.string()).optional(),
  reason: z.string(),
  estimatedEffort: z.string().optional(),
  applicationId: z.string().optional(),
}).nullable();

export const applicationRoadmapStep = z.object({
  phase: z.string(),
  description: z.string(),
});

export const applicationGateFeedback = z.object({
  message: z.string().nullable(),
  missingItems: z.array(z.string()),
});

export const applicationWorkflow = z.object({
  awaitingActor: z.enum(['applicant', 'clubadmins', 'none']).describe('Who must act next: the applicant, club admins, or nobody.'),
  currentlySubmittedToAdmins: z.boolean().describe('True only while the current draft is actually in the club-admin review queue.'),
  submittedToAdminsAt: timestampString.nullable().describe('When this application most recently entered the club-admin review queue. Null means the current saved draft has not reached admins.'),
  applicantMustActNow: z.boolean().describe('True when the applicant still needs to do work before the process can advance.'),
  canApplicantRevise: z.boolean().describe('True when clubs.applications.revise is allowed right now.'),
});

export const memberApplicationGate = z.object({
  verdict: z.enum(['passed', 'needs_revision', 'not_run', 'unavailable']),
  feedback: applicationGateFeedback.nullable(),
});

export const adminApplicationGate = memberApplicationGate.extend({
  lastRunAt: timestampString.nullable(),
});

const memberInvitationMetadata = z.object({
  invitationId: z.string(),
  inviteMode: z.enum(['internal', 'external']),
});

const adminInvitationMetadata = memberInvitationMetadata.extend({
  inviteReasonSnapshot: z.string(),
  sponsorshipStillOpen: z.boolean(),
});

export const memberApplicationState = z.object({
  application: z.object({
    applicationId: z.string(),
    clubId: z.string(),
    clubSlug: z.string(),
    clubName: z.string(),
    clubSummary: z.string().nullable(),
    admissionPolicy: z.string().nullable(),
    submissionPath: z.enum(['cold', 'invitation']).describe(APPLICATION_SUBMISSION_PATH_DESCRIPTION),
    sponsorName: z.string().nullable().optional(),
    invitation: memberInvitationMetadata.nullable().optional(),
    phase: applicationPhase,
    submittedAt: timestampString.describe('Timestamp of the latest saved draft for this application. When phase is revision_required, this is only a saved-draft timestamp; use workflow.currentlySubmittedToAdmins to know whether admins currently have the application.'),
    decidedAt: timestampString.nullable(),
  }),
  draft: applicationDraft,
  gate: memberApplicationGate,
  workflow: applicationWorkflow,
  next: applicationNext,
  roadmap: z.array(applicationRoadmapStep),
  applicationLimits: z.object({
    inFlightCount: z.number().describe('Current number of live applications counting against the member cap, including revision_required drafts even when default lists hide them.'),
    maxInFlight: z.number().describe('Maximum number of live applications the member may keep in flight at once.'),
  }),
  messages: z.object({
    summary: z.string(),
    details: z.string(),
  }),
  membership: z.object({
    membershipId: z.string(),
    clubId: z.string(),
    role: z.enum(['clubadmin', 'member']),
    joinedAt: timestampString.nullable(),
  }).optional(),
});

export const adminApplicationState = z.object({
  applicationId: z.string(),
  clubId: z.string(),
  clubSlug: z.string(),
  clubName: z.string(),
  clubSummary: z.string().nullable(),
  admissionPolicy: z.string().nullable(),
  applicantMemberId: z.string(),
  sponsorId: z.string().nullable(),
  sponsorName: z.string().nullable(),
  submissionPath: z.enum(['cold', 'invitation']).describe(APPLICATION_SUBMISSION_PATH_DESCRIPTION),
  invitation: adminInvitationMetadata.nullable().optional(),
  phase: applicationPhase,
  draft: applicationDraft,
  gate: adminApplicationGate,
  admin: z.object({
    note: z.string().nullable(),
    workflowStage: z.string().nullable(),
  }),
  submittedAt: timestampString.describe('Timestamp of the latest saved draft for this application. For revision_required rows this is not proof the application has reached the admin queue yet.'),
  decidedAt: timestampString.nullable(),
  activatedMembershipId: z.string().nullable(),
});
