// Парная (paired) калибровка — этап 7 issue #72.
//
// Зачем отдельный модуль, а не второй прогонщик: игровой цикл остаётся ОДИН —
// `playOneGame` из ./matchCore.js. Здесь только надстройка над ним:
//   * одна и та же раздача играется ДВАЖДЫ с перестановкой сторон (пара);
//   * независимая единица наблюдения — ПАРА, а не партия, поэтому 95 % ДИ считается
//     кластерной оценкой дисперсии отношения сумм, а не биномиальной формулой по партиям;
//   * сторона определяется местом и направлением (seatBelongsToA), а НЕ именем уровня:
//     в old-smart vs new-smart оба уровня называются `smart`, и сравнение имён дало бы
//     100 % «дурака» у A вместо честных ~50 %;
//   * место может обслуживаться фабрикой мозга из ДРУГОГО checkout (старая версия бота) —
//     через options.seatBrainFactories у playOneGame. Движок всегда локальный.
//
// Ничего из этого не меняет поведение ботов: это измерительная обвязка.

import { seatLevels, playOneGame } from './matchCore.js';

// ---------------------------------------------------------------------------
// Детерминированный PRNG (тот же, что в scripts/evalBots.js)
// ---------------------------------------------------------------------------

// mulberry32 — короткий генератор с 32-битным состоянием; с одним seed прогон повторяется
// карта в карту.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a: строка -> 32-битное число. Seed пары не зависит от порядка конфигураций.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Принадлежит ли место стороне A при данном direction (совпадает с раскладкой seatLevels).
export function seatBelongsToA(seat, direction) {
  return (seat % 2 === 0) === (direction === 0);
}

// Seed конкретной ПАРЫ: обе партии пары берут его целиком, а не два последовательных значения,
// иначе раздачи в паре разойдутся и сравнение перестанет быть парным.
export function pairSeed(master, players, deckSize, throwInPolicy, pairIndex) {
  return hash32(`${master}|${players}x${deckSize}|${throwInPolicy}|${pairIndex}`);
}

// Отпечаток начальной раздачи: козырь + руки по местам. Используется для проверки того,
// что обе партии пары действительно начались с одной раздачи.
export function dealFingerprint(initialDeal) {
  if (!initialDeal) return null;
  const seats = initialDeal.seats.map((s) => `${s.seat}:${s.hand.join(',')}`).join('|');
  return `${initialDeal.trumpCard ?? initialDeal.trumpSuit}#${initialDeal.talonCount}#${seats}`;
}

// ---------------------------------------------------------------------------
// Кластерный 95 % ДИ: единица — пара
// ---------------------------------------------------------------------------

const Z95 = 1.96;

