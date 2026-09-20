// Тесты памяти умного бота (issue #32, этап 2).
// Запуск: node --test test/
//
// Две части:
//   1) точечные юнит-тесты на «рукописных» последовательностях состояний —
//      бито, взятие стола, добор, козырь под колодой;
//   2) фаззинг на НАСТОЯЩЕМ движке: трекер кормится только маскированным
//      game.getState(меня), а проверяется он по реальным рукам игроков.
//      Здесь ловятся и «ложные точные факты» (главный риск памяти),
//      и эндшпиль дуэли (рука соперника обязана восстанавливаться точно).

import test from 'node:test';
import assert from 'node:assert/strict';

import { CardTracker, cardKey } from '../src/bots/memory.js';
import { DurakGame } from '../src/game.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';

const c = (rank, suit) => ({ rank, suit });
const keys = (set) => [...set].sort();

// Минимальный «ручной» state в формате game.getState(meId).
function mkState({
  phase = 'need-attack',
  trumpSuit = '♣',
  trumpCard = c(9, '♣'),
  talonCount = 10,
  discardCount = 0,
  table = [],
  tableGoingToDefender = false,
  attacker = 'p1',
  defender = 'p2',
  myHand = [],
  counts = { p1: 6, p2: 6 },
  me = 'p1',
  out = {},
  finished = false,
} = {}) {
  return {
    phase,
    trumpSuit,
    trumpCard,
    talonCount,
    discardCount,
    table: table.map((t) => ({ attack: t.attack, defense: t.defense ?? null })),
    tableGoingToDefender,
    attacker,
    defender,
    players: Object.keys(counts).map((id) => ({
      id,
      name: id,
      handCount: counts[id],
      out: out[id] === true,
      finishRank: null,
      hand: id === me ? myHand : undefined,
    })),
    durak: null,
    finished,
  };
}

// ---------------------------------------------------------------- юнит-тесты

test('стол ушёл в бито — карты записаны в discard и вне unknown', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  t.observe(mkState({
    table: [{ attack: c(10, '♠'), defense: c(12, '♠') }],
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 3 },
  }));
  assert.deepEqual(keys(t.onTable), ['10♠', '12♠']);

  t.observe(mkState({
    table: [],
    discardCount: 2,
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 3 },
  }));

  assert.deepEqual(keys(t.discard), ['10♠', '12♠']);
  assert.equal(t.onTable.size, 0);
  const unknown = t.unknownCards();
  assert.ok(!unknown.has('10♠') && !unknown.has('12♠'), 'битые карты не должны считаться неизвестными');
  assert.ok(!unknown.has('14♠'), 'моя карта не должна считаться неизвестной');
});

test('защитник взял стол — карты точно у него, масть неотбитой атаки помечена как void', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  t.observe(mkState({
    table: [{ attack: c(13, '♠'), defense: null }],
    tableGoingToDefender: true,
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 3 },
  }));
  t.observe(mkState({
    table: [],
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 4 },
  }));

  assert.deepEqual(keys(t.opponentKnownCards('p2')), ['13♠']);
  assert.equal(t.probabilityOpponentHas('p2', c(13, '♠')), 1);
  assert.ok(t.voidSuits.get('p2').has('♠'), 'не смог побить пику → скорее всего пик нет');
  assert.ok(!t.voidSuits.get('p2').has('♣'), 'пока идёт прикуп, вывода про козырь не делаем');
  assert.ok(!t.unknownCards().has('13♠'));

  // Он сыграл эту карту обратно на стол — «точный факт» должен сняться.
  t.observe(mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(13, '♠'), defense: null }],
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 3 },
  }));
  assert.equal(t.opponentKnownCards('p2').size, 0);
  assert.ok(t.onTable.has('13♠'));
  assert.ok(t.seenPlayed.get('p2').has('13♠'));
});

test('добор из прикупа стирает предположения, но не точные факты', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  t.observe(mkState({
    table: [{ attack: c(13, '♠'), defense: null }],
    tableGoingToDefender: true,
    talonCount: 10,
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 3 },
  }));
  t.observe(mkState({ table: [], talonCount: 10, myHand: [c(14, '♠')], counts: { p1: 1, p2: 4 } }));
  assert.ok(t.voidSuits.get('p2').has('♠'));

  // p2 добирает 2 карты: предположение «нет пик» больше не обосновано.
  t.observe(mkState({ table: [], talonCount: 8, myHand: [c(14, '♠')], counts: { p1: 1, p2: 6 } }));
  assert.equal(t.voidSuits.get('p2').size, 0, 'после добора предположения сбрасываются');
  assert.ok(t.opponentKnownCards('p2').has('13♠'), 'точный факт про забранную карту сохраняется');
});

