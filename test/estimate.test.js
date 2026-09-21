// Тесты вероятностных оценок умного бота (issue #49, этап 4 roadmap).
// Запуск: node --test test/
//
// Что проверяем:
//   * все вероятности лежат в [0, 1];
//   * при точно восстановленной руке соперника (`isOpponentHandCertain`)
//     оценка вырождается в 0/1 и совпадает с точным ответом;
//   * `voidSuits` реально обнуляет вероятность некозырного отбоя;
//   * функции чистые: не мутируют ни трекер, ни состояние, ни переданные массивы.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CardTracker } from '../src/bots/memory.js';
import { beats } from '../src/bots/analysis.js';
import {
  pAtLeastOne,
  pOpponentBeats,
  pDefenseSurvives,
  expectedThrowIn,
  bestAttackByPressure,
  throwInRoom,
  allowedThrowInRanksOf,
  throwInPlayersOf,
  opponentView,
} from '../src/bots/estimate.js';

const c = (rank, suit) => ({ rank, suit });
const inUnit = (p) => Number.isFinite(p) && p >= 0 && p <= 1;

// Минимальный «ручной» state в формате game.getState(meId) — как в test/memory.test.js.
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
  rules = { deckSize: 24, numPlayers: 2, throwInPolicy: 'all', maxTableAttacks: 6 },
  maxAttacksNow = undefined,
  allowedThrowInRanks = undefined,
  throwInPlayers = undefined,
  finished = false,
} = {}) {
  const st = {
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
      out: false,
      finishRank: null,
      hand: id === me ? myHand : undefined,
    })),
    rules,
    durak: null,
    finished,
  };
  if (maxAttacksNow !== undefined) st.maxAttacksNow = maxAttacksNow;
  if (allowedThrowInRanks !== undefined) st.allowedThrowInRanks = allowedThrowInRanks;
  if (throwInPlayers !== undefined) st.throwInPlayers = throwInPlayers;
  return st;
}

/** Трекер, в котором p2 взял со стола девятку пик → у него точно 9♠ и «скорее всего нет пик». */
function trackerWithVoidSpades() {
  const myHand = [c(9, '♣'), c(10, '♣'), c(11, '♣'), c(12, '♣'), c(13, '♣'), c(14, '♣')];
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  t.observe(mkState({
    table: [{ attack: c(9, '♠'), defense: null }],
    tableGoingToDefender: true,
    myHand,
    counts: { p1: 6, p2: 3 },
  }));
  t.observe(mkState({ table: [], myHand, counts: { p1: 6, p2: 4 } }));
  return { tracker: t, myHand };
}

// -------------------------------------------------- гипергеометрика

test('pAtLeastOne: границы и монотонность', () => {
  assert.equal(pAtLeastOne(10, 0, 3), 0, 'нужных карт нет — вероятность 0');
  assert.equal(pAtLeastOne(0, 0, 3), 0);
  assert.equal(pAtLeastOne(5, 2, 0), 0, 'соперник не держит карт — вероятность 0');
  assert.equal(pAtLeastOne(5, 5, 1), 1, 'весь пул «нужный» — вероятность 1');
  assert.equal(pAtLeastOne(5, 1, 5), 1, 'держит весь пул — карта точно у него');
  const a = pAtLeastOne(20, 3, 2);
  const b = pAtLeastOne(20, 3, 5);
  assert.ok(inUnit(a) && inUnit(b));
  assert.ok(b > a, 'чем больше карт на руке, тем выше шанс');
});

// -------------------------------------------------- pOpponentBeats

test('pOpponentBeats: вероятность всегда в [0,1] для любой карты колоды', () => {
  const { tracker } = trackerWithVoidSpades();
  for (const suit of ['♠', '♥', '♦', '♣']) {
    for (let rank = 9; rank <= 14; rank++) {
      const p = pOpponentBeats(c(rank, suit), tracker, 'p2', '♣');
      assert.ok(inUnit(p), `p(${rank}${suit}) = ${p} вне [0,1]`);
    }
  }
});

test('pOpponentBeats: без памяти — пессимизм, без карт у соперника — ноль', () => {
  assert.equal(pOpponentBeats(c(10, '♠'), null, 'p2', '♣'), 1);
  assert.equal(pOpponentBeats(null, null, 'p2', '♣'), 0);
});

