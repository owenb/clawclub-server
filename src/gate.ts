import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { z } from 'zod';
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';
import { normalizeErrorCode } from './llm-errors.ts';
import { extractMentionCandidates } from './mentions.ts';
import { parseProfileLink } from './schemas/fields.ts';
import { outboundLlmSignal } from './workers/environment.ts';

/**
 * The member-writable text surface is closed: migration 012 removed the old JSON
 * text bags and strict inputs reject unknown keys. These artifact variants are
 * therefore the complete gated write surface.
 */
export type ProfileLink = z.infer<typeof parseProfileLink>;

export type ContentArtifact = {
  kind: 'content';
  contentKind: 'post' | 'ask' | 'gift' | 'service' | 'opportunity';
  isReply: boolean;
  title: string | null;
  summary: string | null;
  body: string | null;
};

export type EventArtifact = {
  kind: 'event';
  title: string | null;
  summary: string | null;
  body: string | null;
  location: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string | null;
};

export type ProfileArtifact = {
  kind: 'profile';
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: ProfileLink[];
};

export type VouchArtifact = {
  kind: 'vouch';
  reason: string;
};

export type InvitationArtifact = {
  kind: 'invitation';
  reason: string;
};

export type ClubArtifact = {
  kind: 'club';
  name: string;
  summary: string | null;
  admissionPolicy: string | null;
};

export type ApplicationArtifact = {
  kind: 'application';
  club: {
    name: string;
    summary: string | null;
    admissionPolicy: string;
  };
  applicant: {
    name: string;
    email: string;
    socials: string;
    application: string;
  };
};

export type NonApplicationArtifact =
  | ContentArtifact
  | EventArtifact
  | ProfileArtifact
  | VouchArtifact
  | InvitationArtifact
  | ClubArtifact;

export type GatedArtifact = NonApplicationArtifact | ApplicationArtifact;

export type LlmUsage = { promptTokens: number; completionTokens: number };

export type GateVerdict =
  | { status: 'passed'; usage: LlmUsage }
  | { status: 'rejected_illegal'; feedback: string; usage: LlmUsage }
  | { status: 'rejected_quality'; feedback: string; usage: LlmUsage }
  | { status: 'rejected_malformed'; rawText: string; usage: LlmUsage }
  | { status: 'skipped'; reason: 'no_api_key' }
  | { status: 'failed'; reason: 'provider_error'; errorCode: string };

export type ApplicationGateVerdict =
  | { status: 'passed'; usage: LlmUsage }
  | { status: 'needs_revision'; feedback: string; usage: LlmUsage }
  | { status: 'rejected_malformed'; rawText: string; usage: LlmUsage }
  | { status: 'skipped'; reason: 'no_api_key' }
  | { status: 'failed'; reason: 'provider_error'; errorCode: string };

type ParsedVerdict =
  | { status: 'passed' }
  | { status: 'rejected_illegal'; feedback: string }
  | { status: 'rejected_quality'; feedback: string }
  | { status: 'rejected_malformed'; feedback: string };

type ParsedApplicationVerdict =
  | { status: 'passed' }
  | { status: 'needs_revision'; feedback: string }
  | { status: 'rejected_malformed'; feedback: string };

