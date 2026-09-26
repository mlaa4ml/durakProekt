import test from 'node:test';
import assert from 'node:assert/strict';
import { DurakGame } from '../src/game.js';
import { SmartBot } from '../src/bots/smartBot.js';
import { applyObservedAction } from '../src/bots/index.js';
import { cardKey } from '../src/bots/memory.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';

function seeded(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const keys = (cards) => new Set(cards.map(cardKey));
function subset(actual, expected, label) {
  for (const k of actual) assert.ok(expected.has(k), `${label}: unexpected ${k}`);
}

function observers(game, events) {
  const bots = new Map();
  for (const p of game.players) {
    const bot = new SmartBot({ solver: { maxNodes: 20, maxMs: 5 } });
    bot.reset(game.getState(p.id), p.id);
    const observe = bot.observe.bind(bot);
    bot.observe = (state, id, event) => {
      assert.equal(id, p.id);
      for (const other of state.players) {
        if (other.id !== id) assert.equal(other.hand, undefined, 'hidden hand leaked');
      }
      if (event) events.push({ id, event });
      observe(state, id, event);
      assert.ok(bot.tracker, 'observation must not silently drop memory');
    };
    bots.set(p.id, bot);
  }
  return bots;
}

test('complete public history: real four-player games, knowledge and legal decisions', () => {
  const coverage = new Set();
  for (const seed of [1, 7, 19, 42]) {
    const game = new DurakGame(
      Array.from({ length: 4 }, (_, i) => ({ id: `p${i}` })),
      { deckSize: 36 }, seeded(seed),
    );
    const events = [];
    const bots = observers(game, events);
    const discarded = new Set();
    let steps = 0;
    while (game.phase !== 'finished' && steps++ < 2500) {
      const actor = game.currentActorId();
      const legal = game.getLegalActions(actor);
      const state = game.getState(actor);
      const decision = bots.get(actor).decide(state, actor, legal);
      assert.ok(legal.some((a) => game._actionsEqual(a, decision.action)));
      const action = simpleBotDecide(state, actor, legal);
      const before = state.table.flatMap((t) => [t.attack, t.defense].filter(Boolean));
      const played = action.cards || (action.card ? [action.card] : []);
      const beforeDiscard = game.discardCount;
      const alive = game.players.filter((p) => !p.out).map((p) => p.id);
      events.length = 0;
      applyObservedAction(game, bots, actor, action);
      assert.deepEqual(events.map((e) => e.id), alive);
      assert.equal(game.publicTransition.actionNumber, steps);
      coverage.add(action.type);
      if (game.players.filter((p) => !p.out).length === 2) coverage.add('duel');
      if (game.publicTransition.trumpDraws.length) coverage.add('trumpDraw');
      if (game.discardCount > beforeDiscard) {
        for (const k of keys([...before, ...played])) discarded.add(k);
      }
      for (const id of alive) {
        const tracker = bots.get(id).tracker;
        assert.equal(tracker.unseenDiscardCount, 0, 'complete history lost a closed table');
        assert.deepEqual(tracker.discard, discarded);
        for (const p of game.players) {
          subset(tracker.opponentKnownCards(p.id), keys(p.hand), `known ${id}/${p.id}`);
          if (p.id !== id) subset(keys(p.hand), tracker.opponentPossibleCards(p.id), 'possible');
        }
        if (!game.talon.length && game.players.filter((p) => !p.out).length === 2 &&
            !game.players.find((p) => p.id === id).out) {
          const opponent = game.players.find((p) => !p.out && p.id !== id);
          assert.equal(tracker.isOpponentHandCertain(opponent.id), true);
        }
      }
    }
    assert.ok(steps < 2500, 'game did not terminate');
  }
  for (const feature of ['duel', 'take', 'transfer', 'defend', 'trumpDraw']) {
    assert.ok(coverage.has(feature), `fixture coverage missing: ${feature}`);
  }
});
