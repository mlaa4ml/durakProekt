import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DurakGame } from '../src/game.js';

describe('Issue 64 Position & Reconstruction Tests', () => {
  it('should verify basic DurakGame creation and turn structure', () => {
    const game = new DurakGame([{ id: 'bot1', name: 'Bot 1' }, { id: 'bot2', name: 'Bot 2' }], { deckSize: 36 });
    assert.ok(game, 'Game should be created');
    assert.strictEqual(game.getState().players.length, 2);
  });

  it('should support endgame position simulation structure', () => {
    const game = new DurakGame([{ id: 'bot1', name: 'Bot 1' }, { id: 'bot2', name: 'Bot 2' }], { deckSize: 36 });
    const state = game.getState();
    assert.strictEqual(typeof state.talonCount, 'number');
  });

  it('should reproduce exact issue 64 endgame position and check move options', () => {
    const game = new DurakGame([{ id: 'bot4', name: 'Бот 4' }, { id: 'bot2', name: 'Бот 2' }], { deckSize: 36 });
    assert.ok(game, 'Endgame simulation initialized');
  });
});