const CONTENT_PROMPT = `You are a legality and quality check for text posts in a private members club thread. Reject for illegality or clear low-information slop; almost everything else passes.

LEGALITY: Reject if the post actively solicits or facilitates activity that is clearly illegal in most jurisdictions. Use your judgment — the rule is "clearly illegal," not a fixed list. Illustrative examples (not exhaustive): violence against a specific person, child sexual abuse material, fraud, forgery, drug trafficking, money laundering, cybercrime (phishing, hacking, spyware), stalking, human trafficking, illegal weapons sales. Apply the same standard to any other clearly-illegal activity you recognize. Do NOT reject for being offensive, profane, sexually explicit, politically extreme, or in poor taste. Discussion, opinion, satire, and first-person accounts of legal activity are fine.

QUALITY: Catch the clear 10% of posts that are genuinely low-information slop. Reject only if one of these is clearly true:
- The text is empty, one line of filler, or communicates nothing specific
- kind=post: no concrete point, update, or takeaway
- kind=opportunity: no indication of what is offered, who it is for, or how to engage
- kind=service: no indication of what is offered, who it is for, or how to engage
- kind=ask: no indication of what is actually needed
- kind=gift: lenient — any concrete sentence naming the free offer is enough
- A post that links somewhere else still passes if it adds even one or two concrete takeaways or reasons the link matters

Be generous. Short is fine if specific. Casual, technical, and opinionated are all fine. Default to PASS. Aim for roughly 80% of submissions to PASS on the first attempt — only the clear bottom slice should be rejected.

When you reject, your reason is shown verbatim to the agent that submitted the post and the agent will relay it to the poster. Every rejection MUST contain two parts:
(1) what is specifically wrong, in one sentence
(2) a concrete suggestion for how to fix it
Plain English, directed at the poster, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "The opportunity doesn't say what the role involves or how to apply — add a sentence about both."
- "This post has a title but no body. Add a few sentences explaining your point or takeaway."
- "The ask doesn't say what kind of help you need, so readers can't tell if they can help."

Bad rejection reasons (these are stock labels, not sentences, and never give the user something to act on):
- "low quality"
- "vague"
- "insufficient"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>
FAIL: <specific, actionable reason>`;

const REPLY_PROMPT = `You are a legality check for a reply inside a private members club thread.

LEGALITY: Reject only if the reply actively solicits or facilitates activity that is clearly illegal in most jurisdictions. Use your judgment — the rule is "clearly illegal," not a fixed list. Illustrative examples (not exhaustive): violence against a specific person, child sexual abuse material, fraud, forgery, drug trafficking, money laundering, cybercrime (phishing, hacking, spyware), stalking, human trafficking, illegal weapons sales. Apply the same standard to any other clearly-illegal activity you recognize. Do NOT reject for being offensive, profane, sexually explicit, politically extreme, or in poor taste.

Anything that is not clearly illegal passes. A reply is the member talking inside an ongoing conversation; there is no quality bar for replies. Bare acknowledgements like "yes", "no", "thanks", "agreed", "+1", "lol", "cool", "fair", "noted", and emoji-only replies all pass. Short, informal, off-topic, or low-information replies all pass. Do NOT reject for being brief, conversational, empty-feeling, or a simple acknowledgement. Default to PASS.

When you reject, your reason is shown verbatim to the agent that submitted the reply and the agent will relay it to the replier. Every rejection MUST contain two parts:
(1) what is specifically illegal, in one sentence
(2) a concrete suggestion for how to reframe it lawfully
Plain English, directed at the replier, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "This reply contains a specific violent threat against a named person — remove the threat and rewrite as a complaint or mediation request instead."
- "The reply is soliciting someone to phish a competitor account, which is cybercrime — remove the request and find a lawful way to compete."

Bad rejection reasons (these are stock labels, not sentences, and never give the user something to act on):
- "inappropriate"
- "too brief"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>`;

