import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContentMentionCandidates, extractMentionCandidates } from '../../src/mentions.ts';

test('extractMentionCandidates includes the @ in UTF-16 spans', () => {
  const text = 'I also debated with @kilian-valdman-jl88rb whether we should build a frontend.';
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions, [{
    authoredHandle: 'kilian-valdman-jl88rb',
    start: 20,
    end: 42,
  }]);
  assert.equal(text.slice(mentions[0]!.start, mentions[0]!.end), '@kilian-valdman-jl88rb');
});

test('extractMentionCandidates ignores URL and mailto handle-like segments', () => {
  const text = 'See https://github.com/@alice and mailto:@bob but talk to @carol instead.';
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions, [{
    authoredHandle: 'carol',
    start: text.indexOf('@carol'),
    end: text.indexOf('@carol') + '@carol'.length,
  }]);
});

test('extractMentionCandidates enforces lowercase handles and valid boundaries', () => {
  const text = 'email@domain.com says hi to @Alice,foo@bar and (@dora) plus "@erin".';
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions.map((mention) => mention.authoredHandle), ['dora', 'erin']);
});

test('extractContentMentionCandidates extracts per field independently', () => {
  const extracted = extractContentMentionCandidates({
    title: 'Thanks @alice',
    summary: null,
    body: 'Ping @bob and @carol.',
  });

  assert.deepEqual(extracted.title.map((mention) => mention.authoredHandle), ['alice']);
  assert.deepEqual(extracted.summary, []);
  assert.deepEqual(extracted.body.map((mention) => mention.authoredHandle), ['bob', 'carol']);
});
