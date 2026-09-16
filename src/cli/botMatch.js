// Очный матч уровней ботов — инструмент измерения силы бота.
//
// Зачем (issue #31, этап 1 плана): в #24 «умный» бот оказался слабее простого, и выяснилось
// это слишком поздно. Поэтому бенчмарк пишется РАНЬШЕ самого бота: любая новая эвристика
// принимается только если цифры здесь стали лучше.
//
// Использование:
//   node src/cli/botMatch.js <партий> <levelA> <levelB> <deckSize> <numPlayers> [--verbose]
// Например:
//   node src/cli/botMatch.js 1000 simple simple 24 2
//   node src/cli/botMatch.js 1000 smart  simple 36 2 --verbose
//
// Матч гоняется В ОБЕ СТОРОНЫ: половина партий — levelA на 1-м месте, половина — на 2-м
// (при большем числе игроков уровни чередуются по местам, а во второй половине меняются
// местами). Так исключается перекос от преимущества первого хода.
//
// Боту передаётся ТОЛЬКО game.getState(botId) — маскированное состояние без чужих рук.

import { DurakGame } from '../game.js';
import { cardToString } from '../deck.js';
import { createBotBrain, normalizeBotLevel, botLevelLabel, BOT_LEVELS } from '../bots/index.js';

const MAX_STEPS = 5000;

function parseArgs(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    numGames: Number(positional[0] || 1000),
    rawLevelA: positional[1] || 'simple',
    rawLevelB: positional[2] || 'simple',
    deckSize: Number(positional[3] || 24),
    numPlayers: Number(positional[4] || 2),
    verbose: flags.includes('--verbose'),
  };
}

function actionToString(action) {
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
function seatLevels(levelA, levelB, numPlayers, direction) {
  return Array.from({ length: numPlayers }, (_, i) => {
    const first = i % 2 === 0;
    const aFirst = direction === 0;
    return first === aFirst ? levelA : levelB;
  });
}

// Одна партия. Возвращает { durakSeat, steps, stuck, trace }.
function playOneGame(levels, deckSize, numPlayers, collectTrace) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({
    id: `p${i + 1}`,
    name: `p${i + 1} (${botLevelLabel(levels[i])})`,
  }));
  const game = new DurakGame(players, { numPlayers, deckSize }, Math.random);

  const brains = new Map();
  players.forEach((p, i) => {
    const brain = createBotBrain(levels[i], { explain: collectTrace });
    brain.reset(game.getState(p.id), p.id);
    brains.set(p.id, brain);
  });

  const trace = [];
  let safety = 0;
  while (game.phase !== 'finished' && safety < MAX_STEPS) {
    safety++;
    let acted = false;
    for (const p of game.players) {
      if (p.out) continue;
      const legal = game.getLegalActions(p.id);
      if (legal.length === 0) continue;
      const state = game.getState(p.id);
      const brain = brains.get(p.id);
      brain.observe(state, p.id);
      const decision = brain.decide(state, p.id, legal) || {};
      const action = decision.action;
      if (!action) continue;
      if (collectTrace) {
        trace.push({
          player: p.name,
          level: brain.level,
          action: actionToString(action),
          reason: decision.reason || null,
          analysis: decision.analysis || null,
        });
      }
      game.applyAction(p.id, action);
      acted = true;
      break; // по одному действию за раз, чтобы состояние переоценивалось корректно
    }
    if (!acted) break;
  }

  const durakSeat = game.durak
    ? game.players.findIndex((p) => p.id === game.durak)
    : -1;

  return {
    durakSeat,
    steps: safety,
    stuck: safety >= MAX_STEPS,
    trace,
    log: game.log,
    finishedOrder: game.finishedOrder,
  };
}

function pct(part, total) {
  if (!total) return '—';
  return `${((part / total) * 100).toFixed(1)} %`;
}