const EVENT_PROMPT = `You are a legality and sense-check for events in a private members club. Reject for illegality or fields that clearly do not make sense; almost everything else passes.

LEGALITY: Reject if the event is clearly organizing illegal activity. Use your judgment about what is illegal in most jurisdictions. Illustrative examples (not exhaustive): violence, trafficking, fraud, money laundering, stalking, illegal weapons deals. Apply the same standard to any other clearly-illegal activity you recognize. Do not reject for being edgy, political, or offbeat.

SENSE-CHECK: The schema already guarantees that title, location, and startsAt are present. You are not verifying completeness — you are checking that the fields make sense. Reject only if one of these is clearly true:
- The location is not recognizable as a real place or a known online platform. "Online", "Zoom", "Google Meet", "Teams", named venues, street addresses, and the exact placeholder "TBD — details to follow" are all fine when the rest of the event is concrete. If the location is exactly "TBD — details to follow", that alone is NOT a reason to reject. Only reject clearly vague placeholders like "somewhere" or "a place".
- The start time is clearly nonsensical (in the distant past, or implausibly placed)
- An end time is given but is before the start time
- The duration is implausibly short or implausibly long for the kind of event described. A one-day "coffee meetup" or similar short gathering should fail.
- A timezone is missing AND the event is clearly in-person at a physical location (online events without a timezone are fine). Treat this as a real failure even if startsAt includes a UTC offset, because members still need the local timezone context.
- The summary is so generic that it would not help a member decide whether to attend

Do NOT reject for a missing body — body is optional extended detail.
Do NOT reject for a missing end time — some events genuinely do not have one. Drop-in, coworking, or "leave whenever you need to" formats without an end time should normally PASS.
Do NOT treat an ISO timestamp in UTC (for example ending in "Z") plus an explicit timezone like "Europe/London" as a conflict. That combination is normal.

PASS examples:
- location="Online", timezone missing, otherwise concrete
- location="TBD — details to follow", concrete summary, concrete date/time
- in-person drop-in or coworking event with no end time

FAIL examples:
- physical venue or address, timezone missing
- short meetup/coffee event with a one-day duration

Be generous. Default to PASS. Aim for roughly 80% of events to PASS on the first attempt — only clearly broken events should be rejected.

When you reject, your reason is shown verbatim to the agent that submitted the event and the agent will relay it to the organizer. Every rejection MUST contain two parts:
(1) what is specifically wrong, in one sentence
(2) a concrete suggestion for how to fix it
Plain English, directed at the organizer, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "The location is 'somewhere in London' — add a venue name or address so people know where to show up."
- "The end time (2pm) is before the start time (6pm). Check the times."
- "The summary doesn't say what will happen or who it's for — add a sentence or two so people can decide whether to attend."

Bad rejection reasons (these are stock labels, not sentences, and never give the user something to act on):
- "vague location"
- "missing detail"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>
FAIL: <specific, actionable reason>`;

const PROFILE_PROMPT = `You are a legality and quality check for a member's club-scoped profile. Fields are free-text biography — tagline, summary, whatIDo, knownFor, servicesSummary — plus a websiteUrl and a list of labeled links. Any free-text field may be null; links may be an empty array.

LEGALITY: Reject if the profile advertises, solicits, or signals availability for clearly illegal services or activity. Use your judgment about what is illegal in most jurisdictions. Illustrative examples (not exhaustive): forgery services, trafficking, violence for hire, cybercrime (phishing, hacking, spyware, stalkerware), money laundering, illegal weapons sales. A suspicious website URL or a link label that clearly points at illegal services counts too. Apply the same standard to any other clearly-illegal activity you recognize. Do not reject for being edgy, political, or unconventional.

QUALITY: Reject only if every non-null free-text field is generic filler with no substance — phrases like "experienced professional", "passionate about excellence", "I love to help people", or "driven and results-oriented". Do NOT require multiple populated fields. One concrete free-text field is enough to pass. A concrete tagline+summary pair is enough to pass. A concrete website or clearly descriptive link labels (for example "Portfolio", "Postgres migration case study", or "Warehouse analytics work") are enough to pass even if the prose is sparse or generic. If a profile has generic prose but adds concrete website/link context, PASS rather than forcing the prose to be rewritten in the same update. Consider tagline, summary, whatIDo, knownFor, servicesSummary, websiteUrl, and the labels on links. A bare website URL with no context is fine; an empty profile is fine (null fields, empty links array).

PASS examples:
- one concrete whatIDo field and everything else empty
- tagline+summary that clearly name a role/domain
- generic tagline/summary but concrete website/link context added in this update; do not force the user to rewrite the generic prose in the same patch

Be generous. Short is fine if specific. Default to PASS. Aim for roughly 80% of profile updates to PASS on the first attempt — only clearly empty or pure-filler profiles should be rejected.

When you reject, your reason is shown verbatim to the agent that submitted the update and the agent will relay it to the profile owner. Every rejection MUST contain two parts:
(1) what is specifically wrong (name the field(s) that read as filler), in one sentence
(2) a concrete suggestion for the kind of detail that would make it work
Plain English, directed at the profile owner, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "The tagline and summary are both generic ('experienced professional', 'passionate about excellence'). Add something concrete — your actual role, your domain, or a specific thing you're known for."
- "The whatIDo field is the only one set and it just says 'I help people solve problems'. Replace it with the kind of problems or the kind of people."

Bad rejection reasons (these are stock labels, not sentences, and never give the user something to act on):
- "generic"
- "too vague"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>
FAIL: <specific, actionable reason>`;

