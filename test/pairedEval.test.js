// Тесты парного режима калибровки (issue #72, этап 7) — ДО прогона матрицы.
//
// Проверяем ровно то, что требует приёмка:
//   1) обе партии пары начинаются с ОДИНАКОВОЙ раздачи (одна и та же рука на месте, один козырь);
//   2) сторона определяется местом и направлением, а НЕ именем уровня: при одинаковом имени
//      `smart` с обеих сторон атрибуция остаётся честной (~50 %, а не 100 %);
//   3) кластерный 95 % ДИ считается по парам и честно помечается неточным, когда пар мало
//      или дисперсия пар нулевая.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playOneGame, seatLevels } from '../src/cli/matchCore.js';
import {
  mulberry32, hash32, pairSeed, dealFingerprint, seatBelongsToA,
  clusterShare, runPairedConfig,
} from '../src/cli/pairedEval.js';

test('playOneGame возвращает отпечаток начальной раздачи', () => {
  const rng = mulberry32(hash32('deal-check'));
  const res = playOneGame(seatLevels('simple', 'simple', 2, 0), 36, 2, false, { rng });
  assert.ok(res.initialDeal, 'initialDeal обязан присутствовать');
  assert.equal(res.initialDeal.seats.length, 2);
  for (const s of res.initialDeal.seats) {
    assert.equal(s.hand.length, 6, 'стартовая рука — 6 карт');
  }
  assert.ok(res.initialDeal.trumpSuit, 'козырная масть известна');
});

test('обе партии пары стартуют с одинаковой раздачи, меняются только стороны', () => {
  const seed = pairSeed(720072, 3, 36, 'all', 7);
  const fps = [];
  const seatLists = [];
  for (const direction of [0, 1]) {
    const levels = seatLevels('smart', 'simple', 3, direction);
    const res = playOneGame(levels, 36, 3, false, {
      rng: mulberry32(seed),
      throwInPolicy: 'all',
      seatOptions: levels.map(() => ({ solver: { maxNodes: 200, maxMs: Number.MAX_SAFE_INTEGER } })),
    });
    fps.push(dealFingerprint(res.initialDeal));
    seatLists.push(levels.slice());
  }
  assert.equal(fps[0], fps[1], 'раздача пары обязана совпасть карта в карту');
  assert.notDeepEqual(seatLists[0], seatLists[1], 'стороны в паре обязаны поменяться местами');
});

test('seatBelongsToA описывает СТОРОНУ, а не имя уровня', () => {
  assert.equal(seatBelongsToA(0, 0), true);
  assert.equal(seatBelongsToA(1, 0), false);
  assert.equal(seatBelongsToA(0, 1), false);
  assert.equal(seatBelongsToA(1, 1), true);
  // Ключевая ловушка: при одинаковых именах уровней сравнение levels[seat] === levelA
  // всегда истинно, а seatBelongsToA — нет.
  const levels = seatLevels('smart', 'smart', 4, 0);
  const byName = levels.filter((l) => l === 'smart').length;
  const bySide = levels.filter((_, seat) => seatBelongsToA(seat, 0)).length;
  assert.equal(byName, 4, 'по имени уровня все места выглядят «стороной A»');
  assert.equal(bySide, 2, 'по стороне их ровно половина');
});

test('атрибуция сторон при одинаковом уровне smart не даёт 100 %', () => {
  const row = runPairedConfig({
    players: 2, deckSize: 36, pairs: 3, seed: 4242,
    levelA: 'smart', levelB: 'smart',
    brainA: { solver: { maxNodes: 100, maxMs: Number.MAX_SAFE_INTEGER } },
    brainB: { solver: { maxNodes: 100, maxMs: Number.MAX_SAFE_INTEGER } },
  });
  assert.equal(row.planned, 6, 'три пары — шесть партий');
  assert.equal(row.errors, 0);
  assert.equal(row.stuck, 0);
  assert.equal(row.dealMismatch, 0, 'раздачи внутри пар совпали');
  assert.equal(row.durakA + row.durakB + row.draws, row.completed);
  if (row.durakPct != null) {
    assert.ok(row.durakPct > 0 && row.durakPct < 100,
      `доля «дурака» A при одинаковом уровне не должна быть 0/100 %, получено ${row.durakPct}`);
  }
});

test('пары одинакового бота дают одинаковые раздачи и симметричный результат', () => {
  const row = runPairedConfig({
    players: 2, deckSize: 24, pairs: 4, seed: 777,
    levelA: 'simple', levelB: 'simple',
  });
  for (const c of row.clusters) {
    assert.ok(c.fingerprint, 'у каждой пары есть отпечаток раздачи');
    assert.equal(c.games.length, 2);
  }
  // Один и тот же детерминированный бот с обеих сторон: в паре ровно один «дурак» у A
  // и один у B, если обе партии результативны.
  for (const c of row.clusters) {
    if (c.decided === 2) assert.equal(c.durakA, 1, 'симметричная пара даёт ровно одного «дурака» A');
  }
});

test('clusterShare считает ДИ по парам и честно помечает неточный случай', () => {
  const symmetric = [
    { durakA: 1, decided: 2 }, { durakA: 1, decided: 2 }, { durakA: 1, decided: 2 },
  ];
  const s = clusterShare(symmetric);
  assert.equal(s.durakPct, 50);
  assert.equal(s.exact, false, 'нулевая дисперсия пар — точный ДИ не заявляем');
  assert.equal(s.ci95, 0);

  const mixed = [
    { durakA: 2, decided: 2 }, { durakA: 0, decided: 2 },
    { durakA: 1, decided: 2 }, { durakA: 2, decided: 2 },
  ];
  const m = clusterShare(mixed);
  assert.equal(m.pairsUsed, 4);
  assert.equal(m.exact, true);
  assert.ok(m.ci95 > 0, 'при разбросе по парам ДИ положителен');
  // Кластерный ДИ по парам шире наивного биномиального по партиям.
  const n = 8;
  const p = 5 / 8;
  const naive = 1.96 * Math.sqrt((p * (1 - p)) / n) * 100;
  assert.ok(m.ci95 > naive, `кластерный ДИ (${m.ci95}) обязан быть шире наивного (${naive.toFixed(2)})`);

  const empty = clusterShare([{ durakA: 0, decided: 0 }]);
  assert.equal(empty.durakPct, null);
  assert.equal(empty.exact, false);
});

test('pairSeed детерминирован и различает конфигурации', () => {
  assert.equal(pairSeed(1, 2, 36, 'all', 0), pairSeed(1, 2, 36, 'all', 0));
  assert.notEqual(pairSeed(1, 2, 36, 'all', 0), pairSeed(1, 2, 36, 'all', 1));
  assert.notEqual(pairSeed(1, 2, 36, 'all', 0), pairSeed(1, 2, 36, 'neighbors', 0));
  assert.notEqual(pairSeed(1, 2, 36, 'all', 0), pairSeed(1, 3, 36, 'all', 0));
});
