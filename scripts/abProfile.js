// A/B-прогон флагов умного бота (issue #33; этап 5 — issue #50).
//
// Зачем: в профилях умного бота (`SMART_PROFILES` в src/bots/smartBot.js) каждое правило
// раздела 5.3 включается отдельным флагом. Здесь мы по очереди ВЫКЛЮЧАЕМ по одному флагу
// и смотрим, как меняется доля «дурака» у умного бота против простого. Если без флага
// результат НЕ хуже — флаг бесполезен (или вреден) и его надо выключить в профиле.
//
// С этапа 5 скрипт умеет пройти НАБОР конфигураций за один запуск: профили по варианту
// игры (duel / small / large) калибруются каждый на своей точке, поэтому таблицу нужно
// получать сразу по 2×24, 4×24, 4×36, 6×52.
//
// Использование:
//   node scripts/abProfile.js [партий] [deckSize] [numPlayers]      — как раньше, одна конфигурация
//   node scripts/abProfile.js --games=400 --configs=2x24,4x24,4x36,6x52
//   node scripts/abProfile.js --games=400 --configs=4x36 --throw-in=neighbors
//   node scripts/abProfile.js --games=400 --configs=4x36 --flags=avoidBurningBigTrump,dumpPairs
//   node scripts/abProfile.js --games=400 --configs=4x36 --seed=12345
//
// Конфигурация пишется как `<игроков>x<колода>` (4x36 — четверо, колода 36).
//
// Матч, как и в botMatch.js, гоняется в обе стороны: половина партий умный на 1-м месте,
// половина — на 2-м, чтобы преимущество первого хода не перекашивало цифры. Партии
// ПАРНЫЕ: одна и та же раздача (тот же seed) играется базовым профилем и профилем без
// флага, поэтому шум одной раздачи не портит сравнение (см. отчёт в issue #49).

import { DurakGame } from '../src/game.js';
import { SmartBot, SMART_PROFILE, SMART_PROFILES, pickProfile, pickProfileName } from '../src/bots/smartBot.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';
import { DEFAULT_RULES } from '../src/rules.js';

const MAX_STEPS = 3000;
const DEFAULT_CONFIGS = '2x24,4x24,4x36,6x52';

/** Детерминированный ГПСЧ (mulberry32): нужен для парных прогонов «с флагом / без флага». */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeBrain(level, profile) {
  if (level === 'smart') {
    const bot = new SmartBot({ profile });
    return {
      reset: (s, id) => bot.reset(s, id),
      observe: (s, id) => bot.observe(s, id),
      decide: (s, id, legal) => bot.decide(s, id, legal).action,
    };
  }
  return {
    reset: () => {},
    observe: () => {},
    decide: (s, id, legal) => simpleBotDecide(s, id, legal),
  };
}

function playOne(levels, deckSize, numPlayers, profile, rng, throwInPolicy) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
  const options = { numPlayers, deckSize };
  if (throwInPolicy) options.throwInPolicy = throwInPolicy;
  const game = new DurakGame(players, options, rng);

  const brains = new Map();
  players.forEach((p, i) => {
    const b = makeBrain(levels[i], profile);
    b.reset(game.getState(p.id), p.id);
    brains.set(p.id, b);
  });

  let steps = 0;
  while (game.phase !== 'finished' && steps < MAX_STEPS) {
    steps++;
    let acted = false;
    for (const p of game.players) {
      if (p.out) continue;
      const legal = game.getLegalActions(p.id);
      if (legal.length === 0) continue;
      const state = game.getState(p.id);
      const brain = brains.get(p.id);
      brain.observe(state, p.id);
      const action = brain.decide(state, p.id, legal);
      if (!action) continue;
      game.applyAction(p.id, action);
      acted = true;
      break;
    }
    if (!acted) break;
  }
  return game.durak ? game.players.findIndex((p) => p.id === game.durak) : -1;
}