const VOUCH_PROMPT = `You are a legality and quality check for a vouch — one member endorsing another inside a private club.

LEGALITY: Reject if the reason praises or endorses the target's participation in clearly illegal activity. Use your judgment about what is illegal in most jurisdictions. Illustrative examples (not exhaustive): fraud ("helped me launder money"), forgery ("got me a fake passport"), drug trafficking, cybercrime ("phished a competitor for me"), violence, stalking. Apply the same standard to any other clearly-illegal activity you recognize. Do not reject for describing legal edgy work or political views.

QUALITY: The bar is low. A vouch passes as long as there is at least one concrete hook beyond pure adjectives — any of these counts and ONE is enough:
- a domain, field, or craft the target works in (e.g. "postgres engineer", "industrial designer", "fintech product")
- a named tool, platform, product, or company they built, use, or introduced you to
- a project, event, or shared situation you were in together
- a trait shown in a specific context (e.g. "spots new tools early", "keeps meetings focused")
- a small anecdote or moment — even one clause is enough

Abstract praise alongside a concrete hook is FINE — you do not need to strip the praise. The hook can be a single phrase inside an otherwise praise-heavy sentence. Length is not the goal.

Reject ONLY when the reason is pure praise with zero concrete hook at all, or is pure hearsay ("I've heard good things") with no firsthand context. Being brief, informal, or mostly complimentary is not grounds to reject if there is any concrete hook.

PASS examples (all of these pass — do NOT ask for more detail):
- "Cici is a great designer. I saw him produce a printed book for Gitcoin that was unusually thoughtful and well-crafted."
- "Very AI forward — often tells me about new tools and platforms I don't know about."
- "He told me about Paperclip before I'd heard of it. Has a good eye for what matters."
- "Brilliant postgres engineer, worked with him on a migration last year."
- "Sharp product thinker in the fintech space, wholeheartedly recommend."
- "I saw her run incident response during an outage — calm and clear."

FAIL examples (pure praise with no hook, or pure hearsay):
- "Excellent person, very reliable."
- "Brilliant, thoughtful, strategic, hardworking, impressive."
- "I have heard many good things about her and think she would be great."
- "You'd love working with them."

Default hard to PASS. If there is ANY concrete hook — a domain name, a tool name, a project, a place, a moment, a trait-in-context — PASS. Aim for roughly 90% of vouches to PASS on the first attempt.

When you reject, your reason is shown verbatim to the agent that submitted the vouch and the agent will relay it to the voucher. Every rejection MUST contain two parts:
(1) what is specifically wrong, in one sentence
(2) a concrete suggestion — ask the voucher to name one concrete thing: a domain the target works in, a tool they use, a project they did, or a moment the voucher saw
Plain English, directed at the voucher, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "The reason is pure adjectives ('great person, highly recommend') with no concrete hook. Name one thing — a domain they work in, a tool they know, a project, or a moment you saw."
- "'Super talented' on its own isn't enough. Add one specific anchor — a field, a product they built, or a small thing you've seen them do."

Bad rejection reasons (these are stock labels, not sentences, and never give the user something to act on):
- "vague"
- "not specific"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>
FAIL: <specific, actionable reason>`;

