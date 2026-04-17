/**
 * Deterministic source-text builders for embedding generation.
 *
 * Each builder produces a stable, labeled, bounded string suitable for
 * embedding with a text embedding model. The output is persisted as
 * `source_text` on the artifact row for auditability.
 *
 * source_hash is stored alongside for provenance / future skip-on-match.
 */

import { createHash } from 'node:crypto';
import { CLAWCLUB_EMBEDDING_SOURCE_MAX_CHARS } from './ai.ts';

export function computeSourceHash(sourceText: string): string {
  return createHash('sha256').update(sourceText).digest('hex');
}

const SECTION_MAX = 2000;

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function addSection(parts: string[], label: string, value: string | null | undefined, max = SECTION_MAX): void {
  if (!value || value.trim().length === 0) return;
  parts.push(`${label}: ${truncate(value.trim(), max)}`);
}

function finalise(parts: string[]): string {
  const joined = parts.join('\n');
  return truncate(joined, CLAWCLUB_EMBEDDING_SOURCE_MAX_CHARS);
}

// ── Profile source ──────────────────────────────────────

export type ProfileSourceInput = {
  publicName: string;
  displayName: string | null;
  tagline: string | null;
  summary: string | null;
  whatIDo: string | null;
  knownFor: string | null;
  servicesSummary: string | null;
  websiteUrl: string | null;
  links: Array<{ url: string; label: string | null }> | null;
};

export function buildProfileSourceText(input: ProfileSourceInput): string {
  const parts: string[] = [];
  addSection(parts, 'Name', input.displayName ?? input.publicName);
  addSection(parts, 'Tagline', input.tagline);
  addSection(parts, 'Summary', input.summary);
  addSection(parts, 'What I do', input.whatIDo);
  addSection(parts, 'Known for', input.knownFor);
  addSection(parts, 'Services', input.servicesSummary);
  addSection(parts, 'Website', input.websiteUrl);
  if (input.links && input.links.length > 0) {
    const linksText = input.links
      .slice(0, 10)
      .map((link) => link.label ?? link.url)
      .filter(Boolean)
      .join(', ');
    addSection(parts, 'Links', linksText);
  }
  return finalise(parts);
}

// ── Content source ──────────────────────────────────────

export type ContentSourceInput = {
  kind: string;
  title: string | null;
  summary: string | null;
  body: string | null;
};

export function buildContentSourceText(input: ContentSourceInput): string {
  const parts: string[] = [];
  addSection(parts, 'Kind', input.kind);
  addSection(parts, 'Title', input.title);
  addSection(parts, 'Summary', input.summary);
  addSection(parts, 'Body', input.body);
  return finalise(parts);
}

// ── Event source ────────────────────────────────────────

export type EventSourceInput = {
  title: string | null;
  summary: string | null;
  body: string | null;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  timezone: string | null;
  recurrenceRule: string | null;
};

export function buildEventSourceText(input: EventSourceInput): string {
  const parts: string[] = [];
  parts.push('Kind: event');
  addSection(parts, 'Title', input.title);
  addSection(parts, 'Summary', input.summary);
  addSection(parts, 'Location', input.location);
  addSection(parts, 'Starts', input.startsAt);
  addSection(parts, 'Ends', input.endsAt);
  addSection(parts, 'Timezone', input.timezone);
  addSection(parts, 'Recurrence', input.recurrenceRule);
  addSection(parts, 'Body', input.body);
  return finalise(parts);
}
