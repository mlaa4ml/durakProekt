// Реконструкция только показанного раунда #64, не replay всей партии.
// Не проверяет знание SmartBot и не утверждает выигрыш после вынужденного взятия.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurakGame } from '../src/game.js';
import { SmartBot } from '../src/bots/smartBot.js';
import { applyObservedAction } from '../src/bots/index.js';

// Synthetic public prehistory, not a claim about the missing log of #64:
// the opponent picks up exactly the four pictured cards from a real table.
// No hidden hand is passed to the bot or assigned to its tracker.
function observedPosition(rules, options = {}) {
  const target = position(rules);
  const game = DurakGame.fromPosition({
    rules, trumpSuit: '♠',
    players: [
      { id: 'bot4', hand: target.players[0].hand },
      { id: 'bot2', hand: [] },
    ],
    attacker: 'bot4', defender: 'bot2', phase: 'need-attack',
    table: [
      { attack: card('Q♣'), defense: card('J♠') },
      { attack: card('K♥'), defense: card('Q♠') },
    ],
    tookCards: true, attackCountThisRound: 2, defenderHandAtStart: 2,
    discardCount: rules.deckSize - 16,
  });
  const bot = new SmartBot({
    trace: true, explain: true,
    profile: { safeRoundAttack: true },
    solver: { maxNodes: 0 },
    roundSearch: { maxMs: 200 },
    ...options,
  });
  bot.reset(game.getState('bot4'), 'bot4');
  const bots = new Map([['bot4', bot]]);
  const apply = (type, token) => {
    const actor = game.currentActorId();
    const action = game.getLegalActions(actor).find(
      (a) => a.type === type && (!token || sameCard(a.card, card(token))),
    );
    assert.ok(action, `${actor}: ${type} ${token || ''}`);
    applyObservedAction(game, bots, actor, action);
  };
  apply('pass');
  assert.equal(bot.tracker.isOpponentHandCertain('bot2'), true);
  const key = (c) => `${c.rank}:${c.suit}`;
  assert.deepEqual(new Set(bot._opponentKnownHand('bot2').map(key)),
    new Set(target.players[1].hand.map(key)));
  return { game, bot, apply };
}

for (const allowPerevod of [false, true]) {
  test(`#70: public pickup proves local A♠ and J♣ outcomes, transfer=${allowPerevod}`, () => {
    const { game, bot, apply } = observedPosition({ deckSize: 24, numPlayers: 2, allowPerevod });
    const choose = () => {
      const legal = game.getLegalActions('bot4');
      const decision = bot.decide(game.getState('bot4'), 'bot4', legal);
      assert.ok(legal.includes(decision.action));
      assert.equal(decision.decisionTrace.solver.status, 'budget');
      assert.equal(decision.decisionTrace.selectedRule, 'safe-round-attack');
      assert.ok(decision.decisionTrace.roundSearch.nodes <= 6000);
      assert.match(decision.reason, /не доказательство победы/);
      return decision;
    };
    const first = choose();
    assert.ok(sameCard(first.action.card, card('A♠')));
    for (const [attack, defense] of [['9♣', 'Q♣'], ['Q♦', 'J♠'], ['J♦', 'Q♠']]) {
      apply('attack', attack);
      assert.equal(game.phase, 'defender-to-act');
      apply('defend', defense);
      assert.equal(game.phase, 'need-attack');
    }
    const last = choose();
    assert.ok(sameCard(last.action.card, card('J♣')));
    apply('attack', 'J♣');
    assert.deepEqual(game.getLegalActions('bot2').map((a) => a.type), ['take']);
    apply('take');
    assert.equal(game.maxAttacksNow, undefined); // limit is a public derived value
    assert.equal(game.getState('bot4').maxAttacksNow, 0);
    assert.deepEqual(game.getLegalActions('bot4').map((a) => a.type), ['pass']);
    const pass = bot.decide(game.getState('bot4'), 'bot4', game.getLegalActions('bot4'));
    assert.equal(pass.action.type, 'pass');
  });
}

test('#70: exhausted local budget keeps the old fallback; flag defaults off', () => {
  const rules = { deckSize: 24, numPlayers: 2, allowPerevod: true };
  const enabled = observedPosition(rules, { roundSearch: { maxNodes: 0 } });
  const disabled = observedPosition(rules, { profile: { safeRoundAttack: false } });
  const defaultBot = observedPosition(rules, { profile: {} });
  const decide = ({ game, bot }) => bot.decide(game.getState('bot4'), 'bot4', game.getLegalActions('bot4'));
  const a = decide(enabled), b = decide(disabled), c = decide(defaultBot);
  assert.deepEqual(a.action, b.action);
  assert.deepEqual(b.action, c.action);
  assert.equal(a.decisionTrace.roundSearch.status, 'incomplete');
  assert.equal(a.decisionTrace.roundSearch.nodes, 0);
  assert.equal(a.decisionTrace.selectedRule, b.decisionTrace.selectedRule);
  assert.equal(b.decisionTrace.roundSearch, undefined);
});