/**
 * Матч профиля против простого бота.
 * @returns {{ smartDurakPct: number|null, decided: number }}
 */
function runMatch(numGames, deckSize, numPlayers, profile, baseSeed, throwInPolicy) {
  let smartDurak = 0;
  let decided = 0;
  for (let g = 0; g < numGames; g++) {
    const smartFirst = g % 2 === 0;
    const levels = Array.from({ length: numPlayers }, (_, i) => {
      const even = i % 2 === 0;
      return even === smartFirst ? 'smart' : 'simple';
    });
    // Парность: номер партии + базовый seed -> одна и та же раздача во всех профилях.
    const rng = makeRng(baseSeed + g * 2654435761);
    const seat = playOne(levels, deckSize, numPlayers, profile, rng, throwInPolicy);
    if (seat < 0) continue;
    decided++;
    if (levels[seat] === 'smart') smartDurak++;
  }
  return { smartDurakPct: decided ? (smartDurak / decided) * 100 : null, decided };
}

function parseConfigs(spec) {
  return String(spec)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d+)\s*[xх*]\s*(\d+)$/i.exec(s);
      if (!m) throw new Error(`Не разобрал конфигурацию «${s}»: ожидается вид 4x36 (игроков x колода).`);
      return { numPlayers: Number(m[1]), deckSize: Number(m[2]) };
    });
}

function parseArgs(argv) {
  const opts = {
    games: 400,
    configs: null,
    flags: null,
    throwInPolicy: null,
    seed: 1234567,
    positional: [],
  };
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [rawKey, rawValue] = arg.slice(2).split('=');
      const key = rawKey.trim();
      const value = rawValue === undefined ? 'true' : rawValue;
      switch (key) {
        case 'games': opts.games = Number(value); break;
        case 'configs': case 'config': case 'target': opts.configs = value; break;
        case 'flags': case 'flag': opts.flags = value.split(',').map((s) => s.trim()).filter(Boolean); break;
        case 'throw-in': case 'throwIn': case 'throwInPolicy': opts.throwInPolicy = value; break;
        case 'seed': opts.seed = Number(value); break;
        case 'help': opts.help = true; break;
        default: throw new Error(`Неизвестный ключ --${key}.`);
      }
    } else {
      opts.positional.push(arg);
    }
  }
  return opts;
}

function printHelp() {
  console.log(`A/B-прогон флагов профиля умного бота.

  node scripts/abProfile.js [партий] [deckSize] [numPlayers]
  node scripts/abProfile.js --games=400 --configs=${DEFAULT_CONFIGS}
  node scripts/abProfile.js --games=400 --configs=4x36 --throw-in=neighbors
  node scripts/abProfile.js --games=400 --configs=4x36 --flags=avoidBurningBigTrump

Ключи:
  --games=N          партий на каждый профиль в каждой конфигурации (по умолчанию 400)
  --configs=СПИСОК   конфигурации вида «игроков x колода» через запятую (по умолчанию ${DEFAULT_CONFIGS})
  --flags=СПИСОК     какие флаги проверять (по умолчанию все флаги профиля)
  --throw-in=ПОЛИТИКА политика подкидывания движка (${DEFAULT_RULES.throwInPolicy} по умолчанию)
  --seed=N           база для парных раздач (одинаковые раздачи у всех профилей)
`);
}

