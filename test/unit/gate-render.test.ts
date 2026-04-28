import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderArtifact, renderGateText } from '../../src/gate.ts';

const ALICE_ID = 'a7k9m2p4q8r3';
const BOB_ID = 'b8m2n4p6q9r5';

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

  it('renders canonical mention spans as plain labels for the gate', () => {
    assert.equal(
      renderArtifact({
        kind: 'content',
        contentKind: 'post',
        isReply: false,
        title: `Welcome [Alice Smith|${ALICE_ID}]`,
        summary: 'Coordinate with [unrelated] before posting.',
        body: `Thanks [Bob Builder|${BOB_ID}], welcome to the club.`,
      }),
      [
        'kind: content',
        'contentKind: post',
        'title: Welcome Alice Smith',
        'summary: Coordinate with [unrelated] before posting.',
        'body: Thanks Bob Builder, welcome to the club.',
      ].join('\n'),
    );
  });

  it('leaves malformed mention-like text unchanged in gate rendering', () => {
    assert.equal(
      renderGateText(`Bad [Name|, [|${ALICE_ID}], [Name|x], and good [Alice|${ALICE_ID}].`),
      `Bad [Name|, [|${ALICE_ID}], [Name|x], and good Alice.`,
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

  it('renders application artifacts as club and applicant blocks', () => {
    assert.equal(
      renderArtifact({
        kind: 'application',
        club: {
          name: 'Builders Circle',
          summary: 'A private club for builders and operators.',
          admissionPolicy: 'Tell us your city and what you build.',
        },
        applicant: {
          name: 'Taylor Builder',
          email: 'taylor.builder@example.com',
          socials: '@taylorbuilder',
          application: 'I live in London and I build workflow software.',
        },
      }),
      [
        'kind: application',
        'club:',
        '  name: Builders Circle',
        '  summary: A private club for builders and operators.',
        '  admissionPolicy: Tell us your city and what you build.',
        'applicant:',
        '  name: Taylor Builder',
        '  email: taylor.builder@example.com',
        '  socials: @taylorbuilder',
        '  application: I live in London and I build workflow software.',
      ].join('\n'),
    );
  });
});
