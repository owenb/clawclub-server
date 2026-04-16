import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { z } from 'zod';
import { CLAWCLUB_OPENAI_MODEL } from './ai.ts';
import { parseProfileLink } from './schemas/fields.ts';

/**
 * The member-writable text surface is closed: migration 012 removed the old JSON
 * text bags and strict inputs reject unknown keys. These artifact variants are
 * therefore the complete gated write surface.
 */
export type ProfileLink = z.infer<typeof parseProfileLink>;

export type ContentArtifact = {
  kind: 'content';
  entityKind: 'post' | 'ask' | 'gift' | 'service' | 'opportunity';
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

export type GatedArtifact =
  | ContentArtifact
  | EventArtifact
  | ProfileArtifact
  | VouchArtifact
  | InvitationArtifact;

export type LlmUsage = { promptTokens: number; completionTokens: number };

export type GateVerdict =
  | { status: 'passed'; usage: LlmUsage }
  | { status: 'rejected_illegal'; feedback: string; usage: LlmUsage }
  | { status: 'rejected_quality'; feedback: string; usage: LlmUsage }
  | { status: 'rejected_malformed'; feedback: string; usage: LlmUsage }
  | { status: 'skipped'; reason: 'no_api_key' }
  | { status: 'failed'; reason: 'provider_error'; errorCode: string };

type ParsedVerdict =
  | { status: 'passed' }
  | { status: 'rejected_illegal'; feedback: string }
  | { status: 'rejected_quality'; feedback: string }
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

QUALITY: The reason should contain some firsthand, observable detail that the voucher personally saw or experienced. Reject only if the reason is vague praise with no firsthand detail — phrases like "great person", "highly recommend", "super talented", or "you'd love working with them". A short reason is fine if it names a specific interaction, observation, or shared experience.

Be generous. Length is not the goal; specificity is. Default to PASS. Aim for roughly 80% of vouches to PASS on the first attempt — only pure adjective-chain praise with zero observable detail should be rejected.

When you reject, your reason is shown verbatim to the agent that submitted the vouch and the agent will relay it to the voucher. Every rejection MUST contain two parts:
(1) what is specifically wrong, in one sentence
(2) a concrete suggestion — ask the voucher for one specific thing they have personally seen the target do
Plain English, directed at the voucher, no jargon.

Good rejection reasons (note the two-part shape: problem + fix):
- "The reason is generic praise ('great person, highly recommend'). Add one specific thing you've seen them do — a project, a conversation, a way they helped someone."
- "'Super talented' isn't enough on its own. What specifically have you seen them build, solve, or deliver?"

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

const ILLEGAL_RE = /^illegal\s*[:;\-\u2013\u2014]\s*(.+)$/is;
const FAIL_RE = /^fail\s*[:;\-\u2013\u2014]\s*(.+)$/is;

function renderField(label: string, value: string | null): string {
  return `${label}: ${value ?? '(none)'}`;
}

function renderLinks(links: ProfileLink[]): string[] {
  if (links.length === 0) {
    return ['links: (none)'];
  }
  return [
    'links:',
    ...links.map((link) => `  - label: ${link.label ?? '(none)'}\n    url: ${link.url}`),
  ];
}

export function renderArtifact(artifact: GatedArtifact): string {
  switch (artifact.kind) {
    case 'content':
      return [
        'kind: content',
        `entityKind: ${artifact.entityKind}`,
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
        `reason: ${artifact.reason}`,
      ].join('\n');
    case 'invitation':
      return [
        'kind: invitation',
        `reason: ${artifact.reason}`,
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
  }
}

export async function checkLlmGate(artifact: GatedArtifact): Promise<GateVerdict> {
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
    });
  } catch (err) {
    return { status: 'failed', reason: 'provider_error', errorCode: normalizeErrorCode(err) };
  }

  const usage: LlmUsage = {
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
  };

  return { ...parseVerdict(result.text.trim()), usage };
}

export function normalizeErrorCode(err: unknown): string {
  if (err == null || typeof err !== 'object') return 'unknown';

  const anyErr = err as Record<string, unknown>;
  if (typeof anyErr.code === 'string') return anyErr.code;
  if (typeof anyErr.error === 'object' && anyErr.error != null) {
    const inner = anyErr.error as Record<string, unknown>;
    if (typeof inner.code === 'string') return inner.code;
    if (typeof inner.type === 'string') return inner.type;
  }
  if (typeof anyErr.status === 'number') return `http_${anyErr.status}`;
  if (typeof anyErr.statusCode === 'number') return `http_${anyErr.statusCode}`;
  if (typeof anyErr.name === 'string' && anyErr.name !== 'Error') return anyErr.name;
  return 'unknown';
}