test('voidSuits обнуляет вероятность некозырного отбоя', () => {
  const { tracker } = trackerWithVoidSpades();
  assert.ok(tracker.voidSuits.get('p2').has('♠'), 'предпосылка теста: пик у соперника скорее всего нет');

  // Все козыри у меня в руке, значит побить пику можно только старшей пикой.
  const withAssumptions = pOpponentBeats(c(10, '♠'), tracker, 'p2', '♣');
  const without = pOpponentBeats(c(10, '♠'), tracker, 'p2', '♣', { useAssumptions: false });
  assert.equal(withAssumptions, 0, 'масти нет и козырей у него нет → отбить нечем');
  assert.ok(without > 0, 'без учёта наблюдений старшие пики ещё «висят» в неизвестном');
  assert.ok(inUnit(without));
});

test('при точно известной руке оценка вырождается в 0/1 и совпадает с точным ответом', () => {
  // Дуэль, прикуп пуст: пул неизвестного схлопывается ровно до руки соперника.
  const myHand = [c(14, '♠'), c(9, '♥')];
  const t = new CardTracker(24, '♣', c(9, '♣'), 'p1', ['p1', 'p2']);
  const discardKeys = [];
  for (const suit of ['♠', '♥', '♦', '♣']) {
    for (let rank = 9; rank <= 14; rank++) discardKeys.push(`${rank}${suit}`);
  }
  // Оставляем «в игре» только мою руку и две карты соперника, остальное — бито.
  const alive = new Set(['14♠', '9♥', '13♥', '10♦']);
  for (const k of discardKeys) if (!alive.has(k)) t.discard.add(k);
  t.observe(mkState({ talonCount: 0, discardCount: 20, myHand, counts: { p1: 2, p2: 2 } }));

  assert.ok(t.isOpponentHandCertain('p2'), 'предпосылка теста: рука соперника вычислена');
  const known = t.toCards(t.opponentKnownCards('p2'));
  assert.equal(known.length, 2);

  for (const suit of ['♠', '♥', '♦', '♣']) {
    for (let rank = 9; rank <= 14; rank++) {
      const card = c(rank, suit);
      const p = pOpponentBeats(card, t, 'p2', '♣');
      const exact = known.some((k) => beats(k, card, '♣')) ? 1 : 0;
      assert.equal(p, exact, `точная рука: p(${rank}${suit}) должно быть ${exact}`);
    }
  }
});

// -------------------------------------------------- подкидывание

test('expectedThrowIn: не больше места на столе и не меньше нуля', () => {
  const { tracker, myHand } = trackerWithVoidSpades();
  const state = mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(10, '♦'), defense: null }],
    myHand,
    counts: { p1: 6, p2: 4 },
    maxAttacksNow: 3,
    allowedThrowInRanks: [10],
  });
  const e = expectedThrowIn(state, tracker, 'p1');
  assert.ok(e >= 0 && e <= throwInRoom(state), `ожидание ${e} вне [0, ${throwInRoom(state)}]`);

  const closed = mkState({ attacker: 'p2', defender: 'p1', myHand, maxAttacksNow: 0 });
  assert.equal(expectedThrowIn(closed, tracker, 'p1'), 0, 'места нет — подкинуть не смогут');
});

test('throwInPlayers и разрешённые ранги читаются из состояния', () => {
  const state = mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(10, '♦'), defense: c(12, '♦') }],
    throwInPlayers: ['p2', 'p1'],
  });
  assert.deepEqual(throwInPlayersOf(state, 'p1'), ['p2'], 'ни я, ни защитник себе не подкидывают');
  assert.deepEqual(allowedThrowInRanksOf(state), [10, 12]);
  assert.equal(allowedThrowInRanksOf(mkState({})), null, 'пустой стол — можно заходить чем угодно');
});

// -------------------------------------------------- защита

