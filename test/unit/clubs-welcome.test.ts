import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOnboardingWelcome,
  buildSecondClubWelcome,
  buildSponsorHeadsUp,
} from '../../src/clubs/welcome.ts';

test('buildOnboardingWelcome returns the full ceremony payload with sponsor-aware copy', () => {
  const welcome = buildOnboardingWelcome({
    clubName: 'DogClub',
    memberName: 'Susan',
    sponsorPublicName: 'Amy',
  });

  assert.match(welcome.greeting, /Welcome to DogClub, Susan\./);
  assert.match(welcome.preamble, /Amy helped bring you in\./);
  assert.equal(welcome.capabilities.length, 5);
  assert.ok(welcome.capabilities.every((line) => line.startsWith('Ask me')));
  assert.match(welcome.closing, /post your first introduction/i);
});

test('buildOnboardingWelcome omits sponsor copy when none is provided', () => {
  const welcome = buildOnboardingWelcome({
    clubName: 'CatClub',
    memberName: 'Jenny',
  });

  assert.equal(welcome.preamble.includes('helped bring you in'), false);
});

test('buildSecondClubWelcome returns the lighter cross-club welcome', () => {
  const welcome = buildSecondClubWelcome({
    clubName: 'FoxClub',
    memberName: 'Alice',
    sponsorPublicName: 'Charlie',
  });

  assert.match(welcome.greeting, /You're now active in FoxClub, Alice\./);
  assert.match(welcome.preamble, /Charlie sponsored your admission here\./);
  assert.equal(welcome.capabilities.length, 3);
  assert.match(welcome.closing, /introduce yourself in this club/i);
});

test('buildSponsorHeadsUp returns the sponsor-facing welcome prompt', () => {
  const message = buildSponsorHeadsUp({
    newMemberPublicName: 'Jenny',
    clubName: 'DogClub',
  });

  assert.match(message, /Jenny was just approved into DogClub\./);
  assert.match(message, /welcome DM/i);
});