function round2(x) {
  if (x == null || !Number.isFinite(x)) return null;
  const v = Math.round(x * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
}

/**
 * Оценка доли «дурака» у A как отношения сумм по кластерам-парам.
 *
 * clusters: [{ durakA, decided }, ...] — по одной записи на пару.
 * Дисперсия отношения (линеаризация): var = m/(m-1) · Σ(xᵢ − p·nᵢ)² / (Σnᵢ)².
 *
 * exact=false означает «точный ДИ не заявляем»: меньше двух результативных пар
 * или нулевая эмпирическая дисперсия пар (типично для контрольных old/self прогонов,
 * где обе партии пары всегда дают по одному «дураку» каждой стороне).
 */
export function clusterShare(clusters) {
  const used = clusters.filter((c) => c.decided > 0);
  const sumX = used.reduce((a, c) => a + c.durakA, 0);
  const sumN = used.reduce((a, c) => a + c.decided, 0);
  if (!sumN) return { durakPct: null, se: null, ci95: null, pairsUsed: used.length, exact: false };
  const p = sumX / sumN;
  const m = used.length;
  let ss = 0;
  for (const c of used) ss += (c.durakA - p * c.decided) ** 2;
  const exact = m >= 2 && ss > 0;
  const variance = m >= 2 ? (m / (m - 1)) * (ss / (sumN * sumN)) : null;
  const se = variance == null ? null : Math.sqrt(variance);
  return {
    durakPct: round2(p * 100),
    se: round2(se == null ? null : se * 100),
    ci95: round2(se == null ? null : Z95 * se * 100),
    pairsUsed: m,
    exact,
  };
}

// ---------------------------------------------------------------------------
// Задержки решений и бюджет решателя (#71) — отдельно от исходов
// ---------------------------------------------------------------------------

/** Складывает сводку timing одной партии в накопитель конфигурации. */
export function accumulateTiming(acc, timing, direction) {
  if (!acc || !timing) return acc;
  acc.decisions += timing.decisions;
  acc.totalMs += timing.totalMs;
  if (timing.maxMs > acc.maxMs) acc.maxMs = timing.maxMs;
  for (const s of timing.seats) {
    const side = seatBelongsToA(s.seat, direction) ? acc.sideA : acc.sideB;
    side.decisions += s.decisions;
    side.totalMs += s.totalMs;
    if (s.maxMs > side.maxMs) side.maxMs = s.maxMs;
    if (s.solver) {
      side.solverCalls += s.solver.calls;
      side.solverTimedOut += s.solver.timedOut;
      acc.solverCalls += s.solver.calls;
      acc.solverTimedOut += s.solver.timedOut;
      acc.solverUnusable += s.solver.unusable;
      acc.solverUsed += s.solver.used;
      acc.solverNodes += s.solver.nodes;
      acc.solverMs += s.solver.ms;
    }
  }
  return acc;
}

function sideLatency(side) {
  return {
    decisions: side.decisions,
    avgMs: side.decisions ? round3(side.totalMs / side.decisions) : null,
    maxMs: round3(side.maxMs),
    solverCalls: side.solverCalls,
    solverTimedOut: side.solverTimedOut,
    solverTimeoutPct: side.solverCalls
      ? round2((side.solverTimedOut / side.solverCalls) * 100) : null,
  };
}

/** Итоговый блок latency конфигурации. Это НЕ SLA браузера/worker из #71. */
export function summarizeLatency(acc) {
  return {
    decisions: acc.decisions,
    avgDecisionMs: acc.decisions ? round3(acc.totalMs / acc.decisions) : null,
    maxDecisionMs: round3(acc.maxMs),
    totalDecisionMs: round3(acc.totalMs),
    solverCalls: acc.solverCalls,
    solverUsed: acc.solverUsed,
    solverUnusable: acc.solverUnusable,
    // Таймаут решателя = исчерпан детерминированный бюджет (maxNodes/maxMs) самого бота,
    // а не wall-clock прогонщика. При maxMs=MAX_SAFE_INTEGER это чисто узловой бюджет.
    solverTimedOut: acc.solverTimedOut,
    solverTimeoutPct: acc.solverCalls
      ? round2((acc.solverTimedOut / acc.solverCalls) * 100) : null,
    solverNodes: acc.solverNodes,
    solverMs: round3(acc.solverMs),
    avgSolverMsPerCall: acc.solverCalls ? round3(acc.solverMs / acc.solverCalls) : null,
    sideA: sideLatency(acc.sideA),
    sideB: sideLatency(acc.sideB),
  };
}

function round3(x) {
  if (x == null || !Number.isFinite(x)) return null;
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
}

// ---------------------------------------------------------------------------
// Прогон одной конфигурации парами
// ---------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {number} o.players
 * @param {number} o.deckSize
 * @param {string} [o.throwInPolicy='all']
 * @param {number} o.pairs            число независимых раздач (партий будет вдвое больше)
 * @param {number} o.seed             master seed
 * @param {string} [o.levelA='smart']
 * @param {string} [o.levelB='smart']
 * @param {object} [o.brainA]         опции createBotBrain для стороны A (profile, solver)
 * @param {object} [o.brainB]
 * @param {Function} [o.factoryA]     фабрика мозга стороны A (по умолчанию локальная)
 * @param {Function} [o.factoryB]
 * @param {number} [o.maxSteps]
 */
export function runPairedConfig(o) {
  const {
    players, deckSize, pairs, seed,
    throwInPolicy = 'all',
    levelA = 'smart', levelB = 'smart',
    brainA = {}, brainB = {},
    factoryA = null, factoryB = null,
    maxSteps,
  } = o;

  const clusters = [];
  const problems = [];
  let planned = 0;
  let completed = 0;
  let errors = 0;
  let stuck = 0;
  let draws = 0;
  let durakA = 0;
  let durakB = 0;
  let dealMismatch = 0;
  let totalSteps = 0;
  let totalMs = 0;
  let maxMsGame = 0;

  // Задержки и таймауты решателя (issue #72 этап 7 / #71) — считаются ОТДЕЛЬНО от исходов
  // и не участвуют в durakPct/CI. Единица — одно решение бота (brain.decide), а не партия.
  const latAcc = {
    decisions: 0, totalMs: 0, maxMs: 0,
    solverCalls: 0, solverTimedOut: 0, solverUnusable: 0, solverUsed: 0,
    solverNodes: 0, solverMs: 0,
    sideA: { decisions: 0, totalMs: 0, maxMs: 0, solverCalls: 0, solverTimedOut: 0 },
    sideB: { decisions: 0, totalMs: 0, maxMs: 0, solverCalls: 0, solverTimedOut: 0 },
  };

  for (let i = 0; i < pairs; i++) {
    const seedValue = pairSeed(seed, players, deckSize, throwInPolicy, i);
    const cluster = { pair: i, seed: seedValue, durakA: 0, decided: 0, games: [] };
    let fingerprint = null;

    for (const direction of [0, 1]) {
      planned++;
      const levels = seatLevels(levelA, levelB, players, direction);
      const seatOptions = levels.map((_, seat) => (seatBelongsToA(seat, direction) ? brainA : brainB));
      const seatBrainFactories = (factoryA || factoryB)
        ? levels.map((_, seat) => (seatBelongsToA(seat, direction) ? factoryA : factoryB))
        : undefined;
      const rng = mulberry32(seedValue); // ОДИН и тот же seed на обе партии пары
      const startedAt = Date.now();
      try {
        const res = playOneGame(levels, deckSize, players, false, {
                    rng, throwInPolicy, seatOptions, seatBrainFactories, maxSteps,
          recordInitialDeal: true, // нужен отпечаток раздачи для проверки парности
          recordDecisionTiming: true, // задержки решений + solverStats по местам (#71)
        });
        accumulateTiming(latAcc, res.timing, direction);
        const ms = Date.now() - startedAt;
        totalMs += ms;
        if (ms > maxMsGame) maxMsGame = ms;
        completed++;
        totalSteps += res.steps;

        const fp = dealFingerprint(res.initialDeal);
        if (fingerprint === null) fingerprint = fp;
        else if (fp !== fingerprint) {
          dealMismatch++;
          problems.push({ kind: 'deal-mismatch', pair: i, seed: seedValue, direction });
        }

        let outcome;
        if (res.stuck) {
          stuck++;
          outcome = 'unfinished';
          problems.push({ kind: 'stuck', pair: i, seed: seedValue, direction, steps: res.steps });
        } else if (res.durakSeat < 0) {
          draws++;
          outcome = 'draw';
        } else if (seatBelongsToA(res.durakSeat, direction)) {
          durakA++; cluster.durakA++; cluster.decided++;
          outcome = 'durakA';
        } else {
          durakB++; cluster.decided++;
          outcome = 'durakB';
        }
        cluster.games.push({ direction, outcome, steps: res.steps, ms });
      } catch (e) {
        errors++;
        problems.push({ kind: 'error', pair: i, seed: seedValue, direction, message: e.message });
        cluster.games.push({ direction, outcome: 'error', message: e.message });
      }
    }
    cluster.fingerprint = fingerprint;
    clusters.push(cluster);
  }

  const stats = clusterShare(clusters);
  return {
    players,
    deckSize,
    throwInPolicy,
    pairs,
    planned,
    completed,
    unfinished: planned - completed + stuck,
    decided: durakA + durakB,
    durakA,
    durakB,
    draws,
    errors,
    stuck,
    dealMismatch,
    durakPct: stats.durakPct,
    se: stats.se,
    ci95: stats.ci95,
    ciExact: stats.exact,
    pairsUsed: stats.pairsUsed,
    // Доля проигрышей A среди ВСЕХ запланированных партий — знаменатель публикуется явно.
    durakPctOfPlanned: planned ? round2((durakA / planned) * 100) : null,
    avgSteps: completed ? round2(totalSteps / completed) : null,
    // Задержки — отдельно от детерминированных исходов (это не SLA клиента).
    avgMs: completed ? round2(totalMs / completed) : null,
    maxMs: maxMsGame,
    // Задержки решений и таймауты решателя — отдельным блоком, не смешиваются с исходами.
    latency: summarizeLatency(latAcc),
    problems,
    clusters,
  };
}
