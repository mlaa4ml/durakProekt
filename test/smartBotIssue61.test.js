// Тесты правил умного бота, добавленных по issue #61 («ещё исправления бота»).
// Запуск: node --test test/
//
// Что проверяем (каждый пункт — одна из жалоб из issue):
//   1. соперник объявил «беру» -> бот подкидывает НЕкозырной картой, а козырь оставляет себе
//      (`keepTrumpWhenOpponentTakes`);
//   2. рука соперника восстановлена памятью точно -> бот ходит картой, которой сопернику
//      не отбиться, а если такой нет — той, отбой которой обойдётся сопернику дороже всего,
//      вместо «просто самой дешёвой по очереди» (`useKnownHandAttack`);
//   3. на столе ещё нет ни одной побитой карты и дешёвый перевод не дороже защиты ->
//      бот переводит, а не отбивается (`preferTransferWhenCheap`).
//
// Состояния собираются вручную в формате `game.getState(meId)` — как в test/estimate.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SmartBot, SMART_PROFILE } from '../src/bots/smartBot.js';

const c = (rank, suit) => ({ rank, suit });

function mkState({
  phase = 'need-attack',
  trumpSuit = '♣',
  trumpCard = c(6, '♣'),
  talonCount = 10,
  discardCount = 0,
  table = [],
  tableGoingToDefender = false,
  attacker = 'p1',
  defender = 'p2',
  myHand = [],
  counts = { p1: 6, p2: 6 },
  me = 'p1',
  rules = { deckSize: 36, numPlayers: 2, throwInPolicy: 'all', maxTableAttacks: 6 },
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
      out: false,
      finishRank: null,
      hand: id === me ? myHand : undefined,
    })),
    rules,
    durak: null,
    finished: false,
  };
}

/**
 * Бот с заданным профилем. `known` — рука соперника, которую память якобы восстановила
 * ТОЧНО: подменяем только `_opponentKnownHand`, всё остальное (трекер, политика) настоящее.
 */
function mkBot(state, profilePatch = {}, known = null) {
  const bot = new SmartBot({ profile: { ...SMART_PROFILE, ...profilePatch }, meId: 'p1' });
  bot.observe(state, 'p1');
  if (known) bot._opponentKnownHand = () => known.map((x) => ({ ...x }));
  return bot;
}

// -------------------------------------------------- 1. соперник забирает стол

test('соперник забирает стол — подкидываем некозырной, козырь остаётся у меня', () => {
  const myHand = [c(10, '♦'), c(10, '♣'), c(7, '♦')];
  const state = mkState({
    phase: 'throw-in',
    table: [{ attack: c(10, '♠'), defense: null }],
    tableGoingToDefender: true,
    myHand,
    counts: { p1: 3, p2: 5 },
  });
  const legal = [
    { type: 'attack', card: c(10, '♦') },
    { type: 'attack', card: c(10, '♣') },   // козырь
    { type: 'pass' },
  ];
  const { action } = mkBot(state, {}, null).decide(state, 'p1', legal);
  assert.equal(action.type, 'attack');
  assert.notEqual(action.card.suit, '♣', 'козырь забирающему сопернику дарить нельзя');
  assert.deepEqual(action.card, c(10, '♦'));
});

test('соперник забирает стол, а подкинуть можно только козырем — бот не падает и ходит легально', () => {
  const myHand = [c(10, '♣'), c(7, '♦')];
  const state = mkState({
    phase: 'throw-in',
    table: [{ attack: c(10, '♠'), defense: null }],
    tableGoingToDefender: true,
    myHand,
    counts: { p1: 2, p2: 5 },
  });
  const legal = [{ type: 'attack', card: c(10, '♣') }, { type: 'pass' }];
  const { action } = mkBot(state, {}, null).decide(state, 'p1', legal);
  assert.ok(legal.includes(action), 'действие обязано быть из списка легальных');
});

test('флаг выключен — старое поведение (может уйти и козырь)', () => {
  const myHand = [c(10, '♦'), c(9, '♣')];
  const state = mkState({
    phase: 'throw-in',
    table: [{ attack: c(9, '♠'), defense: null }],
    tableGoingToDefender: true,
    myHand,
    counts: { p1: 2, p2: 5 },
  });
  const legal = [
    { type: 'attack', card: c(9, '♣') },   // козырь дешевле по рангу, но это козырь
    { type: 'attack', card: c(10, '♦') },
    { type: 'pass' },
  ];
  const on = mkBot(state, { keepTrumpWhenOpponentTakes: true }).decide(state, 'p1', legal);
  assert.notEqual(on.action.card.suit, '♣');
});

// -------------------------------------------------- 2. знание руки соперника при ходе

