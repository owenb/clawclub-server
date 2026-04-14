import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContentMentionCandidates, extractMentionCandidates } from '../../src/mentions.ts';

// A 12-char short_id from the Crockford alphabet (no 0, 1, i, l, o).
const ALICE_ID = 'a7k9m2p4q8r3';
const BOB_ID   = 'b8m2n4p6q9r5';
const CAROL_ID = 'c7k9m2p4q8r3';
const DORA_ID  = 'd6k8m3p7q9r4';
const ERIN_ID  = 'e5k7m4p6q2r8';

test('extractMentionCandidates parses [Label|id] spans with offsets', () => {
  const text = `I also debated with [Kilian Valdman|${ALICE_ID}] whether we should build a frontend.`;
  const mentions = extractMentionCandidates(text);

  const start = text.indexOf(`[`);
  const end = text.indexOf(`]`) + 1;
  assert.deepEqual(mentions, [{
    authoredLabel: 'Kilian Valdman',
    memberId: ALICE_ID,
    start,
    end,
  }]);
  assert.equal(text.slice(mentions[0]!.start, mentions[0]!.end), `[Kilian Valdman|${ALICE_ID}]`);
});

test('extractMentionCandidates does not confuse [Name|id] with markdown links', () => {
  const text = `See [GitHub](https://github.com) and say hi to [Carol|${CAROL_ID}].`;
  const mentions = extractMentionCandidates(text);

  assert.deepEqual(mentions.map((m) => m.memberId), [CAROL_ID]);
  assert.equal(mentions[0]!.authoredLabel, 'Carol');
});

test('extractMentionCandidates rejects labels with outer whitespace', () => {
  const text = `Hello [ Alice |${ALICE_ID}] and [Bob|${BOB_ID}]`;
  const mentions = extractMentionCandidates(text);

  // Only Bob's label passes; Alice's has leading/trailing whitespace.
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.authoredLabel, 'Bob');
  assert.equal(mentions[0]!.memberId, BOB_ID);
});

test('extractMentionCandidates rejects ids with wrong format', () => {
  // 'l', 'i', 'o', '0', '1' are NOT in the short_id alphabet.
  const text = `Try [Alice|alice1234567z] or [Bob|${BOB_ID}]`;
  const mentions = extractMentionCandidates(text);

  // Only Bob's id matches the short_id pattern.
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.memberId, BOB_ID);
});

test('extractMentionCandidates rejects labels containing newlines', () => {
  // Mention labels must stay on a single line so offsets remain meaningful.
  const lf = `Hello [Alice\nSmith|${ALICE_ID}] and [Bob|${BOB_ID}]`;
  const cr = `Hello [Alice\rSmith|${ALICE_ID}] and [Bob|${BOB_ID}]`;
  const crlf = `Hello [Alice\r\nSmith|${ALICE_ID}] and [Bob|${BOB_ID}]`;

  for (const text of [lf, cr, crlf]) {
    const mentions = extractMentionCandidates(text);
    // Only Bob — Alice's label spans a line break.
    assert.equal(mentions.length, 1, `multiline label rejected: ${JSON.stringify(text)}`);
    assert.equal(mentions[0]!.memberId, BOB_ID);
  }
});

test('extractContentMentionCandidates extracts per field independently', () => {
  const extracted = extractContentMentionCandidates({
    title: `Thanks [Alice|${ALICE_ID}]`,
    summary: null,
    body: `Ping [Bob|${BOB_ID}] and [Carol|${CAROL_ID}].`,
  });

  assert.deepEqual(extracted.title.map((m) => m.memberId), [ALICE_ID]);
  assert.deepEqual(extracted.summary, []);
  assert.deepEqual(extracted.body.map((m) => m.memberId), [BOB_ID, CAROL_ID]);
});

test('extractMentionCandidates uses UTF-16 offsets for non-ASCII text', () => {
  const text = `he\u0301llo \u{1F44B} [Alice|${ALICE_ID}]`;
  const mentions = extractMentionCandidates(text);

  const start = text.indexOf('[');
  const end = text.indexOf(']') + 1;
  assert.deepEqual(mentions, [{
    authoredLabel: 'Alice',
    memberId: ALICE_ID,
    start,
    end,
  }]);
  assert.equal(text.slice(mentions[0]!.start, mentions[0]!.end), `[Alice|${ALICE_ID}]`);
});

test('extractMentionCandidates supports start-of-string and repeated spans in order', () => {
  const text = `[Alice|${ALICE_ID}] mentioned herself: [Alice|${ALICE_ID}]`;
  const mentions = extractMentionCandidates(text);

  assert.equal(mentions.length, 2);
  assert.equal(mentions[0]!.memberId, ALICE_ID);
  assert.equal(mentions[1]!.memberId, ALICE_ID);
  assert.ok(mentions[0]!.start < mentions[1]!.start);
});

test('extractMentionCandidates ignores malformed tokens and preserves trailing punctuation outside the span', () => {
  const text = `Bad [|${DORA_ID}], bad [foo], good [Dora|${DORA_ID}], and [Erin|${ERIN_ID}].`;
  const mentions = extractMentionCandidates(text);

  assert.equal(mentions.length, 2);
  assert.equal(mentions[0]!.authoredLabel, 'Dora');
  assert.equal(mentions[0]!.memberId, DORA_ID);
  assert.equal(mentions[1]!.authoredLabel, 'Erin');
  assert.equal(mentions[1]!.memberId, ERIN_ID);
  assert.equal(text[mentions[0]!.end], ',');
  assert.equal(text[mentions[1]!.end], '.');
});
