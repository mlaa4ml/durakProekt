// Тесты анализа умного бота (issue #33, этап 3, раздел 5.1 плана).
// Запуск: node --test test/
//
// Здесь проверяются ЧИСТЫЕ функции из src/bots/analysis.js:
//   * `beats` обязан совпадать с правилом движка «масть старше / козырь бьёт некозырь»;
//   * `planDefense` — находит ли он отбой всего стола и берёт ли действительно
//     минимальную по цене раскладку (это ключ к решению «отбиваться или брать»);
//   * `unbeatableCards` / `suitControl` — не врут ли они, когда памяти нет
//     (пессимистичный режим) и когда память есть.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  beats,
  cardPower,
  handStrength,
  planDefense,
  unbeatableCards,
  suitControl,
  gamePhase,
} from '../src/bots/analysis.js';
import { CardTracker } from '../src/bots/memory.js';

const c = (rank, suit) => ({ rank, suit });
const T = '♣'; // козырь во всех тестах ниже

test('beats: та же масть — бьёт только старшая', () => {
  assert.equal(beats(c(10, '♠'), c(9, '♠'), T), true);
  assert.equal(beats(c(9, '♠'), c(10, '♠'), T), false);
  assert.equal(beats(c(9, '♠'), c(9, '♠'), T), false);
});

test('beats: козырь бьёт некозырь, но не наоборот', () => {
  assert.equal(beats(c(9, T), c(14, '♠'), T), true);
  assert.equal(beats(c(14, '♠'), c(9, T), T), false);
  assert.equal(beats(c(14, T), c(9, T), T), true);
});

test('cardPower: любой козырь дороже любого некозыря', () => {
  assert.ok(cardPower(c(9, T), T) > cardPower(c(14, '♠'), T));
  assert.ok(cardPower(c(14, '♠'), T) > cardPower(c(9, '♠'), T));
});

test('planDefense: пустой стол — защищать нечего', () => {
  const res = planDefense([], [c(9, '♠')], T);
  assert.equal(res.canDefendAll, true);
  assert.equal(res.cost, 0);
  assert.deepEqual(res.assignment, []);
});

test('planDefense: отбивает весь стол минимальной ценой (без козырей, если можно)', () => {
  const table = [
    { attack: c(9, '♠'), defense: null },
    { attack: c(9, '♥'), defense: null },
  ];
  const hand = [c(10, '♠'), c(14, '♠'), c(10, '♥'), c(9, T)];
  const res = planDefense(table, hand, T);
  assert.equal(res.canDefendAll, true);
  assert.equal(res.trumpsUsed, 0, 'козырь тратить не требовалось');
  const used = res.assignment.map((x) => `${x.card.rank}${x.card.suit}`).sort();
  assert.deepEqual(used, ['10♠', '10♥'].sort());
});

test('planDefense: одна карта не может закрыть две атаки — весь стол не отбить', () => {
  const table = [
    { attack: c(9, '♠'), defense: null },
    { attack: c(10, '♠'), defense: null },
  ];
  const hand = [c(11, '♠')];
  const res = planDefense(table, hand, T);
  assert.equal(res.canDefendAll, false);
  assert.equal(res.cost, Infinity);
  assert.equal(res.beatableCount, 2, 'каждая атака по отдельности бьётся, но карта одна');
});

test('planDefense: уже отбитые пары не учитываются', () => {
  const table = [
    { attack: c(9, '♠'), defense: c(10, '♠') },
    { attack: c(9, '♥'), defense: null },
  ];
  const res = planDefense(table, [c(10, '♥')], T);
  assert.equal(res.canDefendAll, true);
  assert.equal(res.assignment.length, 1);
  assert.equal(res.assignment[0].card.suit, '♥');
});

test('planDefense: козырь используется, только когда некозырного ответа нет', () => {
  const table = [{ attack: c(14, '♠'), defense: null }];
  const res = planDefense(table, [c(9, '♥'), c(9, T)], T);
  assert.equal(res.canDefendAll, true);
  assert.equal(res.trumpsUsed, 1);
});

test('unbeatableCards без памяти: непобиваемым считается только старший козырь', () => {
  const hand = [c(14, T), c(13, T), c(14, '♠')];
  const res = unbeatableCards(hand, T, null, { deckSize: 24 });
  assert.deepEqual(res.map((x) => `${x.rank}${x.suit}`), ['14♣']);
});

test('unbeatableCards с памятью: когда все козыри вышли, старшая в масти непобиваема', () => {
  const tracker = new CardTracker(24, T, c(9, T), 'p1', ['p1', 'p2']);
  // Все козыри, кроме моего 9♣, честно ушли в бито; старшие ♠ тоже.
  for (const r of [10, 11, 12, 13, 14]) tracker.discard.add(`${r}${T}`);
  for (const r of [11, 12, 13, 14]) tracker.discard.add(`${r}♠`);
  const hand = [c(10, '♠'), c(9, T)];
  for (const card of hand) tracker.myHand.add(`${card.rank}${card.suit}`);
  const res = unbeatableCards(hand, T, tracker).map((x) => `${x.rank}${x.suit}`).sort();
  assert.deepEqual(res, ['10♠', '9♣'].sort());
});

test('suitControl: держу старшую невышедшую в масти', () => {
  const tracker = new CardTracker(24, T, c(9, T), 'p1', ['p1', 'p2']);
  for (const r of [12, 13, 14]) tracker.discard.add(`${r}♠`);
  tracker.myHand.add('11♠');
  const res = suitControl([c(11, '♠')], '♠', tracker);
  assert.equal(res.controlled, true);
  assert.equal(res.myBest.rank, 11);
});

test('suitControl: не держу, если старшая ещё гуляет', () => {
  const res = suitControl([c(11, '♠')], '♠', null, { deckSize: 24 });
  assert.equal(res.controlled, false);
  assert.equal(res.theirBest.rank, 14);
});

test('handStrength: считает козыри, пары и не падает на пустой руке', () => {
  const s = handStrength([c(9, T), c(14, T), c(10, '♠'), c(10, '♥')], T, null, { deckSize: 24 });
  assert.equal(s.size, 4);
  assert.equal(s.trumpCount, 2);
  assert.equal(s.pairs, 1, 'десятки — одна пара');
  assert.equal(s.unbeatableCount, 1, 'непобиваем только козырный туз');

  const empty = handStrength([], T, null, { deckSize: 24 });
  assert.equal(empty.size, 0);
  assert.equal(empty.avgRank, 0);
});

test('gamePhase: дебют / миттельшпиль / эндшпиль', () => {
  const players = [{ id: 'p1', out: false }, { id: 'p2', out: false }];
  assert.equal(gamePhase({ talonCount: 20, players }), 'debut');
  assert.equal(gamePhase({ talonCount: 5, players }), 'middle');
  assert.equal(gamePhase({ talonCount: 0, players }), 'endgame');
});
