// Прогонщик матрицы конфигураций ботов — измерение силы бота и сравнение с baseline.
// Этап 1 плана умного бота (issue #46).
//
// Использование:
//   node scripts/evalBots.js [--games=10000] [--a=smart] [--b=simple] [--matrix=main|quick|full]
//                            [--configs=2x24,4x36] [--throw-in=all] [--json=bench/run.json]
//                            [--baseline=bench/baseline.json] [--seed=<n>] [--target=4x24,4x36]
//
// Детерминированный прогон: seeded PRNG (mulberry32), передаваемый третьим аргументом в DurakGame.

import fs from 'node:fs';
import { DurakGame } from '../src/game.js';
import { createBotBrain, normalizeBotLevel, botLevelLabel, BOT_LEVELS } from '../src/bots/index.js';

const MAX_STEPS = 5000;

// Mulberry32 PRNG
function createPrng(seed) {
  let s = Math.floor(seed) >>> 0;
  return function() {
    s += 0x6D2B79F5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_MAIN_CONFIGS = [
  { players: 2, deckSize: 24 },
  { players: 2, deckSize: 36 },
  { players: 2, deckSize: 52 },
  { players: 3, deckSize: 24 },
  { players: 3, deckSize: 36 },
  { players: 3, deckSize: 52 },
  { players: 4, deckSize: 24 },
  { players: 4, deckSize: 36 },
  { players: 4, deckSize: 52 },
  { players: 5, deckSize: 36 },
  { players: 5, deckSize: 52 },
  { players: 6, deckSize: 36 },
  { players: 6, deckSize: 52 },
];

const QUICK_CONFIGS = [
  { players: 2, deckSize: 24 },
  { players: 4, deckSize: 36 },
  { players: 6, deckSize: 52 },
];

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const val = arg.slice(eqIdx + 1);
        flags[key] = val;
      } else {
        const key = arg.slice(2);
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function parseConfigs(configsStr) {
  // e.g. "2x24,4x36" or "2x24,3x36,5x52"
  if (!configsStr) return null;
  return configsStr.split(',').map((item) => {
    const parts = item.toLowerCase().split('x');
    if (parts.length !== 2) throw new Error(`Неверный формат конфигурации: ${item}`);
    const players = Number(parts[0]);
    const deckSize = Number(parts[1]);
    if (!Number.isFinite(players) || !Number.isFinite(deckSize)) {
      throw new Error(`Неверный формат конфигурации: ${item}`);
    }
    return { players, deckSize };
  });
}

function seatLevels(levelA, levelB, numPlayers, direction) {
  return Array.from({ length: numPlayers }, (_, i) => {
    const first = i % 2 === 0;
    const aFirst = direction === 0;
    return first === aFirst ? levelA : levelB;
  });
}

function playOneGame(levels, deckSize, numPlayers, rng) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({
    id: `p${i + 1}`,
    name: `p${i + 1} (${botLevelLabel(levels[i])})`,
  }));
  const game = new DurakGame(players, { numPlayers, deckSize }, rng);

  const brains = new Map();
  players.forEach((p, i) => {
    const brain = createBotBrain(levels[i], { explain: false });
    brain.reset(game.getState(p.id), p.id);
    brains.set(p.id, brain);
  });

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
      game.applyAction(p.id, action);
      acted = true;
      break;
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
  };
}

function runConfig(players, deckSize, numGames, levelA, levelB, throwInPolicy, rng) {
  let errors = 0;
  let stuck = 0;
  let draws = 0;
  let totalSteps = 0;
  let playedGames = 0;
  const durakByLevel = { [levelA]: 0, [levelB]: 0 };

  const startTime = Date.now();

  for (let g = 0; g < numGames; g++) {
    const direction = g % 2;
    const levels = seatLevels(levelA, levelB, players, direction);
    try {
      const res = playOneGame(levels, deckSize, players, rng);
      playedGames++;
      totalSteps += res.steps;
      if (res.stuck) stuck++;
      if (res.durakSeat < 0) {
        draws++;
      } else {
        const lvl = levels[res.durakSeat];
        durakByLevel[lvl] = (durakByLevel[lvl] || 0) + 1;
      }
    } catch (e) {
      errors++;
      if (errors <= 3) {
        console.error('Ошибка в партии:', e.message);
      }
    }
  }

  const durationSec = (Date.now() - startTime) / 1000;
  const decided = playedGames - draws;
  const aDurak = durakByLevel[levelA] || 0;
  const durakPct = decided > 0 ? (aDurak / decided) * 100 : 0;
  const p = decided > 0 ? aDurak / decided : 0;
  const se = decided > 0 ? Math.sqrt((p * (1 - p)) / decided) * 100 : 0;
  const ci95 = 1.96 * se;

  return {
    players,
    deckSize,
    throwInPolicy,
    games: numGames,
    playedGames,
    decided,
    draws,
    errors,
    stuck,
    durakCount: aDurak,
    durakPct: Number(durakPct.toFixed(2)),
    se: Number(se.toFixed(2)),
    ci95: Number(ci95.toFixed(2)),
    gamesPerSec: durationSec > 0 ? Math.round(playedGames / durationSec) : 0,
  };
}