test('последняя карта прикупа — это козырь под колодой, и мы знаем, кто её забрал', () => {
  const trump = c(9, '♣');
  const t = new CardTracker(24, '♣', trump, 'p1', ['p1', 'p2']);
  t.observe(mkState({ talonCount: 1, myHand: [c(14, '♠'), c(13, '♠')], counts: { p1: 2, p2: 5 } }));
  t.observe(mkState({ talonCount: 0, myHand: [c(14, '♠'), c(13, '♠')], counts: { p1: 2, p2: 6 } }));

  assert.ok(t.opponentKnownCards('p2').has('9♣'), 'козырь под колодой ушёл p2');
  assert.equal(t.probabilityOpponentHas('p2', trump), 1);
  assert.ok(!t.unknownCards().has('9♣'));
});

test('эндшпиль дуэли: пул неизвестного схлопывается в руку соперника', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  // 24 карты: 20 в бито, 2 у меня, 2 у соперника.
  const my = [c(14, '♠'), c(13, '♠')];
  const oppReal = ['14♥', '14♦'];
  const discardCards = [];
  for (const suit of ['♠', '♥', '♦', '♣']) {
    for (const rank of [9, 10, 11, 12, 13, 14]) {
      const k = `${rank}${suit}`;
      if (k === '14♠' || k === '13♠' || oppReal.includes(k)) continue;
      discardCards.push({ rank, suit });
    }
  }
  // Загоняем «бито» через наблюдение: сначала карты лежат на столе, потом уходят в отбой.
  const pairs = [];
  for (let i = 0; i < discardCards.length; i += 2) {
    pairs.push({ attack: discardCards[i], defense: discardCards[i + 1] });
  }
  t.observe(mkState({ talonCount: 0, table: pairs, myHand: my, counts: { p1: 2, p2: 2 } }));
  t.observe(mkState({
    talonCount: 0, table: [], discardCount: discardCards.length,
    myHand: my, counts: { p1: 2, p2: 2 },
  }));

  assert.ok(t.isOpponentHandCertain('p2'), 'при пустом прикупе рука соперника должна быть просчитана');
  assert.deepEqual(keys(t.opponentKnownCards('p2')), keys(new Set(oppReal)));
  assert.equal(t.probabilityOpponentHas('p2', c(14, '♥')), 1);
  assert.equal(t.probabilityOpponentHas('p2', c(9, '♥')), 0);
});

test('highestRemaining и trumpsLeftOutside считают только то, что реально может выйти', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  t.observe(mkState({
    table: [{ attack: c(14, '♠'), defense: c(10, '♣') }],
    myHand: [c(13, '♠'), c(14, '♣')],
    counts: { p1: 2, p2: 4 },
  }));
  // A♠ на столе, K♠ у меня → старшая «чужая» пика это Q♠.
  assert.deepEqual(t.highestRemaining('♠'), { rank: 12, suit: '♠' });
  // Козыри 24-карточной колоды: 9,10,J,Q,K,A. A♣ у меня, 10♣ на столе (ещё не в бито).
  assert.equal(t.trumpsLeftOutside(), 5);
  assert.equal(t.trumpsLeftOutside([c(13, '♠'), c(14, '♣')]), 5);
});

test('неопределённость = честное «не знаю»', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2', 'p3']);
  t.observe(mkState({
    talonCount: 6,
    myHand: [c(14, '♠')],
    counts: { p1: 1, p2: 5, p3: 5 },
  }));
  assert.equal(t.isOpponentHandCertain('p2'), false);
  assert.equal(t.opponentKnownCards('p2').size, 0);
  const p = t.probabilityOpponentHas('p2', c(9, '♥'));
  assert.ok(p > 0 && p < 1, `вероятность должна быть строго между 0 и 1, получено ${p}`);
  assert.equal(t.probabilityOpponentHas('p2', c(14, '♠')), 0, 'мою карту сопернику не приписываем');
});

test('трекер не выдумывает автора хода, когда подкинуть могли несколько игроков', () => {
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2', 'p3']);
  const base = { counts: { p1: 3, p2: 5, p3: 5 }, myHand: [c(14, '♠'), c(13, '♦'), c(12, '♦')], defender: 'p3', attacker: 'p1' };
  t.observe(mkState(base));
  t.observe(mkState({ ...base, table: [{ attack: c(10, '♥'), defense: null }], counts: { p1: 3, p2: 4, p3: 5 } }));
  // Карту мог положить и p1, и p2 — автор неизвестен, значит seenPlayed пуст у обоих.
  assert.equal(t.seenPlayed.get('p1').size, 0);
  assert.equal(t.seenPlayed.get('p2').size, 0);
  assert.ok(t.onTable.has('10♥'));
});

// ------------------------------------------------------------------ фаззинг

