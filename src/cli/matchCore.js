// Общее ядро очных матчей ботов.
//
// Зачем (issue #46, этап 1 roadmap): раскладка уровней по местам и прогон одной партии
// нужны сразу двум инструментам — `src/cli/botMatch.js` (одна конфигурация, текстовый отчёт)
// и `scripts/evalBots.js` (матрица конфигураций, CI95, JSON, baseline). Копировать этот код
// нельзя: если два бенчмарка разойдутся хотя бы в порядке опроса игроков, их цифры станет
// невозможно сравнивать. Поэтому логика живёт здесь, а оба CLI её импортируют.
//
// Поведение ровно то же, что было в botMatch.js до выноса:
//   * по одному действию за шаг цикла (после каждого действия состояние переоценивается);
//   * боту передаётся ТОЛЬКО game.getState(botId) — маскированное состояние без чужих рук;
//   * предохранитель MAX_STEPS ловит зависания.
//
// Новое (нужно для воспроизводимых прогонов): через options можно передать свой rng
// (третий аргумент конструктора DurakGame — см. src/game.js) и throwInPolicy.
// `src/game.js` при этом не меняется — он уже принимает rng.

import { DurakGame } from '../game.js';
import { cardToString } from '../deck.js';
import { createBotBrain, botLevelLabel, applyObservedAction } from '../bots/index.js';
import { GameRecorder } from '../diagnostics/replay.js';
import { isDeepStrictEqual } from 'node:util';
import { performance } from 'node:perf_hooks';

export const MAX_STEPS = 5000;

export function actionToString(action) {
  if (!action) return '—';
  switch (action.type) {
    case 'attack':
      return `атака ${cardToString(action.card)}`;
    case 'defend':
      return `отбой ${cardToString(action.card)}`;
    case 'transfer':
      return `перевод ${(action.cards || []).map(cardToString).join(' ')}`;
    case 'take':
      return 'берёт карты';
    case 'pass':
      return 'пас';
    default:
      return action.type;
  }
}

// Раскладка уровней по местам.
// direction = 0: места 0,2,4... -> levelA; 1,3,5... -> levelB.
// direction = 1: наоборот. Так A успевает поиграть и первым, и вторым.
export function seatLevels(levelA, levelB, numPlayers, direction) {
  return Array.from({ length: numPlayers }, (_, i) => {
    const first = i % 2 === 0;
    const aFirst = direction === 0;
    return first === aFirst ? levelA : levelB;
  });
}

/**
 * Одна партия.
 *
 * @param {string[]} levels          уровень бота для каждого места
 * @param {number}   deckSize        24 | 36 | 52
 * @param {number}   numPlayers      2..6
 * @param {boolean}  collectTrace    собирать ли пошаговый разбор решений (--verbose)
 * @param {object}   [options]       { rng?: () => number, throwInPolicy?: string,
 *                                     seatOptions?: object[]  (опции createBotBrain по местам: profile, solver),
 *                                     maxSteps?: number }
 * @returns {{ durakSeat: number, steps: number, stuck: boolean, trace: object[],
 *             log: string[], finishedOrder: string[] }}
 */
export function playOneGame(levels, deckSize, numPlayers, collectTrace, options = {}) {
  const rng = typeof options.rng === 'function' ? options.rng : Math.random;
  const maxSteps = Number.isFinite(options.maxSteps) ? options.maxSteps : MAX_STEPS;

  const rules = { numPlayers, deckSize };
  if (options.throwInPolicy) rules.throwInPolicy = options.throwInPolicy;

  const players = Array.from({ length: numPlayers }, (_, i) => ({
    id: `p${i + 1}`,
    name: `p${i + 1} (${botLevelLabel(levels[i])})`,
  }));
  const game = new DurakGame(players, rules, rng);
  // Privileged benchmark callback, never passed to a brain.
  options.onInitialDeal?.(structuredClone({
    rules: game.rules,
    hands: game.players.map(p => p.hand),
    deck: game.deck,
    trumpCard: game.trumpCard,
    attackerIndex: game.attackerIndex,
  }));
  const metrics = options.measure ? {
    decisionMsBySeat: players.map(() => []),
    solverBySeat: [],
  } : null;

  const brains = new Map();
  players.forEach((p, i) => {
            // Version factories vary by SIDE, not by level name (both may be "smart").
    const factory = options.seatFactories?.[i] ?? createBotBrain;
    const brain = factory(levels[i], {
      explain: collectTrace, trace: collectTrace || !!options.recordDiagnostic,
      ...(options.seatOptions && options.seatOptions[i]),
    });
    brain.reset(game.getState(p.id), p.id);
    brains.set(p.id, brain);
  });

  // Opt-in: ordinary benchmarks do not retain an archive of private hands.
  // Callers must store the result in protected storage, never in a public live log.
  const recorder = options.recordDiagnostic ? new GameRecorder(game, {
    participants: players.map((p, i) => ({
      playerId: p.id, kind: 'bot', level: brains.get(p.id).actualLevel,
      profile: brains.get(p.id).profile ?? null,
      solver: options.seatOptions?.[i]?.solver ?? null,
    })),
  }) : null;
  const trace = [];
  let safety = 0;
  while (game.phase !== 'finished' && safety < maxSteps) {
    safety++;
    let acted = false;
    for (const p of game.players) {
      if (p.out) continue;
      const legal = game.getLegalActions(p.id);
      if (legal.length === 0) continue;
      const state = game.getState(p.id);
      const brain = brains.get(p.id);
      brain.observe(state, p.id);
      const started = metrics ? performance.now() : 0;
      const decision = brain.decide(state, p.id, legal) || {};
      if (metrics) metrics.decisionMsBySeat[players.findIndex(x => x.id === p.id)]
        .push(performance.now() - started);
      const action = decision.action;
      if (options.verifyLegal && (!action || !legal.some(a => isDeepStrictEqual(a, action)))) {
        const error = new Error(`${p.id}: action outside legal list: ${JSON.stringify(action)}`);
        error.code = 'ILLEGAL_ACTION';
        throw error;
      }
      if (!action) continue;
      if (decision.decisionTrace) decision.decisionTrace.actionId = safety;
      if (collectTrace) {
        trace.push({
          player: p.name,
          level: brain.level,
          action: actionToString(action),
          reason: decision.reason || null,
          analysis: decision.analysis || null,
          decisionTrace: decision.decisionTrace ?? null,
        });
      }
      applyObservedAction(game, brains, p.id, action, recorder ? () => {
        recorder.applyAction(p.id, action, {
          actor: { kind: 'bot', level: brain.actualLevel, profile: brain.profile ?? null },
          reason: decision.reason ?? null,
          decisionTrace: decision.decisionTrace ?? null,
        });
      } : null);
      acted = true;
      break; // по одному действию за раз, чтобы состояние переоценивалось корректно
    }
    if (!acted) break;
  }

  const durakSeat = game.durak
    ? game.players.findIndex((p) => p.id === game.durak)
    : -1;

  if (metrics) metrics.solverBySeat = players.map(p =>
    structuredClone(brains.get(p.id).solverStats ?? null));
  return {
    durakSeat,
    steps: safety,
    // A deadlock before maxSteps is also unfinished; finishing on the last
    // permitted step is not a hang.
    stuck: game.phase !== 'finished',
    trace,
    log: game.log,
    finishedOrder: game.finishedOrder,
    ...(options.measure ? {
      finished: game.phase === 'finished',
      drawReason: game.drawReason,
      metrics,
    } : {}),
    ...(recorder ? { diagnostic: recorder.exportArtifact({ protectedDiagnostic: true }) } : {}),
  };
}