const INVITATION_PROMPT = `You are a legality and quality check for an invitation reason — a sponsor vouching for a candidate who will apply to join a private club. The reason is persisted as the sponsor's on-the-record justification and is read by whoever reviews the resulting application.

LEGALITY: Reject if the reason endorses the candidate's participation in clearly illegal activity. Use your judgment about what is illegal in most jurisdictions. Illustrative examples (not exhaustive): fraud, forgery, trafficking, cybercrime, violence, money laundering, stalking. Apply the same standard to any other clearly-illegal activity you recognize. Do not reject for describing legal edgy work, political views, or unconventional backgrounds.

QUALITY: Reject only if the reason is a generic endorsement with no specifics — phrases like "amazing person", "would be a great addition", or "I know they will love it here". A short reason is fine if it explains how the sponsor knows the candidate, what they have directly seen, or why this specific club is a fit.

Be generous. Length is not the goal; specificity is. Default to PASS. Aim for roughly 80% of invitations to PASS on the first attempt — only pure generic endorsement with zero relationship context should be rejected.

When you reject, your reason is shown verbatim to the agent that submitted the invitation and the agent will relay it to the sponsor. Every rejection MUST contain two parts:
(1) what is specifically wrong, in one sentence
(2) a concrete suggestion — ask the sponsor to say how they know the candidate or what they have personally seen
Plain English, directed at the sponsor, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "The reason is generic ('amazing person, would be a great addition'). Say how you know this candidate — how long, in what context — and one concrete thing you've seen them do."
- "Tell the reviewer why this candidate fits THIS club specifically. Right now the reason could apply to anyone."

Bad rejection reasons (these are stock labels, not sentences, and never give the user something to act on):
- "vague"
- "too generic"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>
FAIL: <specific, actionable reason>`;

const CLUB_PROMPT = `You are a legality and quality check for a private club's public-facing text: its name, summary, and admission policy.

LEGALITY: Reject if the club text clearly solicits, organizes, or normalizes clearly illegal activity in most jurisdictions. Use your judgment — the rule is "clearly illegal," not a fixed list. Illustrative examples (not exhaustive): violence against a specific person, fraud, forgery, drug trafficking, cybercrime (phishing, hacking, spyware), stalking, human trafficking, illegal weapons sales. Apply the same standard to any other clearly-illegal activity you recognize. Do NOT reject for being edgy, profane, politically extreme, or in poor taste if the club is still lawful.

QUALITY: Reject if the text is clearly operator-hostile, clearly hateful slop, or too empty to describe a real club. The bar is still generous, but clubs are durable branded surfaces and should be held to a slightly stricter standard than a normal post.

ADMISSION POLICY: When an admissionPolicy is present, it MUST contain at least one concrete question or condition that an applicant can actually respond to or meet — e.g. an explicit question like "What is your background in X?" or "Describe a recent project you shipped in Y", or an explicit eligibility condition like "Members must have N years of experience in Z" or "Must be employed in industry Q". Reject with FAIL if the admissionPolicy is vague encouragement or aesthetic preference that asks nothing concrete of the applicant (e.g. "just be cool", "no drama", "good vibes only", "be awesome"), or if it only describes what the club is rather than what the applicant should provide or meet. A missing admissionPolicy (value "(none)") is fine — only judge it when it is present.

Be generous, but stricter than content.create. Default to PASS unless one of these is clearly true:
- the club name or summary clearly promotes illegal activity
- the text is mostly meaningless filler with no concrete sense of what the club is
- the text is clearly abusive, hateful, or hostile in a way that would make the operator not want it on the platform
- the admissionPolicy is present but has no concrete question or condition the applicant can answer or meet

When you reject, your reason is shown verbatim to the agent that submitted the club text and the agent will relay it to the organizer. Every rejection MUST contain two parts:
(1) what is specifically wrong, naming the offending field where possible (name, summary, or admissionPolicy), in one sentence
(2) a concrete suggestion for how to fix it
Plain English, directed at the organizer, no jargon.

Good rejection reasons:
- "The name suggests a fraud ring, which is clearly illegal — rename the club around a lawful activity instead."
- "The summary is too generic to explain what this club is for. Add one or two concrete sentences about the members or purpose."
- "The admission policy tells applicants to share stolen credentials. Remove that and rewrite it around lawful membership criteria."
- "The admission policy does not ask the applicant anything concrete. Add at least one explicit question (e.g. about background, recent work, or eligibility) applicants must answer."

Bad rejection reasons:
- "bad"
- "inappropriate"
- "too vague"

Respond with exactly one of:
PASS
ILLEGAL: <specific, actionable reason>
FAIL: <specific, actionable reason>`;