test('pDefenseSurvives: в [0,1]; ноль, когда стол не отбить; единица, когда подкинуть нечего', () => {
  const { tracker } = trackerWithVoidSpades();
  const hand = [c(11, '♦'), c(9, '♥')];

  const hopeless = mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(14, '♠'), defense: null }],
    myHand: hand,
    counts: { p1: 2, p2: 4 },
    maxAttacksNow: 1,
  });
  assert.equal(pDefenseSurvives(hopeless.table, hand, tracker, hopeless), 0, 'бить туза пик нечем');

  const safe = mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(10, '♦'), defense: null }],
    myHand: hand,
    counts: { p1: 2, p2: 4 },
    maxAttacksNow: 0,
  });
  assert.equal(pDefenseSurvives(safe.table, hand, tracker, safe), 1, 'отбиваюсь, и подкинуть уже нельзя');

  const open = mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(10, '♦'), defense: null }],
    myHand: hand,
    counts: { p1: 2, p2: 4 },
    maxAttacksNow: 2,
    allowedThrowInRanks: [10],
  });
  const p = pDefenseSurvives(open.table, hand, tracker, open);
  assert.ok(inUnit(p), `вероятность ${p} вне [0,1]`);
  assert.ok(p <= 1);
});

// -------------------------------------------------- выбор атаки

test('bestAttackByPressure: сортирует по давлению и не трогает входной массив', () => {
  const { tracker } = trackerWithVoidSpades();
  const attacks = [
    { type: 'attack', card: c(10, '♠') },   // пик у соперника скорее всего нет
    { type: 'attack', card: c(10, '♦') },
  ];
  const snapshot = JSON.stringify(attacks);
  const ranked = bestAttackByPressure(attacks, tracker, mkState({ defender: 'p2' }));

  assert.equal(ranked.length, 2);
  assert.equal(JSON.stringify(attacks), snapshot, 'входной массив не должен меняться');
  assert.notEqual(ranked[0].action, undefined);
  for (const r of ranked) {
    assert.ok(inUnit(r.pBeat) && inUnit(r.pressure), 'оценки вне [0,1]');
  }
  assert.equal(ranked[0].card.suit, '♠', 'первой идёт карта масти, которой у соперника скорее всего нет');
  assert.ok(ranked[0].score >= ranked[1].score, 'массив отсортирован по убыванию оценки');
});

// -------------------------------------------------- чистота

test('функции ничего не мутируют: ни трекер, ни состояние, ни руку', () => {
  const { tracker, myHand } = trackerWithVoidSpades();
  const state = mkState({
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(10, '♦'), defense: null }],
    myHand,
    counts: { p1: 6, p2: 4 },
    maxAttacksNow: 2,
    allowedThrowInRanks: [10],
  });

  const snapTracker = JSON.stringify({
    discard: [...tracker.discard].sort(),
    onTable: [...tracker.onTable].sort(),
    myHand: [...tracker.myHand].sort(),
    taken: [...tracker.takenBy].map(([id, s]) => [id, [...s].sort()]),
    voids: [...tracker.voidSuits].map(([id, s]) => [id, [...s].sort()]),
    counts: [...tracker.handCounts],
    observations: tracker.observations,
  });
  const snapState = JSON.stringify(state);
  const snapHand = JSON.stringify(myHand);

  pOpponentBeats(c(10, '♠'), tracker, 'p2', '♣');
  pDefenseSurvives(state.table, myHand, tracker, state);
  expectedThrowIn(state, tracker, 'p1');
  bestAttackByPressure([{ type: 'attack', card: c(10, '♦') }], tracker, state);
  opponentView(tracker, 'p2');

  assert.equal(JSON.stringify({
    discard: [...tracker.discard].sort(),
    onTable: [...tracker.onTable].sort(),
    myHand: [...tracker.myHand].sort(),
    taken: [...tracker.takenBy].map(([id, s]) => [id, [...s].sort()]),
    voids: [...tracker.voidSuits].map(([id, s]) => [id, [...s].sort()]),
    counts: [...tracker.handCounts],
    observations: tracker.observations,
  }), snapTracker, 'трекер изменился');
  assert.equal(JSON.stringify(state), snapState, 'состояние изменилось');
  assert.equal(JSON.stringify(myHand), snapHand, 'рука изменилась');
});

test('opponentView возвращает копии карт — их изменение не портит память', () => {
  const { tracker } = trackerWithVoidSpades();
  const view = opponentView(tracker, 'p2');
  assert.ok(view.known.length >= 1);
  view.known[0].rank = 2;
  const again = opponentView(tracker, 'p2');
  assert.ok(again.known.every((c2) => c2.rank !== 2), 'память отдала ссылку на внутреннюю карту');
});