function main() {
  const { numGames, rawLevelA, rawLevelB, deckSize, numPlayers, verbose } = parseArgs(
    process.argv.slice(2),
  );

  const levelA = normalizeBotLevel(rawLevelA);
  const levelB = normalizeBotLevel(rawLevelB);
  for (const [raw, norm] of [[rawLevelA, levelA], [rawLevelB, levelB]]) {
    if (String(raw).trim().toLowerCase() !== norm) {
      console.warn(
        `Предупреждение: неизвестный уровень "${raw}" — использую "${norm}". ` +
          `Доступные уровни: ${BOT_LEVELS.map((l) => l.id).join(', ')}.`,
      );
    }
  }

  if (!Number.isFinite(numGames) || numGames < 1) {
    console.error('Число партий должно быть положительным числом.');
    process.exit(1);
  }

  // Предупреждаем честно, если запрошенный уровень пока откатывается на простого.
  for (const lvl of new Set([levelA, levelB])) {
    const probe = createBotBrain(lvl);
    if (probe.fallback) {
      console.warn(
        `Предупреждение: уровень "${lvl}" ещё не реализован и играет логикой "${probe.actualLevel}".`,
      );
    }
  }

  let errors = 0;
  let stuck = 0;
  let draws = 0;
  let totalSteps = 0;
  let playedGames = 0;

  // Статистика «дурака»: по уровню и по месту за столом.
  const durakByLevel = { [levelA]: 0, [levelB]: 0 };
  const durakBySeat = Array.from({ length: numPlayers }, () => 0);
  // Сколько партий сыграно в каждую сторону — чтобы видеть, что матч честно симметричен.
  const gamesByDirection = [0, 0];

  for (let g = 0; g < numGames; g++) {
    const direction = g % 2; // чередуем стороны, чтобы половины были равны
    const levels = seatLevels(levelA, levelB, numPlayers, direction);
    try {
      const res = playOneGame(levels, deckSize, numPlayers, false);
      playedGames++;
      gamesByDirection[direction]++;
      totalSteps += res.steps;
      if (res.stuck) stuck++;
      if (res.durakSeat < 0) {
        draws++;
      } else {
        durakBySeat[res.durakSeat]++;
        const lvl = levels[res.durakSeat];
        durakByLevel[lvl] = (durakByLevel[lvl] || 0) + 1;
      }
    } catch (e) {
      errors++;
      if (errors <= 3) {
        console.error('Ошибка в партии:', e.message);
        console.error(e.stack);
      }
    }
  }

  const decided = playedGames - draws;

  console.log('=== Очный матч ботов ===');
  console.log(
    `Конфигурация: ${numGames} партий, колода ${deckSize}, игроков ${numPlayers}`,
  );
  console.log(
    `Уровень A: ${levelA} (${botLevelLabel(levelA)}) | Уровень B: ${levelB} (${botLevelLabel(levelB)})`,
  );
  console.log(
    `Стороны: A на 1-м месте — ${gamesByDirection[0]} партий, A на 2-м месте — ${gamesByDirection[1]} партий`,
  );
  console.log('');
  console.log(`Сыграно партий: ${playedGames}`);
  console.log(`Ошибок движка: ${errors}`);
  console.log(`Зависших (упёрлись в предохранитель): ${stuck}`);
  console.log(`Ничьих: ${draws}`);
  console.log(
    `Среднее число шагов на партию: ${playedGames ? (totalSteps / playedGames).toFixed(1) : '—'}`,
  );
  console.log('');
  console.log('--- Доля "дурака" по уровням (от партий с результатом) ---');
  if (levelA === levelB) {
    console.log(
      `Оба места заняты уровнем "${levelA}" — это калибровочный прогон, ожидается ~50/50 по местам.`,
    );
  }
  for (const lvl of levelA === levelB ? [levelA] : [levelA, levelB]) {
    const label = lvl === levelA ? 'A' : 'B';
    console.log(
      `${label}. ${lvl.padEnd(6)} — дурак в ${durakByLevel[lvl] || 0} партиях (${pct(durakByLevel[lvl] || 0, decided)})`,
    );
  }
  console.log('');
  console.log('--- Доля "дурака" по местам ---');
  const seatsDir0 = seatLevels(levelA, levelB, numPlayers, 0);
  const seatsDir1 = seatLevels(levelA, levelB, numPlayers, 1);
  durakBySeat.forEach((count, seat) => {
    console.log(
      `Место ${seat + 1}: ${count} (${pct(count, decided)})` +
        `  [в 1-й половине матча тут ${seatsDir0[seat]}, во 2-й — ${seatsDir1[seat]}]`,
    );
  });

  if (levelA !== levelB) {
    const a = durakByLevel[levelA] || 0;
    const b = durakByLevel[levelB] || 0;
    console.log('');
    if (a < b) console.log(`Итог: уровень "${levelA}" сильнее (реже остаётся дураком).`);
    else if (b < a) console.log(`Итог: уровень "${levelB}" сильнее (реже остаётся дураком).`);
    else console.log('Итог: паритет.');
  }

  if (verbose) {
    console.log('');
    console.log('=== Подробный лог одной партии (--verbose) ===');
    const levels = seatLevels(levelA, levelB, numPlayers, 0);
    const res = playOneGame(levels, deckSize, numPlayers, true);
    console.log('Раскладка уровней по местам:', levels.join(' | '));
    console.log('');
    console.log('--- Решения ботов ---');
    for (const step of res.trace) {
      let line = `${step.player} [${step.level}] -> ${step.action}`;
      if (step.reason) line += `\n    причина: ${step.reason}`;
      if (step.analysis) line += `\n    анализ: ${JSON.stringify(step.analysis)}`;
      console.log(line);
    }
    console.log('');
    console.log('--- Лог движка ---');
    console.log(res.log.join('\n'));
    console.log('');
    console.log('Порядок выхода (места):', res.finishedOrder.join(' -> '));
    console.log('Дурак:', res.durakSeat >= 0 ? `место ${res.durakSeat + 1} (${levels[res.durakSeat]})` : 'нет (ничья)');
    console.log('Шагов симуляции:', res.steps);
  }

  if (errors > 0 || stuck > 0) process.exitCode = 1;
}

main();
