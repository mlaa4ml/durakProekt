// Реконструкция только показанного раунда #64, не replay всей партии.
// Не проверяет знание SmartBot и не утверждает выигрыш после вынужденного взятия.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DurakGame } from '../src/game.js';
import { SmartBot } from '../src/bots/smartBot.js';

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