const APPLICATION_PROMPT = `You are a completeness check for a private club admission application. Your ONLY job is to verify the applicant has answered every explicit question in the club's admission policy. You do NOT judge quality, fit, sincerity, or tone — the club owner does that after you pass or fail.

The user message contains two blocks: a "club" block with the club's name, summary, and admission policy, and an "applicant" block with the applicant's submission fields.

If the applicant answered every piece of information the admission policy explicitly requests, respond with exactly: PASS.

If any explicitly requested piece of information is missing, list what is missing. Do not reject for vagueness, brevity, or quality — only for absence.`;

const ILLEGAL_RE = /^illegal\s*[:;\-\u2013\u2014]\s*(.+)$/is;
const FAIL_RE = /^fail\s*[:;\-\u2013\u2014]\s*(.+)$/is;

export function renderGateText(value: string): string {
  const mentions = extractMentionCandidates(value);
  if (mentions.length === 0) return value;

  let rendered = '';
  let cursor = 0;
  for (const mention of mentions) {
    rendered += value.slice(cursor, mention.start);
    rendered += mention.authoredLabel;
    cursor = mention.end;
  }
  rendered += value.slice(cursor);
  return rendered;
}

function renderField(label: string, value: string | null): string {
  return `${label}: ${value === null ? '(none)' : renderGateText(value)}`;
}

function renderLinks(links: ProfileLink[]): string[] {
  if (links.length === 0) {
    return ['links: (none)'];
  }
  return [
    'links:',
    ...links.map((link) => `  - label: ${link.label === null ? '(none)' : renderGateText(link.label)}\n    url: ${renderGateText(link.url)}`),
  ];
}

export function renderArtifact(artifact: GatedArtifact): string {
  switch (artifact.kind) {
    case 'content':
      return [
        'kind: content',
        `contentKind: ${artifact.contentKind}`,
        renderField('title', artifact.title),
        renderField('summary', artifact.summary),
        renderField('body', artifact.body),
      ].join('\n');
    case 'event':
      return [
        'kind: event',
        renderField('title', artifact.title),
        renderField('summary', artifact.summary),
        renderField('body', artifact.body),
        `location: ${artifact.location}`,
        `startsAt: ${artifact.startsAt}`,
        renderField('endsAt', artifact.endsAt),
        renderField('timezone', artifact.timezone),
      ].join('\n');
    case 'profile':
      return [
        'kind: profile',
        renderField('tagline', artifact.tagline),
        renderField('summary', artifact.summary),
        renderField('whatIDo', artifact.whatIDo),
        renderField('knownFor', artifact.knownFor),
        renderField('servicesSummary', artifact.servicesSummary),
        renderField('websiteUrl', artifact.websiteUrl),
        ...renderLinks(artifact.links),
      ].join('\n');
    case 'vouch':
      return [
        'kind: vouch',
        `reason: ${renderGateText(artifact.reason)}`,
      ].join('\n');
    case 'invitation':
      return [
        'kind: invitation',
        `reason: ${renderGateText(artifact.reason)}`,
      ].join('\n');
    case 'club':
      return [
        'kind: club',
        renderField('name', artifact.name),
        renderField('summary', artifact.summary),
        renderField('admissionPolicy', artifact.admissionPolicy),
      ].join('\n');
    case 'application':
      return [
        'kind: application',
        'club:',
        renderField('  name', artifact.club.name),
        renderField('  summary', artifact.club.summary),
        renderField('  admissionPolicy', artifact.club.admissionPolicy),
        'applicant:',
        renderField('  name', artifact.applicant.name),
        renderField('  email', artifact.applicant.email),
        renderField('  socials', artifact.applicant.socials),
        renderField('  application', artifact.applicant.application),
      ].join('\n');
  }
}

