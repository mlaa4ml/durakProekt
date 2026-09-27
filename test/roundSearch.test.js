import test from 'node:test';
import assert from 'node:assert/strict';
import { DurakGame } from '../src/game.js';
import { SmartBot } from '../src/bots/smartBot.js';
import { applyObservedAction } from '../src/bots/index.js';
import { searchRound } from '../src/bots/roundSearch.js';

const card = (s) => ({ suit: s.slice(-1), rank: ({ J: 11, Q: 12, K: 13, A: 14 })[s.slice(0, -1)] || Number(s.slice(0, -1)) });
const same = (a, b) => a?.rank === b?.rank && a?.suit === b?.suit;

// Synthetic public pickup: knowledge comes exclusively from real transitions.
function fixture(mine, theirs, options = {}) {
  const game = DurakGame.fromPosition({
    rules: { deckSize: 24, numPlayers: 2, allowPerevod: true },
    trumpSuit: '♠',
    players: [{ id: 'a', hand: mine.map(card) }, { id: 'b', hand: [] }],
    attacker: 'a', defender: 'b', phase: 'need-attack',
    table: theirs.map((s) => ({ attack: card(s) })),
    tookCards: true, attackCountThisRound: theirs.length,
    defenderHandAtStart: theirs.length,
    discardCount: 24 - mine.length - theirs.length,
  });
  const bot = new SmartBot({
    trace: true, profile: { safeRoundAttack: true },
    solver: { maxNodes: 0 }, roundSearch: { maxMs: 500 }, ...options,
  });
  bot.reset(game.getState('a'), 'a');
  const bots = new Map([['a', bot]]);
  function apply(type, token) {
    const actor = game.currentActorId();
    const action = game.getLegalActions(actor).find((a) =>
      a.type === type && (!token || same(a.card || a.cards?.[0], card(token))));
    assert.ok(action, `legal ${actor} ${type} ${token || ''}`);
    applyObservedAction(game, bots, actor, action);
  }
  apply('pass');
  assert.equal(bot.tracker.isOpponentHandCertain('b'), true);
  function decide() {
    const legal = game.getLegalActions('a');
    const result = bot.decide(game.getState('a'), 'a', legal);
    assert.ok(legal.includes(result.action));
    assert.equal(result.decisionTrace.emergencyFallback, false);
    return result;
  }
  return { game, bot, apply, decide };
}

test('unbeatable trump is not a forced take when the engine permits transfer', () => {
  const { game, apply, decide } = fixture(['A♠', '9♣', '10♦'], ['A♥', 'K♥']);
  const result = decide();
  const ace = result.decisionTrace.roundSearch.candidates.find((c) => same(c.action.card, card('A♠')));
  assert.equal(ace.complete, true);
  assert.equal(ace.forcedTake, false);
  apply('attack', 'A♠');
  assert.equal(game.phase, 'defender-to-act');
  assert.ok(game.getLegalActions('b').some((a) => a.type === 'transfer'));
  assert.ok(!game.getLegalActions('b').some((a) => a.type === 'defend'));
  apply('transfer', 'A♥');
  assert.equal(game.currentActorId(), 'a');
  assert.deepEqual(game.getLegalActions('a').map((a) => a.type), ['take']);
});

test('after a declared take, useful pass keeps a trump instead of donating it', () => {
  const { game, apply, decide } = fixture(['9♣', '9♠', 'K♣'], ['Q♥', 'K♥']);
  apply('attack', '9♣');
  apply('take');
  assert.equal(game.phase, 'need-attack');
  assert.ok(game.getLegalActions('a').some((a) => a.type === 'attack'));
  const result = decide();
  assert.equal(result.decisionTrace.selectedRule, 'safe-round-attack');
  assert.equal(result.action.type, 'pass');
  apply('pass');
  assert.ok(game.players[0].hand.some((c) => same(c, card('9♠'))));
});

test('last attacking card after a take beats conserving the trump', () => {
  const { game, apply, decide } = fixture(['9♣', '9♠'], ['Q♥', 'K♥']);
  apply('attack', '9♣');
  apply('take');
  const result = decide();
  assert.equal(result.decisionTrace.selectedRule, 'safe-round-attack');
  assert.ok(same(result.action.card, card('9♠')));
  apply('attack', '9♠');
  if (game.phase !== 'finished') apply('pass');
  assert.equal(game.phase, 'finished');
  assert.equal(game.durak, 'b');
});

test('unknown hands stay unknown with the flag enabled', () => {
  const { game } = fixture(['A♠', '9♣', '10♦'], ['A♥', 'K♥']);
  const bot = new SmartBot({ trace: true, profile: { safeRoundAttack: true } });
  bot.reset(game.getState('a'), 'a'); // no pickup history delivered to this bot
  const legal = game.getLegalActions('a');
  const result = bot.decide(game.getState('a'), 'a', legal);
  assert.ok(legal.includes(result.action));
  assert.equal(result.decisionTrace.roundSearch.status, 'unknown-hand');
  assert.equal(result.decisionTrace.roundSearch.complete, false);
  assert.equal(result.decisionTrace.roundSearch.nodes, 0);
});

test('node, time and depth exhaustion never manufacture a certificate', () => {
  const { game, bot } = fixture(['A♠', '9♣', '10♦'], ['A♥', 'K♥']);
  for (const options of [{ maxNodes: 0 }, { maxMs: 0 }, { maxDepth: 0 }, { maxNodesPerAction: 0 }]) {
    const result = searchRound(game.getState('a'), bot.tracker, 'a', game.getLegalActions('a'), options);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.action, null);
    assert.equal(result.complete, false);
    assert.equal(result.nodes, 0);
    assert.ok(result.ms < 500, 'zero budget should return promptly');
  }
});

test('completed exact solver remains the first choice', () => {
  const { decide } = fixture(['A♠'], ['Q♥', 'K♥'], { solver: { maxNodes: 10000, maxMs: 500 } });
  const result = decide();
  assert.equal(result.decisionTrace.selectedRule, 'exact-solver');
  assert.equal(result.decisionTrace.roundSearch, undefined);
});