test('#64: joining at the pictured position reports unknown hand, not search timeout', () => {
  const game = position({ deckSize: 24, numPlayers: 2, allowPerevod: false });
  const state = game.getState('bot4');
  const legal = game.getLegalActions('bot4');
  const bot = new SmartBot({ explain: true, trace: true, solver: { maxNodes: 0 } });
  bot.reset(state, 'bot4');
  const decision = bot.decide(state, 'bot4', legal);
  assert.equal(state.players.find((p) => p.id === 'bot2').hand, undefined);
  assert.equal(decision.decisionTrace.handKnowledge, 'unknown');
  assert.equal(decision.decisionTrace.solver.status, 'unknown-hand');
  assert.equal(decision.decisionTrace.solver.timedOut, false);
  assert.equal(decision.decisionTrace.solver.nodes, 0);
  assert.ok(decision.decisionTrace.selectedRule);
  assert.notEqual(decision.decisionTrace.selectedRule, 'exact-solver');
  assert.match(decision.reason, /рука соперника неизвестна.*Эвристика:/);
  assert.ok(legal.includes(decision.action));
});

const ranks = { J: 11, Q: 12, K: 13, A: 14 };
const card = (s) => ({
  suit: s.slice(-1),
  rank: ranks[s.slice(0, -1)] || Number(s.slice(0, -1)),
});
const sameCard = (a, b) => a?.rank === b.rank && a?.suit === b.suit;

function position(rules) {
  return DurakGame.fromPosition({
    rules,
    trumpSuit: '♠',
    players: [
      { id: 'bot4', hand: ['9♣', 'A♠', 'A♦', 'A♣', '10♥', 'J♥', 'J♦', 'Q♦', 'K♦', '10♣', 'J♣', 'K♣'].map(card) },
      { id: 'bot2', hand: ['Q♣', 'J♠', 'Q♠', 'K♥'].map(card) },
    ],
    attacker: 'bot4',
    defender: 'bot2',
    phase: 'need-attack',
    allowAnyCardNow: true,
    attackCountThisRound: 0,
    defenderHandAtStart: 4,
  });
}

function play(game, actor, type, token) {
  assert.equal(game.currentActorId(), actor);
  const action = game.getLegalActions(actor).find(
    (a) => a.type === type && (!token || sameCard(a.card, card(token))),
  );
  assert.ok(action, `Ожидался легальный ход ${actor}: ${type} ${token || ''}`);
  game.applyLegalAction(actor, action);
}

function firstThreePairs(game) {
  for (const [attack, defense] of [['9♣', 'Q♣'], ['Q♦', 'J♠'], ['J♦', 'Q♠']]) {
    play(game, 'bot4', 'attack', attack);
    play(game, 'bot2', 'defend', defense);
  }
}

// Настройки исходной игры неизвестны. Проверяем локальный вывод при обеих
// настройках перевода и всех размерах колоды; прочие правила — стандартные.
for (const deckSize of [24, 36, 52]) {
  for (const allowPerevod of [false, true]) {
    const rules = { deckSize, numPlayers: 2, allowPerevod };
    const label = `${deckSize} карт, перевод=${allowPerevod}`;

    test(`#64: цепочка лога заканчивается проигрышем Бота 4 (${label})`, () => {
      const game = position(rules);
      firstThreePairs(game);
      play(game, 'bot4', 'attack', 'J♥');
      play(game, 'bot2', 'defend', 'K♥');
      assert.equal(game.attackCountThisRound, 4);
      assert.deepEqual(game.getLegalActions('bot4').map((a) => a.type), ['pass']);
      play(game, 'bot4', 'pass');
      assert.equal(game.phase, 'finished');
      assert.equal(game.durak, 'bot4');
    });

    test(`#64: заход A♠ вынуждает взять (${label})`, () => {
      const game = position(rules);
      play(game, 'bot4', 'attack', 'A♠');
      assert.deepEqual(game.getLegalActions('bot2').map((a) => a.type), ['take']);
      play(game, 'bot2', 'take');
      assert.notEqual(game.phase, 'finished');
    });

    test(`#64: последний J♣ вместо J♥ вынуждает взять (${label})`, () => {
      const game = position(rules);
      firstThreePairs(game);
      assert.deepEqual(game.players.find((p) => p.id === 'bot2').hand, [card('K♥')]);
      play(game, 'bot4', 'attack', 'J♣');
      assert.deepEqual(game.getLegalActions('bot2').map((a) => a.type), ['take']);
      play(game, 'bot2', 'take');
      assert.notEqual(game.phase, 'finished');
    });
  }
}
