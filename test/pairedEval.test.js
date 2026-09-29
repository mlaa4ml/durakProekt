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

test('задержки решений и статистика решателя собираются только по opt-in', () => {
  const levels = seatLevels('smart', 'smart', 2, 0);
  const plain = playOneGame(levels, 36, 2, false, { rng: mulberry32(hash32('timing-off')) });
  assert.equal(plain.timing, undefined,
    'без recordDecisionTiming результат обязан совпадать с эталоном эквивалентности этапа 6');

  const res = playOneGame(levels, 36, 2, false, {
    rng: mulberry32(hash32('timing-off')),
    recordDecisionTiming: true,
    seatOptions: levels.map(() => ({ solver: { maxNodes: 500, maxMs: Number.MAX_SAFE_INTEGER } })),
  });
  assert.ok(res.timing, 'timing обязан присутствовать при recordDecisionTiming');
  assert.equal(res.timing.seats.length, 2);
  assert.ok(res.timing.decisions > 0, 'решения должны быть посчитаны');
  assert.equal(
    res.timing.decisions,
    res.timing.seats.reduce((a, s) => a + s.decisions, 0),
    'сумма решений по местам равна общему числу решений',
  );
  for (const s of res.timing.seats) {
    assert.ok(s.avgMs === null || s.avgMs >= 0, 'средняя задержка неотрицательна');
    assert.ok(s.maxMs >= 0);
    assert.ok(s.solver, 'у smart-места обязана быть статистика решателя');
    assert.ok(s.solver.timedOut <= s.solver.calls, 'таймаутов не больше, чем вызовов решателя');
  }
  assert.equal(res.timing.solverTimedOut,
    res.timing.seats.reduce((a, s) => a + (s.solver ? s.solver.timedOut : 0), 0));
  // Задержки — это измерение прогонщика, а не исход партии: сами исходы не затронуты.
  assert.equal(typeof res.durakSeat, 'number');
});

test('у simple-места статистики решателя нет, но задержки считаются', () => {
  const levels = seatLevels('smart', 'simple', 2, 0);
  const res = playOneGame(levels, 36, 2, false, {
    rng: mulberry32(hash32('timing-simple')), recordDecisionTiming: true,
  });
  const simpleSeat = res.timing.seats.find((s) => s.level === 'simple');
  assert.ok(simpleSeat, 'место simple должно быть в сводке');
  assert.equal(simpleSeat.solver, null, 'у simpleBot решателя нет — null, а не выдуманные нули');
  assert.ok(simpleSeat.decisions > 0);
});

test('runPairedConfig публикует задержки и таймауты бюджета решателя отдельно от исходов', () => {
  const row = runPairedConfig({
    players: 2, deckSize: 36, pairs: 2, seed: 4242,
    levelA: 'smart', levelB: 'smart',
    brainA: { solver: { maxNodes: 500, maxMs: Number.MAX_SAFE_INTEGER } },
    brainB: { solver: { maxNodes: 500, maxMs: Number.MAX_SAFE_INTEGER } },
  });
  const lat = row.latency;
  assert.ok(lat, 'блок latency обязателен в результате конфигурации');
  assert.ok(lat.decisions > 0);
  assert.equal(lat.decisions, lat.sideA.decisions + lat.sideB.decisions,
    'решения разнесены по сторонам через seatBelongsToA, а не по именам уровней');
  assert.ok(lat.sideA.decisions > 0 && lat.sideB.decisions > 0);
  assert.equal(lat.solverTimedOut, lat.sideA.solverTimedOut + lat.sideB.solverTimedOut);
  assert.ok(lat.solverTimedOut <= lat.solverCalls);
  assert.ok(lat.solverNodes >= 0 && lat.maxDecisionMs >= 0);
  if (lat.solverCalls > 0) {
    assert.ok(lat.solverTimeoutPct !== null && lat.solverTimeoutPct >= 0 && lat.solverTimeoutPct <= 100);
  }
  // Исходы считаются по партиям и не зависят от измерения задержек.
  assert.equal(row.planned, 4);
  assert.equal(row.decided + row.draws + row.stuck + row.errors, row.planned);
});

test('крошечный бюджет узлов даёт ненулевые таймауты решателя и они видны в latency', () => {
  const tiny = { solver: { maxNodes: 1, maxMs: Number.MAX_SAFE_INTEGER } };
  const row = runPairedConfig({
    players: 2, deckSize: 24, pairs: 3, seed: 99,
    levelA: 'smart', levelB: 'smart', brainA: tiny, brainB: tiny,
  });
  assert.ok(row.latency.solverCalls > 0, 'в дуэли 2×24 решатель обязан вызываться');
  assert.ok(row.latency.solverTimedOut > 0,
    'при maxNodes=1 бюджет исчерпывается — таймауты обязаны быть учтены, а не потеряны');
  assert.ok(row.latency.solverTimeoutPct > 0);
  assert.equal(row.errors, 0, 'исчерпание бюджета — не ошибка прогона');
});

test('playOneGame возвращает отпечаток начальной раздачи', () => {
  const rng = mulberry32(hash32('deal-check'));
  const plain = playOneGame(seatLevels('simple', 'simple', 2, 0), 36, 2, false, { rng: mulberry32(hash32('deal-check')) });
  assert.equal(plain.initialDeal, undefined,
    'без recordInitialDeal результат не меняется — эталон эквивалентности этапа 6 обязан совпадать');

  const res = playOneGame(seatLevels('simple', 'simple', 2, 0), 36, 2, false, { rng, recordInitialDeal: true });
  assert.ok(res.initialDeal, 'initialDeal обязан присутствовать при recordInitialDeal');
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
      recordInitialDeal: true,
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