/** Таблица A/B по одной конфигурации. Базой служит ПРОФИЛЬ ЭТОЙ конфигурации (pickProfile). */
function runConfig({ numPlayers, deckSize }, { games, flags, throwInPolicy, seed }) {
  const rules = { ...DEFAULT_RULES, numPlayers, deckSize };
  const profileName = pickProfileName(rules);
  const baseProfile = pickProfile(rules);
  const flagList = flags && flags.length ? flags : Object.keys(baseProfile);
  const unknown = flagList.filter((f) => !(f in baseProfile));
  if (unknown.length) throw new Error(`Неизвестные флаги: ${unknown.join(', ')}. Есть: ${Object.keys(baseProfile).join(', ')}.`);

  const policy = throwInPolicy || DEFAULT_RULES.throwInPolicy;
  console.log(`\n### ${numPlayers} игроков, колода ${deckSize} — профиль «${profileName}», подкидывание «${policy}», ${games} партий`);
  console.log('Метрика — доля партий, где «дураком» остался УМНЫЙ бот (меньше = лучше).\n');

  const base = runMatch(games, deckSize, numPlayers, baseProfile, seed, throwInPolicy);
  console.log(`| ${'конфигурация профиля'.padEnd(34)} | доля «дурака» у smart | дельта к базе |`);
  console.log(`|${'-'.repeat(36)}|${'-'.repeat(23)}|${'-'.repeat(15)}|`);
  console.log(`| ${`база (профиль ${profileName})`.padEnd(34)} | ${base.smartDurakPct.toFixed(1).padStart(20)} % | ${'—'.padStart(13)} |`);

  const rows = [];
  for (const flag of flagList) {
    const profile = { ...baseProfile, [flag]: !baseProfile[flag] };
    const res = runMatch(games, deckSize, numPlayers, profile, seed, throwInPolicy);
    const delta = res.smartDurakPct - base.smartDurakPct;
    // «Лучше» = доля «дурака» у smart УПАЛА. Порог 1 п.п.: при N ≈ 400 меньшее — шум.
    const verdict = delta < -1 ? ` ← ${baseProfile[flag] ? 'без' : 'с'} флагом ЛУЧШЕ` : '';
    const label = `${baseProfile[flag] ? 'без' : 'с'} ${flag}`;
    rows.push({ flag, pct: res.smartDurakPct, delta });
    console.log(
      `| ${label.padEnd(34)} | ${res.smartDurakPct.toFixed(1).padStart(20)} % | ` +
        `${`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`.padStart(13)} |${verdict}`,
    );
  }
  return { numPlayers, deckSize, profileName, base: base.smartDurakPct, rows };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    printHelp();
    process.exit(1);
  }
  if (opts.help) { printHelp(); return; }

  // Старый позиционный вызов: node scripts/abProfile.js 1000 24 2
  let configs;
  if (opts.configs) {
    configs = parseConfigs(opts.configs);
  } else if (opts.positional.length) {
    opts.games = Number(opts.positional[0] || opts.games);
    const deckSize = Number(opts.positional[1] || 24);
    const numPlayers = Number(opts.positional[2] || 2);
    configs = [{ numPlayers, deckSize }];
  } else {
    configs = parseConfigs(DEFAULT_CONFIGS);
  }

  console.log(`A/B профилей умного бота: ${opts.games} партий на профиль, ` +
    `конфигураций ${configs.length}, seed ${opts.seed} (раздачи парные).`);
  console.log(`Профили: ${Object.keys(SMART_PROFILES).join(' / ')}; ` +
    `SMART_PROFILE — алиас «duel» (${Object.keys(SMART_PROFILE).length} флагов).`);

  const summary = [];
  for (const cfg of configs) {
    try {
      summary.push(runConfig(cfg, opts));
    } catch (e) {
      console.error(`Конфигурация ${cfg.numPlayers}x${cfg.deckSize}: ${e.message}`);
      process.exitCode = 1;
    }
  }

  if (summary.length > 1) {
    console.log('\n### Сводка: доля «дурака» у smart на базовом профиле каждой конфигурации\n');
    console.log(`| ${'конфигурация'.padEnd(14)} | профиль | база |`);
    console.log(`|${'-'.repeat(16)}|${'-'.repeat(9)}|${'-'.repeat(8)}|`);
    for (const s of summary) {
      console.log(`| ${`${s.numPlayers}x${s.deckSize}`.padEnd(14)} | ${s.profileName.padEnd(7)} | ${s.base.toFixed(1).padStart(4)} % |`);
    }
  }
}

main();