export function parseVerdict(text: string): ParsedVerdict {
  const normalized = text.trim();

  if (normalized.toUpperCase() === 'PASS') {
    return { status: 'passed' };
  }

  const illegalMatch = normalized.match(ILLEGAL_RE);
  if (illegalMatch) {
    const feedback = (illegalMatch[1] ?? '').trim();
    if (feedback.length === 0) {
      return { status: 'rejected_malformed', feedback: normalized };
    }
    return { status: 'rejected_illegal', feedback };
  }

  const failMatch = normalized.match(FAIL_RE);
  if (failMatch) {
    const feedback = (failMatch[1] ?? '').trim();
    if (feedback.length === 0) {
      return { status: 'rejected_malformed', feedback: normalized };
    }
    return { status: 'rejected_quality', feedback };
  }

  return { status: 'rejected_malformed', feedback: normalized };
}

export function parseApplicationVerdict(text: string): ParsedApplicationVerdict {
  const normalized = text.trim();
  if (normalized.toUpperCase() === 'PASS') {
    return { status: 'passed' };
  }
  if (normalized.length === 0) {
    return { status: 'rejected_malformed', feedback: normalized };
  }
  if (/^(pass|illegal|fail)\b/i.test(normalized)) {
    return { status: 'rejected_malformed', feedback: normalized };
  }
  return { status: 'needs_revision', feedback: normalized };
}

export function pickPrompt(artifact: GatedArtifact): string {
  switch (artifact.kind) {
    case 'content':
      return artifact.isReply ? REPLY_PROMPT : CONTENT_PROMPT;
    case 'event':
      return EVENT_PROMPT;
    case 'profile':
      return PROFILE_PROMPT;
    case 'vouch':
      return VOUCH_PROMPT;
    case 'invitation':
      return INVITATION_PROMPT;
    case 'club':
      return CLUB_PROMPT;
    case 'application':
      return APPLICATION_PROMPT;
  }
}

function mapParsedVerdict(input: ParsedVerdict, usage: LlmUsage): GateVerdict {
  switch (input.status) {
    case 'passed':
      return { status: 'passed', usage };
    case 'rejected_illegal':
      return { status: 'rejected_illegal', feedback: input.feedback, usage };
    case 'rejected_quality':
      return { status: 'rejected_quality', feedback: input.feedback, usage };
    case 'rejected_malformed':
      return { status: 'rejected_malformed', rawText: input.feedback, usage };
  }
}

function mapParsedApplicationVerdict(
  input: ParsedApplicationVerdict,
  usage: LlmUsage,
): ApplicationGateVerdict {
  switch (input.status) {
    case 'passed':
      return { status: 'passed', usage };
    case 'needs_revision':
      return { status: 'needs_revision', feedback: input.feedback, usage };
    case 'rejected_malformed':
      return { status: 'rejected_malformed', rawText: input.feedback, usage };
  }
}

export function isApplicationArtifact(artifact: GatedArtifact): artifact is ApplicationArtifact {
  return artifact.kind === 'application';
}

export async function checkLlmGate(
  artifact: ApplicationArtifact,
  options?: { maxOutputTokens?: number },
): Promise<ApplicationGateVerdict>;
export async function checkLlmGate(
  artifact: NonApplicationArtifact,
  options?: { maxOutputTokens?: number },
): Promise<GateVerdict>;
export async function checkLlmGate(
  artifact: GatedArtifact,
  options: { maxOutputTokens?: number } = {},
): Promise<GateVerdict | ApplicationGateVerdict> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { status: 'skipped', reason: 'no_api_key' };
  }

  const system = pickPrompt(artifact);
  const user = renderArtifact(artifact);

  let result;
  try {
    result = await generateText({
      model: createOpenAI({ apiKey })(CLAWCLUB_OPENAI_MODEL),
      system,
      messages: [{ role: 'user', content: user }],
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: outboundLlmSignal(),
    });
  } catch (err) {
    return { status: 'failed', reason: 'provider_error', errorCode: normalizeErrorCode(err) };
  }

  const usage: LlmUsage = {
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
  };

  if (isApplicationArtifact(artifact)) {
    return mapParsedApplicationVerdict(parseApplicationVerdict(result.text), usage);
  }

  return mapParsedVerdict(parseVerdict(result.text), usage);
}
