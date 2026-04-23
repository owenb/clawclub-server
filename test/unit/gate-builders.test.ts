import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Repository } from '../../src/repository.ts';
import { AppError } from '../../src/repository.ts';
import { getAction } from '../../src/schemas/registry.ts';
import { makeActor, makeRepository } from './fixtures.ts';
import '../../src/dispatch.ts';

const actor = makeActor();

function makeGateContext(repository: Partial<Repository> = {}) {
  return {
    actor,
    repository: makeRepository(repository),
  };
}

describe('gate builders', () => {
  before(() => {
    assert.ok(getAction('content.create')?.llmGate);
    assert.ok(getAction('content.update')?.llmGate);
    assert.ok(getAction('members.updateProfile')?.llmGate);
    assert.ok(getAction('vouches.create')?.llmGate);
    assert.ok(getAction('invitations.issue')?.llmGate);
  });

  it('builds a top-level content artifact for content.create', async () => {
    const action = getAction('content.create')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      kind: 'post',
      title: 'Test',
      summary: null,
      body: 'Body',
      expiresAt: null,
      clientKey: null,
      event: undefined,
    }, makeGateContext());
    assert.deepEqual(artifact, {
      kind: 'content',
      contentKind: 'post',
      isReply: false,
      title: 'Test',
      summary: null,
      body: 'Body',
    });
  });

  it('builds a reply artifact for content.create when threadId is present', async () => {
    const action = getAction('content.create')!;
    const artifact = await action.llmGate!.buildArtifact({
      threadId: 'thread-1',
      kind: 'ask',
      title: null,
      summary: null,
      body: 'Can introduce you.',
      expiresAt: null,
      clientKey: null,
      event: undefined,
    }, makeGateContext());
    assert.equal(artifact.kind, 'content');
    assert.equal(artifact.isReply, true);
  });

  it('resolves the reply club budget scope for content.create from the thread id', async () => {
    const action = getAction('content.create')!;
    const clubId = await action.llmGate!.resolveBudgetClubId!({
      threadId: 'thread-1',
      kind: 'ask',
      title: null,
      summary: null,
      body: 'Can introduce you.',
      expiresAt: null,
      clientKey: null,
      event: undefined,
    }, makeGateContext({
      resolveContentThreadClubIdForGate: async () => 'club-1',
    }));
    assert.equal(clubId, 'club-1');
  });

  it('builds an event artifact for content.create(kind=event)', async () => {
    const action = getAction('content.create')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      kind: 'event',
      title: 'Breakfast',
      summary: 'Founders breakfast',
      body: null,
      expiresAt: null,
      clientKey: null,
      event: {
        location: 'Online',
        startsAt: '2026-05-15T08:30:00Z',
        endsAt: null,
        timezone: null,
        recurrenceRule: null,
        capacity: null,
      },
    }, makeGateContext());
    assert.deepEqual(artifact, {
      kind: 'event',
      title: 'Breakfast',
      summary: 'Founders breakfast',
      body: null,
      location: 'Online',
      startsAt: '2026-05-15T08:30:00Z',
      endsAt: null,
      timezone: null,
    });
  });

  it('merges a top-level content update and preserves isReply false', async () => {
    const action = getAction('content.update')!;
    const artifact = await action.llmGate!.buildArtifact({
      id: 'content-1',
      title: undefined,
      summary: 'Updated summary',
      body: undefined,
      expiresAt: undefined,
      event: undefined,
    }, makeGateContext({
      loadContentForGate: async () => ({
        contentKind: 'post',
        isReply: false,
        title: 'Original title',
        summary: null,
        body: 'Original body',
        event: null,
      }),
    }));
    assert.deepEqual(artifact, {
      kind: 'content',
      contentKind: 'post',
      isReply: false,
      title: 'Original title',
      summary: 'Updated summary',
      body: 'Original body',
    });
  });

  it('merges an existing reply update and preserves isReply true', async () => {
    const action = getAction('content.update')!;
    const artifact = await action.llmGate!.buildArtifact({
      id: 'content-1',
      title: undefined,
      summary: undefined,
      body: 'Still happy to help.',
      expiresAt: undefined,
      event: undefined,
    }, makeGateContext({
      loadContentForGate: async () => ({
        contentKind: 'ask',
        isReply: true,
        title: null,
        summary: null,
        body: 'Happy to help.',
        event: null,
      }),
    }));
    assert.equal(artifact.kind, 'content');
    assert.equal(artifact.isReply, true);
    assert.equal(artifact.body, 'Still happy to help.');
  });

  it('merges an event update into an event artifact', async () => {
    const action = getAction('content.update')!;
    const artifact = await action.llmGate!.buildArtifact({
      id: 'content-1',
      title: 'Updated breakfast',
      summary: undefined,
      body: undefined,
      expiresAt: undefined,
      event: {
        location: 'Zoom',
        startsAt: undefined,
        endsAt: undefined,
        timezone: 'Europe/London',
      },
    }, makeGateContext({
      loadContentForGate: async () => ({
        contentKind: 'event',
        isReply: false,
        title: 'Breakfast',
        summary: 'Founders breakfast',
        body: null,
        event: {
          location: 'Online',
          startsAt: '2026-05-15T08:30:00Z',
          endsAt: null,
          timezone: null,
        },
      }),
    }));
    assert.deepEqual(artifact, {
      kind: 'event',
      title: 'Updated breakfast',
      summary: 'Founders breakfast',
      body: null,
      location: 'Zoom',
      startsAt: '2026-05-15T08:30:00Z',
      endsAt: null,
      timezone: 'Europe/London',
    });
  });

  it('throws 404 on missing content.update content', async () => {
    const action = getAction('content.update')!;
    await assert.rejects(
      () => action.llmGate!.buildArtifact({
        id: 'missing',
      }, makeGateContext()),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });

  it('resolves the update club budget scope for content.update from the content id', async () => {
    const action = getAction('content.update')!;
    const clubId = await action.llmGate!.resolveBudgetClubId!({
      id: 'content-1',
      body: 'Updated body',
    }, makeGateContext({
      resolveContentClubIdForGate: async () => 'club-2',
    }));
    assert.equal(clubId, 'club-2');
  });

  it('merges a full profile update artifact including websiteUrl and links', async () => {
    const action = getAction('members.updateProfile')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      tagline: 'Operator',
      summary: 'Seed-stage fintech operator',
      whatIDo: 'Fractional COO',
      knownFor: 'Untangling messy launches',
      servicesSummary: 'Operating support for small teams',
      websiteUrl: 'https://example.com',
      links: [{ url: 'https://linkedin.com/in/example', label: 'LinkedIn' }],
    }, makeGateContext({
      loadProfileForGate: async () => ({
        tagline: null,
        summary: null,
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      }),
    }));
    assert.equal(artifact.kind, 'profile');
    assert.equal(artifact.websiteUrl, 'https://example.com');
    assert.deepEqual(artifact.links, [{ url: 'https://linkedin.com/in/example', label: 'LinkedIn' }]);
  });

  it('merges profile update that only changes websiteUrl', async () => {
    const action = getAction('members.updateProfile')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      websiteUrl: 'https://example.com/new',
    }, makeGateContext({
      loadProfileForGate: async () => ({
        tagline: 'Operator',
        summary: 'Summary',
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: 'https://example.com/old',
        links: [],
      }),
    }));
    assert.equal(artifact.kind, 'profile');
    assert.equal(artifact.tagline, 'Operator');
    assert.equal(artifact.websiteUrl, 'https://example.com/new');
  });

  it('merges profile update that only changes links', async () => {
    const action = getAction('members.updateProfile')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      links: [{ url: 'https://example.com/work', label: 'Portfolio' }],
    }, makeGateContext({
      loadProfileForGate: async () => ({
        tagline: null,
        summary: 'Summary',
        whatIDo: null,
        knownFor: null,
        servicesSummary: null,
        websiteUrl: null,
        links: [],
      }),
    }));
    assert.equal(artifact.kind, 'profile');
    assert.deepEqual(artifact.links, [{ url: 'https://example.com/work', label: 'Portfolio' }]);
    assert.equal(artifact.summary, 'Summary');
  });

  it('throws 404 on missing members.updateProfile profile', async () => {
    const action = getAction('members.updateProfile')!;
    await assert.rejects(
      () => action.llmGate!.buildArtifact({ clubId: 'club-1', tagline: 'Test' }, makeGateContext()),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });

  it('builds a vouch artifact', async () => {
    const action = getAction('vouches.create')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      memberId: 'member-2',
      reason: 'Saw them fix the migration under pressure.',
    }, makeGateContext());
    assert.deepEqual(artifact, { kind: 'vouch', reason: 'Saw them fix the migration under pressure.' });
  });

  it('builds an invitation artifact', async () => {
    const action = getAction('invitations.issue')!;
    const artifact = await action.llmGate!.buildArtifact({
      clubId: 'club-1',
      candidateName: 'Candidate',
      candidateEmail: 'candidate@example.com',
      reason: 'I have worked with her for two years and she is a strong fit for this club.',
    }, makeGateContext());
    assert.deepEqual(artifact, {
      kind: 'invitation',
      reason: 'I have worked with her for two years and she is a strong fit for this club.',
    });
  });
});