// Прогон одной партии движка: трекер игрока `meId` видит ТОЛЬКО getState(meId).
// Возвращает статистику и по ходу дела проверяет инварианты честности.
function fuzzGame({ numPlayers, deckSize, seedRng, meId = 'p1' }) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
  const game = new DurakGame(players, { numPlayers, deckSize }, seedRng);
  const tracker = CardTracker.fromState(game.getState(meId), meId, deckSize);

  const stats = { endgameChecks: 0, certain: 0, observations: 0 };
  let safety = 0;

  const realHand = (id) => new Set(game.players.find((p) => p.id === id).hand.map(cardKey));

  const check = (state) => {
    stats.observations++;
    for (const p of game.players) {
      if (p.id === meId) continue;
      const real = realHand(p.id);
      // ТОЧНЫЕ факты обязаны быть правдой.
      for (const k of tracker.takenBy.get(p.id) || []) {
        assert.ok(real.has(k), `ложный «точный» факт: ${k} приписана ${p.id}, а её там нет`);
      }
      // Пул неизвестного обязан накрывать всю скрытую руку.
      const possible = tracker.opponentPossibleCards(p.id);
      for (const k of real) {
        assert.ok(possible.has(k), `карта ${k} из руки ${p.id} выпала из кандидатов`);
      }
      if (tracker.isOpponentHandCertain(p.id)) {
        assert.deepEqual(keys(tracker.opponentKnownCards(p.id)), keys(real),
          `«точно знаю» руку ${p.id}, но она другая`);
      }
      assert.equal(tracker.probabilityOpponentHas(p.id, { rank: 0, suit: '♠' }), 0);
    }
    // Ни одна карта из бито не может быть у кого-то на руках или на столе.
    const onTableNow = new Set();
    for (const t of game.table) {
      onTableNow.add(cardKey(t.attack));
      if (t.defense) onTableNow.add(cardKey(t.defense));
    }
    for (const k of tracker.discard) {
      assert.ok(!onTableNow.has(k), `карта ${k} записана в бито, но лежит на столе`);
      for (const p of game.players) {
        assert.ok(!realHand(p.id).has(k), `карта ${k} записана в бито, но она в руке ${p.id}`);
      }
    }
    assert.deepEqual(keys(tracker.onTable), keys(onTableNow), 'стол в памяти разошёлся с реальным');

    // Эндшпиль дуэли: рука соперника обязана быть просчитана точно.
    if (numPlayers === 2 && state.talonCount === 0 && !state.finished) {
      const opp = game.players.find((p) => p.id !== meId);
      if (!opp.out && opp.hand.length > 0) {
        stats.endgameChecks++;
        assert.ok(tracker.isOpponentHandCertain(opp.id),
          'в эндшпиле дуэли рука соперника должна быть восстановлена');
        assert.deepEqual(keys(tracker.opponentKnownCards(opp.id)), keys(realHand(opp.id)));
        stats.certain++;
      }
    }
  };

  while (game.phase !== 'finished' && safety < 5000) {
    safety++;
    let acted = false;
    for (const p of game.players) {
      if (p.out) continue;
      const legal = game.getLegalActions(p.id);
      if (legal.length === 0) continue;
      const state = game.getState(p.id);
      if (p.id === meId) {
        tracker.observe(state);
        check(state);
      }
      const action = simpleBotDecide(state, p.id, legal);
      if (!action) continue;
      game.applyAction(p.id, action);
      acted = true;
      break;
    }
    if (!acted) break;
  }
  return stats;
}

// Детерминированный ГПСЧ, чтобы падение теста воспроизводилось по номеру прогона.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('фаззинг дуэли: при пустом прикупе рука соперника восстанавливается в 100 % прогонов', () => {
  let endgameChecks = 0;
  const RUNS = 150;
  for (let i = 0; i < RUNS; i++) {
    const stats = fuzzGame({ numPlayers: 2, deckSize: 24, seedRng: mulberry32(1000 + i) });
    assert.equal(stats.certain, stats.endgameChecks, `прогон #${i}: эндшпиль просчитан не полностью`);
    endgameChecks += stats.endgameChecks;
  }
  assert.ok(endgameChecks > 0, 'ни один прогон не дошёл до эндшпиля — тест бесполезен');
});

test('фаззинг 3/4/6 игроков: ложных «точных» фактов нет', () => {
  for (const [numPlayers, deckSize, runs] of [[3, 36, 40], [4, 36, 40], [6, 52, 25]]) {
    for (let i = 0; i < runs; i++) {
      const stats = fuzzGame({ numPlayers, deckSize, seedRng: mulberry32(7000 + i + numPlayers * 100) });
      assert.ok(stats.observations > 0);
    }
  }
});

test('фаззинг колод 36/52 в дуэли', () => {
  for (const deckSize of [36, 52]) {
    for (let i = 0; i < 25; i++) {
      const stats = fuzzGame({ numPlayers: 2, deckSize, seedRng: mulberry32(31337 + i) });
      assert.equal(stats.certain, stats.endgameChecks);
    }
  }
});
