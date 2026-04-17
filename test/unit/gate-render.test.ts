import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifact } from '../../src/gate.ts';

describe('renderArtifact', () => {
  it('renders content artifacts as labeled blocks', () => {
    assert.equal(
      renderArtifact({
        kind: 'content',
        contentKind: 'opportunity',
        isReply: false,
        title: 'Need a part-time operator',
        summary: null,
        body: 'Three days a week, remote-friendly.',
      }),
      [
        'kind: content',
        'contentKind: opportunity',
        'title: Need a part-time operator',
        'summary: (none)',
        'body: Three days a week, remote-friendly.',
      ].join('\n'),
    );
  });

  it('renders events with the required event fields', () => {
    assert.equal(
      renderArtifact({
        kind: 'event',
        title: 'Breakfast',
        summary: null,
        body: null,
        location: 'Online',
        startsAt: '2026-05-15T08:30:00Z',
        endsAt: null,
        timezone: null,
      }),
      [
        'kind: event',
        'title: Breakfast',
        'summary: (none)',
        'body: (none)',
        'location: Online',
        'startsAt: 2026-05-15T08:30:00Z',
        'endsAt: (none)',
        'timezone: (none)',
      ].join('\n'),
    );
  });

  it('renders empty profile links as none and non-empty links as a labeled block', () => {
    assert.equal(
      renderArtifact({
        kind: 'profile',
        tagline: null,
        summary: 'Operator for seed-stage fintech',
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: 'https://example.com',
        links: [
          { url: 'https://linkedin.com/in/example', label: 'LinkedIn' },
          { url: 'https://example.com/work', label: null },
        ],
      }),
      [
        'kind: profile',
        'tagline: (none)',
        'summary: Operator for seed-stage fintech',
        'whatIDo: (none)',
        'knownFor: (none)',
        'servicesSummary: (none)',
        'websiteUrl: https://example.com',
        'links:',
        '  - label: LinkedIn\n    url: https://linkedin.com/in/example',
        '  - label: (none)\n    url: https://example.com/work',
      ].join('\n'),
    );
  });
});
