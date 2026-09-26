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

test('last defense remains public when the engine closes the table inside applyAction', () => {
  // The current default queue normally needs passes after defense. Exercise the
  // synchronous no-thrower boundary explicitly, using the real closure/refill code.
  class NoThrowersGame extends DurakGame {
    _resetThrowInQueue() {
      super._resetThrowInQueue();
      if (this.table?.length && this.table.every((p) => p.defense)) {
        this.throwInQueue = [];
      }
    }
  }
  const game = new NoThrowersGame([{ id: 'a' }, { id: 'b' }, { id: 'c' }], {
    deckSize: 36, allowPerevod: false,
  }, seeded(7));
  const events = [];
  const bots = observers(game, events);
  // Find a legal opening and response without editing hands or inventing states.
  const actor = game.currentActorId();
  const defenseId = game.getState(actor).defender;
  const attack = game.getLegalActions(actor).find((a) => {
    const copy = game.clone();
    copy.applyAction(actor, a);
    return copy.getLegalActions(defenseId).some((d) => d.type === 'defend');
  });
  assert.ok(attack);
  applyObservedAction(game, bots, actor, attack);
  const defense = game.getLegalActions(defenseId).find((a) => a.type === 'defend');
  const lastCard = cardKey(defense.card);
  events.length = 0;
  applyObservedAction(game, bots, defenseId, defense);
  assert.equal(game.table.length, 0);
  assert.equal(game.discardCount, 2);
  assert.equal(game.publicTransition.closures.length, 1);
  for (const { id, event } of events) {
    assert.ok(event.closures[0].cards.some((c) => cardKey(c) === lastCard));
    assert.ok(bots.get(id).tracker.discard.has(lastCard));
    assert.equal(bots.get(id).tracker.unseenDiscardCount, 0);
    const legal = game.getLegalActions(id);
    if (legal.length) {
      const decision = bots.get(id).decide(game.getState(id), id, legal);
      assert.ok(legal.some((a) => game._actionsEqual(a, decision.action)));
    }
  }
});

test('skipped events lose movable knowledge honestly; duplicates and reset are safe', () => {
  const game = new DurakGame(
    Array.from({ length: 4 }, (_, i) => ({ id: `p${i}` })),
    { deckSize: 36 }, seeded(19),
  );
  const bot = new SmartBot({ solver: { maxNodes: 20, maxMs: 5 } });
  bot.reset(game.getState('p0'), 'p0');
  let skippedClosure = false;
  let resumed = false;
  for (let step = 1; step < 600 && game.phase !== 'finished'; step++) {
    const actor = game.currentActorId();
    const legal = game.getLegalActions(actor);
    const action = simpleBotDecide(game.getState(actor), actor, legal);
    game.applyAction(actor, action);
    const event = game.publicTransition;
    if (!skippedClosure && event.closures.some((c) => c.destination === 'discard')) {
      skippedClosure = true;
      continue;
    }
    bot.observe(game.getState('p0'), 'p0', event);
    const tracker = bot.tracker;
    assert.ok(tracker);
    for (const p of game.players) {
      subset(tracker.opponentKnownCards(p.id), keys(p.hand), 'knowledge after gap');
    }
    const n = tracker.observations;
    tracker.observeTransition(game.getState('p0'), event);
    assert.equal(tracker.observations, n, 'duplicate is a no-op');
    if (skippedClosure && !resumed) {
      assert.ok(tracker.unseenDiscardCount > 0, 'missing discard must remain unknown');
      resumed = true;
    }
  }
  assert.ok(resumed, 'fixture must resume after a missed closure');
  const fresh = new DurakGame([{ id: 'p0' }, { id: 'p1' }], { deckSize: 24 }, seeded(1));
  bot.tracker.reset(fresh.getState('p0'), 'p0');
  const actor = fresh.currentActorId();
  fresh.applyAction(actor, fresh.getLegalActions(actor)[0]);
  bot.tracker.observeTransition(fresh.getState('p0'), fresh.publicTransition);
  assert.equal(bot.tracker._lastActionNumber, 1);
  assert.deepEqual(bot.tracker.onTable, keys(fresh.table.map((t) => t.attack)));
});

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