function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const numGames = Number(flags.games || 2000);
  const rawA = flags.a || 'smart';
  const rawB = flags.b || 'simple';
  const levelA = normalizeBotLevel(rawA);
  const levelB = normalizeBotLevel(rawB);
  const matrix = flags.matrix || 'main';
  const throwInPolicy = flags['throw-in'] || 'all';
  const jsonPath = flags.json || null;
  const baselinePath = flags.baseline || null;
  const seed = flags.seed !== undefined ? Number(flags.seed) : 42;
  const targetConfigsStr = flags.target || '';
  const targetConfigs = targetConfigsStr ? parseConfigs(targetConfigsStr) : [];

  let configs = DEFAULT_MAIN_CONFIGS;
  if (matrix === 'quick') {
    configs = QUICK_CONFIGS;
  } else if (matrix === 'full') {
    // full can include more if needed, or same as main
    configs = DEFAULT_MAIN_CONFIGS;
  }
  if (flags.configs) {
    configs = parseConfigs(flags.configs);
  }

  const rng = createPrng(seed);

  console.log('=== Прогонщик матрицы конфигураций ботов (evalBots) ===');
  console.log(`Уровень A: ${levelA} | Уровень B: ${levelB}`);
  console.log(`Партий на конфигурацию: ${numGames}, seed: ${seed}, throwInPolicy: ${throwInPolicy}`);
  console.log(`Матрица: ${matrix} (${configs.length} конфигураций)\n`);

  let baselineMap = new Map();
  if (baselinePath && fs.existsSync(baselinePath)) {
    try {
      const baselineData = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      if (Array.isArray(baselineData.results)) {
        for (const r of baselineData.results) {
          baselineMap.set(`${r.players}x${r.deckSize}`, r);
        }
      }
      console.log(`Загружен baseline из ${baselinePath} (версия: ${baselineData.version || 'unknown'})`);
    } catch (e) {
      console.warn(`Не удалось прочитать baseline из ${baselinePath}:`, e.message);
    }
  }

  const results = [];
  let totalErrors = 0;
  let totalStuck = 0;
  let criteriaFailed = false;

  for (const cfg of configs) {
    process.stdout.write(`Прогон ${cfg.players} игроков, колода ${cfg.deckSize}... `);
    const res = runConfig(cfg.players, cfg.deckSize, numGames, levelA, levelB, throwInPolicy, rng);
    results.push(res);
    totalErrors += res.errors;
    totalStuck += res.stuck;

    let deltaStr = '';
    const key = `${cfg.players}x${cfg.deckSize}`;
    const baseR = baselineMap.get(key);
    if (baseR) {
      const delta = res.durakPct - baseR.durakPct;
      const diffSe = Math.sqrt((res.se * res.se) + (baseR.se * baseR.se));
      const significant = Math.abs(delta) > 1.96 * diffSe;
      deltaStr = ` | дельта к base: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%${significant ? ' (*)' : ''}`;
    }

    // Check target criteria if specified
    const isTarget = targetConfigs.some((t) => t.players === cfg.players && t.deckSize === cfg.deckSize);
    if (isTarget) {
      if (res.durakPct > 48.0) {
        criteriaFailed = true;
        deltaStr += ' [ЦЕЛЬ ПРОЦЕНТ > 48!]';
      }
    } else {
      if (res.durakPct > 51.0) {
        criteriaFailed = true;
        deltaStr += ' [ШУМ > 51!]';
      }
    }

    if (res.errors > 0 || res.stuck > 0) {
      criteriaFailed = true;
    }

    console.log(`дурак A: ${res.durakPct}% (±${res.ci95}%), ошибок: ${res.errors}, зависших: ${res.stuck}, ${res.gamesPerSec} игр/с${deltaStr}`);
  }

  // Markdown table output
  console.log('\n### Таблица результатов прогона\n');
  console.log('| Игроков | Колода | Партий | Дурак A (%) | Дов. интервал (95%) | Ошибок | Зависших | Игр/с | Дельта к base |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const key = `${r.players}x${r.deckSize}`;
    const baseR = baselineMap.get(key);
    let dStr = '—';
    if (baseR) {
      const delta = r.durakPct - baseR.durakPct;
      dStr = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} %`;
    }
    console.log(`| ${r.players} | ${r.deckSize} | ${r.playedGames} | **${r.durakPct} %** | ±${r.ci95} % | ${r.errors} | ${r.stuck} | ${r.gamesPerSec} | ${dStr} |`);
  }
  console.log('');

  if (criteriaFailed || totalErrors > 0 || totalStuck > 0) {
    console.log('Вердикт: КРИТЕРИЙ ПРИЁМКИ НЕ ВЫПОЛНЕН (есть ошибки, зависания или превышены пороги).');
    process.exitCode = 1;
  } else {
    console.log('Вердикт: УСПЕХ — все конфигурации в пределах допустимых порогов, ошибок и зависаний нет.');
  }

  if (jsonPath) {
    const outputObj = {
      version: '1.0.0',
      date: new Date().toISOString(),
      levels: { a: levelA, b: levelB },
      seed,
      throwInPolicy,
      results,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(outputObj, null, 2), 'utf8');
    console.log(`Результаты сохранены в ${jsonPath}`);
  }
}

main();
