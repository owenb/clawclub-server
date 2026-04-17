import type { OnboardingWelcome } from '../contract.ts';

// TODO OWEN: refine the default welcome tone before pushing this workstream.
export function buildOnboardingWelcome(input: {
  clubName: string;
  memberName: string;
  sponsorPublicName?: string | null;
}): OnboardingWelcome {
  const sponsorLine = input.sponsorPublicName
    ? ` ${input.sponsorPublicName} helped bring you in.`
    : '';

  return {
    greeting: `Welcome to ${input.clubName}, ${input.memberName}.`,
    preamble: `You've been accepted as a member of ${input.clubName}.${sponsorLine}`,
    capabilities: [
      `Ask me to show you who else is in ${input.clubName}.`,
      'Ask me to summarize recent activity, posts, events, and asks.',
      'Ask me to introduce you to someone specific.',
      'Ask me to write an intro post to the club or send a DM to another member.',
      'Ask me to list upcoming events.',
    ],
    closing: 'Take a look around, and tell me when you want me to help draft your first post.',
  };
}

// TODO OWEN: refine the lightweight second-club welcome before pushing this workstream.
export function buildSecondClubWelcome(input: {
  clubName: string;
  memberName: string;
  sponsorPublicName?: string | null;
}): OnboardingWelcome {
  const sponsorLine = input.sponsorPublicName
    ? ` ${input.sponsorPublicName} sponsored your admission here.`
    : '';

  return {
    greeting: `You're now active in ${input.clubName}, ${input.memberName}.`,
    preamble: `This club is now available to you.${sponsorLine}`,
    capabilities: [
      `Ask me to show you who is in ${input.clubName}.`,
      'Ask me to summarize what is happening there right now.',
      'Ask me to draft a post or welcome DM.',
    ],
    closing: 'When you are ready, I can help you introduce yourself in this club too.',
  };
}

export function buildSponsorHeadsUp(input: {
  newMemberPublicName: string;
  clubName: string;
}): string {
  return `${input.newMemberPublicName} was just approved into ${input.clubName}. If you want, I can help you send them a welcome DM now.`;
}

export function buildVouchReceivedMessage(input: {
  voucherPublicName: string;
  clubName: string;
  clubId: string;
  vouchedMemberId: string;
  reason: string;
}): string {
  return `${input.voucherPublicName} vouched for you in ${input.clubName}. `
    + `You can call vouches.list(clubId: '${input.clubId}') to see all the vouches `
    + `you have received in this club, or members.get(clubId: '${input.clubId}', `
    + `memberId: '${input.vouchedMemberId}') to see your full member profile there. `
    + `Reason: ${input.reason}`;
}