test('знаю руку соперника — хожу картой, которой он не отобьётся (даже когда карт у него много)', () => {
  const myHand = [c(6, '♦'), c(9, '♥'), c(14, '♠')];
  const known = [c(7, '♦'), c(10, '♠'), c(6, '♠'), c(8, '♦')]; // ни червей, ни козырей
  const state = mkState({ myHand, counts: { p1: 3, p2: 4 } });
  const legal = [
    { type: 'attack', card: c(6, '♦') },
    { type: 'attack', card: c(9, '♥') },
    { type: 'attack', card: c(14, '♠') },
  ];
  const { action } = mkBot(state, {}, known).decide(state, 'p1', legal);
  assert.deepEqual(action.card, c(9, '♥'), 'самая дешёвая из «неотбиваемых», а не просто самая дешёвая');
});

test('знаю руку соперника, отбиться он может на всё — заставляю тратить дорогую карту', () => {
  const myHand = [c(6, '♦'), c(9, '♠')];
  const known = [c(7, '♦'), c(14, '♠'), c(6, '♣')];
  const state = mkState({ myHand, counts: { p1: 2, p2: 3 } });
  const legal = [
    { type: 'attack', card: c(6, '♦') },   // побьёт семёркой — почти бесплатно
    { type: 'attack', card: c(9, '♠') },   // побьёт только тузом или козырем
  ];
  const { action } = mkBot(state, {}, known).decide(state, 'p1', legal);
  assert.deepEqual(action.card, c(9, '♠'));

  // С выключенным флагом — прежнее поведение «самая дешёвая карта».
  const off = mkBot(state, { useKnownHandAttack: false }, known).decide(state, 'p1', legal);
  assert.deepEqual(off.action.card, c(6, '♦'));
});

test('знание руки не используется, когда соперник уже забирает стол', () => {
  const myHand = [c(6, '♦'), c(9, '♠')];
  const known = [c(7, '♦'), c(14, '♠')];
  const state = mkState({
    phase: 'throw-in',
    table: [{ attack: c(9, '♥'), defense: null }],
    tableGoingToDefender: true,
    myHand,
    counts: { p1: 2, p2: 4 },
  });
  const legal = [
    { type: 'attack', card: c(6, '♦') },
    { type: 'attack', card: c(9, '♠') },
    { type: 'pass' },
  ];
  const { action } = mkBot(state, {}, known).decide(state, 'p1', legal);
  assert.deepEqual(action.card, c(6, '♦'), 'забирающему грузим самое дешёвое');
});

// -------------------------------------------------- 3. перевод «в первый момент»

test('дешёвый перевод не дороже защиты — перевожу, а не отбиваюсь', () => {
  const myHand = [c(9, '♦'), c(12, '♠'), c(13, '♥')];
  const state = mkState({
    phase: 'defend',
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(9, '♠'), defense: null }],
    myHand,
    counts: { p1: 3, p2: 4 },
  });
  const legal = [
    { type: 'defend', card: c(12, '♠'), against: c(9, '♠') },
    { type: 'transfer', cards: [c(9, '♦')] },
    { type: 'take' },
  ];
  const on = mkBot(state, {}).decide(state, 'p1', legal);
  assert.equal(on.action.type, 'transfer');

  const off = mkBot(state, { preferTransferWhenCheap: false }).decide(state, 'p1', legal);
  assert.equal(off.action.type, 'defend', 'без флага бот по-прежнему отбивается');
});

test('перевод дороже защиты — отбиваемся', () => {
  const myHand = [c(13, '♦'), c(13, '♠'), c(7, '♥')];
  const state = mkState({
    phase: 'defend',
    attacker: 'p2',
    defender: 'p1',
    table: [{ attack: c(12, '♠'), defense: null }],
    myHand,
    counts: { p1: 3, p2: 4 },
  });
  const legal = [
    { type: 'defend', card: c(13, '♠'), against: c(12, '♠') },
    { type: 'transfer', cards: [c(12, '♦'), c(12, '♥')] }, // формально дороже одной карты защиты
    { type: 'take' },
  ];
  const { action } = mkBot(state, {}).decide(state, 'p1', legal);
  assert.equal(action.type, 'defend');
});

test('на столе уже есть побитая карта — правило перевода не применяется', () => {
  const myHand = [c(9, '♦'), c(12, '♠')];
  const state = mkState({
    phase: 'defend',
    attacker: 'p2',
    defender: 'p1',
    table: [
      { attack: c(8, '♠'), defense: c(11, '♠') },
      { attack: c(9, '♠'), defense: null },
    ],
    myHand,
    counts: { p1: 2, p2: 4 },
  });
  const legal = [
    { type: 'defend', card: c(12, '♠'), against: c(9, '♠') },
    { type: 'transfer', cards: [c(9, '♦')] },
    { type: 'take' },
  ];
  const { action } = mkBot(state, {}).decide(state, 'p1', legal);
  assert.equal(action.type, 'defend');
});
