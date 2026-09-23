import test from 'node:test';
import assert from 'node:assert';
import { SMART_PROFILES, SMART_PROFILE, pickProfileName, pickProfile } from '../src/bots/smartBot.js';

test('pickProfileName and pickProfile return correct profiles for 2 to 6 players', () => {
  assert.equal(pickProfileName({ numPlayers: 2 }), 'duel');
  assert.equal(pickProfileName({ numPlayers: 3 }), 'small');
  assert.equal(pickProfileName({ numPlayers: 4 }), 'small');
  assert.equal(pickProfileName({ numPlayers: 5 }), 'large');
  assert.equal(pickProfileName({ numPlayers: 6 }), 'large');

  assert.deepEqual(pickProfile({ numPlayers: 2 }), SMART_PROFILES.duel);
  assert.deepEqual(pickProfile({ numPlayers: 4 }), SMART_PROFILES.small);
  assert.deepEqual(pickProfile({ numPlayers: 6 }), SMART_PROFILES.large);
});

test('pickProfile handles missing or invalid rules safely with default duel profile', () => {
  assert.equal(pickProfileName(null), 'duel');
  assert.equal(pickProfileName({}), 'duel');
  assert.equal(pickProfileName({ numPlayers: 99 }), 'large');
  assert.equal(pickProfileName({ numPlayers: -1 }), 'duel');

  assert.deepEqual(pickProfile(null), SMART_PROFILES.duel);
  assert.deepEqual(pickProfile({}), SMART_PROFILES.duel);
});

test('all profiles contain exactly the same set of keys and boolean values', () => {
  const duelKeys = Object.keys(SMART_PROFILES.duel).sort();
  const smallKeys = Object.keys(SMART_PROFILES.small).sort();
  const largeKeys = Object.keys(SMART_PROFILES.large).sort();

  assert.deepEqual(smallKeys, duelKeys);
  assert.deepEqual(largeKeys, duelKeys);

  for (const name of ['duel', 'small', 'large']) {
    const profile = SMART_PROFILES[name];
    for (const key of duelKeys) {
      assert.equal(typeof profile[key], 'boolean', `Profile ${name} key ${key} should be boolean`);
    }
  }
});

test('SMART_PROFILE is an exported alias of SMART_PROFILES.duel', () => {
  assert.strictEqual(SMART_PROFILE, SMART_PROFILES.duel);
});
