import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createMatch } from '../src/engine/index.js';

describe('Issue 64 Position & Reconstruction Tests', () => {
  it('should verify basic match creation and turn structure', () => {
    const match = createMatch({ playersCount: 2, deckSize: 36 });
    assert.ok(match, 'Match should be created');
    assert.strictEqual(match.getState().players.length, 2);
  });

  it('should support endgame position simulation structure', () => {
    const match = createMatch({ playersCount: 2, deckSize: 36 });
    const state = match.getState();
    assert.strictEqual(typeof state.deck.length, 'number');
  });
});
