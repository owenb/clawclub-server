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

test('extractMentionCandidates uses UTF-16 offsets for non-ASCII text', () => {
  const text = 'he\u0301llo \u{1F44B} @alice';
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions, [{
    authoredHandle: 'alice',
    start: 10,
    end: 16,
  }]);
  assert.equal(text.slice(mentions[0]!.start, mentions[0]!.end), '@alice');
});

test('extractMentionCandidates supports start-of-string, self-mentions, and repeated spans in order', () => {
  const text = '@alice mentioned herself: @alice';
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions, [
    { authoredHandle: 'alice', start: 0, end: 6 },
    { authoredHandle: 'alice', start: 26, end: 32 },
  ]);
});

test('extractMentionCandidates ignores malformed tokens and preserves trailing punctuation outside the span', () => {
  const text = 'Bad @, bad @-oops, good @dora, and @erin.';
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions, [
    { authoredHandle: 'dora', start: text.indexOf('@dora'), end: text.indexOf('@dora') + 5 },
    { authoredHandle: 'erin', start: text.indexOf('@erin'), end: text.indexOf('@erin') + 5 },
  ]);
  assert.equal(text[mentions[0]!.end], ',');
  assert.equal(text[mentions[1]!.end], '.');
});
