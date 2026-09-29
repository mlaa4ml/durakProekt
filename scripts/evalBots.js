// Прогонщик МАТРИЦЫ конфигураций — «линейка» силы ботов (issue #46, этап 1 roadmap).
//
// Зачем: `src/cli/botMatch.js` меряет одну конфигурацию за запуск, печатает только текст
// и не умеет ни доверительных интервалов, ни сравнения с зафиксированной линией. Из-за этого
// нельзя принять правку бота: часть эвристик на 24×2 помогает, а на 36×4 — нет, и по одному
// прогону это не видно. Поэтому линейка делается ПЕРВОЙ, до правок самого бота.
//
// Использование:
//   node scripts/evalBots.js [--games=10000] [--a=smart] [--b=simple] [--matrix=main|quick|full]
//                            [--configs=2x24,4x36] [--throw-in=all] [--json=bench/run.json]
//                            [--baseline=bench/baseline.json] [--seed=<n>] [--target=4x24,4x36]
//                            [--no-gate] [--date=<ISO>] [--quiet]
//
// Ключевое:
//   * матч гоняется В ОБЕ СТОРОНЫ (seatLevels из ../src/cli/matchCore.js), чтобы преимущество
//     первого хода не перекашивало цифры; раскладка мест и прогон партии НЕ копируются,
//     а берутся из общего модуля, которым пользуется и botMatch.js;
//   * прогон детерминирован: свой seeded-PRNG (mulberry32) передаётся третьим аргументом
//     конструктора `new DurakGame(players, rules, rng)`. `src/game.js` при этом НЕ меняется —
//     он уже принимает rng (см. src/game.js:21);
//   * критерий приёмки зашит в инструмент: целевые конфигурации (--target) ≤ 48 % «дурака» у A,
//     остальные ≤ 51 %. Не выполнен — ненулевой process.exitCode (годится для ночной проверки).
//
// Бот получает ТОЛЬКО game.getState(botId) — маскированное состояние без чужих рук.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { normalizeBotLevel, botLevelLabel, BOT_LEVELS } from '../src/bots/index.js';
import { seatLevels, playOneGame } from '../src/cli/matchCore.js';
import { SMART_PROFILE } from '../src/bots/smartBot.js';

// ---------------------------------------------------------------------------
// Seeded PRNG
// ---------------------------------------------------------------------------

// mulberry32 — короткий и быстрый генератор с 32-битным состоянием.
// Нужен ради воспроизводимости: с одним --seed прогон повторяется карта в карту.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Хэш строки в 32-битное число (FNV-1a). Из него делаем seed конкретной партии,
// чтобы результат конфигурации не зависел от того, какие конфигурации шли до неё.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// Матрицы конфигураций
// ---------------------------------------------------------------------------

const HAND_SIZE = 6; // src/rules.js: handSize; колода должна вмещать numPlayers * handSize
const DECKS = [24, 36, 52];

function isPlayableConfig(players, deckSize) {
  return players >= 2 && players <= 6 && DECKS.includes(deckSize) && players * HAND_SIZE <= deckSize;
}

// Матрица раздела 2 roadmap: 2×{24,36,52}, 3×{24,36,52}, 4×{24,36,52}, 5×{36,52}, 6×{36,52}.
// Это 13 конфигураций (в тексте issue #46 написано «14» — но 5×24 и 6×24 движок не примет:
// 5·6 = 30 и 6·6 = 36 карт против колоды в 24, см. resolveRules в src/rules.js).
const MAIN_MATRIX = [
  [2, 24], [2, 36], [2, 52],
  [3, 24], [3, 36], [3, 52],
  [4, 24], [4, 36], [4, 52],
  [5, 36], [5, 52],
  [6, 36], [6, 52],
];

// Сокращённый набор для быстрой проверки (и для CI): дуэль, четвёрка, полный стол.
const QUICK_MATRIX = [[2, 24], [4, 36], [6, 52]];

// Полный набор — все сочетания 2..6 × {24,36,52}, которые вообще допустимы правилами.
// Сейчас совпадает с MAIN_MATRIX, но считается из правил, а не переписывается руками.
const FULL_MATRIX = [2, 3, 4, 5, 6]
  .flatMap((p) => DECKS.map((d) => [p, d]))
  .filter(([p, d]) => isPlayableConfig(p, d));

function matrixByName(name) {
  switch (name) {
    case 'quick': return QUICK_MATRIX;
    case 'full': return FULL_MATRIX;
    case 'main':
    default: return MAIN_MATRIX;
  }
}

// "4x36" | "4×36" -> [4, 36]
function parseConfigList(raw) {
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s);
      if (!m) throw new Error(`Не разобрал конфигурацию "${s}" — ожидается вид 4x36.`);
      return [Number(m[1]), Number(m[2])];
    });
}

const configKey = (players, deckSize) => `${players}x${deckSize}`;

// Принадлежит ли место стороне A при данном direction.
// Повторяет раскладку seatLevels (места 0,2,4... — сторона A при direction=0, иначе наоборот),
// но отвечает про СТОРОНУ, а не про название уровня. Сравнивать levels[seat] === levelA нельзя:
// в калибровочном прогоне simple vs simple такое сравнение всегда истинно и доля «дурака» у A
// выходит 100 % вместо честных ~50 %.
function seatBelongsToA(seat, direction) {
  return (seat % 2 === 0) === (direction === 0);
}

// ---------------------------------------------------------------------------
// Аргументы
// ---------------------------------------------------------------------------

// "exactEndgameSolver,dumpPairs" -> флаги профиля умного бота, включаемые для стороны.
// Включаются ТОЛЬКО перечисленные: остальной профиль остаётся по умолчанию.
function parseFlagList(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const opts = {
    games: 10000,
    a: 'smart',
    b: 'simple',
    matrix: 'main',
    configs: null,
    throwIn: 'all',
    json: null,
    baseline: null,
    seed: 12345,
    target: [],
    gate: true,
    date: null,
    quiet: false,
    aFlags: [],
    bFlags: [],
    solverNodes: null,
    solverMs: null,
  };
  for (const arg of argv) {
    const m = /^--([a-z0-9-]+)(?:=(.*))?$/i.exec(arg);
    if (!m) throw new Error(`Не понял аргумент "${arg}". Смотри шапку файла.`);
    const [, name, value] = m;
    switch (name) {
      case 'games': opts.games = Number(value); break;
      case 'a': opts.a = value; break;
      case 'b': opts.b = value; break;
      case 'matrix': opts.matrix = value; break;
      case 'configs': opts.configs = parseConfigList(value); break;
      case 'throw-in': opts.throwIn = value; break;
      case 'json': opts.json = value; break;
      case 'baseline': opts.baseline = value; break;
      case 'seed': opts.seed = Number(value); break;
      case 'target': opts.target = parseConfigList(value).map(([p, d]) => configKey(p, d)); break;
      case 'no-gate': opts.gate = false; break;
      case 'gate': opts.gate = value !== 'off' && value !== 'false'; break;
      case 'date': opts.date = value; break;
      case 'quiet': opts.quiet = true; break;
      case 'a-flag': opts.aFlags = parseFlagList(value); break;
      case 'b-flag': opts.bFlags = parseFlagList(value); break;
      case 'solver-nodes': opts.solverNodes = Number(value); break;
      case 'solver-ms': opts.solverMs = Number(value); break;
      case 'help': opts.help = true; break;
      default: throw new Error(`Неизвестный флаг "--${name}". Смотри шапку файла.`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Статистика
// ---------------------------------------------------------------------------

const Z95 = 1.96;

// Доля «дурака» у A в процентах + стандартная ошибка доли: SE ≈ √(p(1−p)/n).
function share(durakA, decided) {
  if (!decided) return { durakPct: null, se: null, ci95: null };
  const p = durakA / decided;
  const se = Math.sqrt((p * (1 - p)) / decided);
  return {
    durakPct: round2(p * 100),
    se: round2(se * 100),
    ci95: round2(Z95 * se * 100),
  };
}

// Округление до 2 знаков без «-0» и без плавающего мусора вида 48.000000000000004.
function round2(x) {
  const v = Math.round(x * 100) / 100;
  return Object.is(v, -0) ? 0 : v;
}

// ---------------------------------------------------------------------------
// Прогон одной конфигурации
// ---------------------------------------------------------------------------

function runConfig({ players, deckSize, throwInPolicy, games, levelA, levelB, seed, brainA = {}, brainB = {} }) {
  let errors = 0;
  let stuck = 0;
  let draws = 0;
  let played = 0;
  let durakA = 0;
  let durakB = 0;
  let totalSteps = 0;
  const firstErrors = [];

  const startedAt = Date.now();
  for (let g = 0; g < games; g++) {
    const direction = g % 2; // чередуем стороны: половина партий A на 1-м месте, половина — на 2-м
    const levels = seatLevels(levelA, levelB, players, direction);
    // Свой seed на каждую партию: результат конфигурации не зависит от того,
    // какие конфигурации гонялись до неё и в каком порядке.
    const rng = mulberry32(hash32(`${seed}|${players}x${deckSize}|${throwInPolicy}|${g}`));
    try {
      // Опции «мозга» по местам: у стороны A — brainA, у стороны B — brainB (см. --a-flag / --b-flag).
      const seatOptions = levels.map((_, seat) => (seatBelongsToA(seat, direction) ? brainA : brainB));
      const res = playOneGame(levels, deckSize, players, false, { rng, throwInPolicy, seatOptions });
      played++;
      totalSteps += res.steps;
      if (res.stuck) stuck++;
      if (res.durakSeat < 0) draws++;
      else if (seatBelongsToA(res.durakSeat, direction)) durakA++;
      else durakB++;
    } catch (e) {
      errors++;
      if (firstErrors.length < 3) firstErrors.push(e.message);
    }
  }
  const seconds = (Date.now() - startedAt) / 1000;

  // Если уровни совпадают (калибровка simple vs simple), «сторона A» — это просто места,
  // которые в первой половине матча заняты уровнем A; ожидаемая доля ровно 50 %.
  const decided = durakA + durakB;
  const stats = share(durakA, decided);

  return {
    players,
    deckSize,
    throwInPolicy,
    games: played,
    decided,
    durakA,
    durakPct: stats.durakPct,
    se: stats.se,
    ci95: stats.ci95,
    errors,
    stuck,
    draws,
    avgSteps: played ? round2(totalSteps / played) : null,
    // Скорость в JSON НЕ пишем — она зависит от машины и ломала бы побайтовое сравнение прогонов.
    _gamesPerSec: seconds > 0 ? played / seconds : null,
    _firstErrors: firstErrors,
  };
}

// ---------------------------------------------------------------------------
// Baseline и дельты
// ---------------------------------------------------------------------------

function loadBaseline(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  const byKey = new Map();
  for (const c of data.configs || []) byKey.set(configKey(c.players, c.deckSize), c);
  return { data, byKey };
}

// Δ = текущая доля − baseline. Значимой считаем, если |Δ| > 1,96 · SE разности,
// где SE разности = √(SE_now² + SE_base²) (независимые выборки).
function deltaVsBaseline(now, base) {
  if (!base || now.durakPct == null || base.durakPct == null) return null;
  const delta = round2(now.durakPct - base.durakPct);
  const seDiff = Math.sqrt((now.se || 0) ** 2 + (base.se || 0) ** 2);
  return { delta, seDiff: round2(seDiff), significant: Math.abs(delta) > Z95 * seDiff };
}

// ---------------------------------------------------------------------------
// Вывод
// ---------------------------------------------------------------------------

function fmtPct(x) {
  return x == null ? '—' : `${x.toFixed(2)} %`;
}

function markdownTable(rows, withDelta) {
  const head = ['конфигурация', 'партий', 'доля «дурака» A', '95 % ДИ', ...(withDelta ? ['Δ к baseline'] : []), 'ничьи', 'ошибки', 'зависания', 'партий/с'];
  const lines = [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
  ];
  for (const r of rows) {
    const cells = [
      `${r.players}×${r.deckSize}`,
      String(r.games),
      fmtPct(r.durakPct),
      r.ci95 == null ? '—' : `± ${r.ci95.toFixed(2)}`,
      ...(withDelta
        ? [r._delta
            ? `${r._delta.delta >= 0 ? '+' : ''}${r._delta.delta.toFixed(2)}${r._delta.significant ? ' **!**' : ''}`
            : '—']
        : []),
      String(r.draws),
      String(r.errors),
      String(r.stuck),
      r._gamesPerSec == null ? '—' : r._gamesPerSec.toFixed(0),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Критерий приёмки (раздел 2 roadmap)
// ---------------------------------------------------------------------------

const TARGET_LIMIT = 48; // целевые конфигурации: доля «дурака» у A должна быть ≤ 48 %
const OTHER_LIMIT = 51;  // все остальные: не хуже шума, ≤ 51 %

function checkAcceptance(rows, targets) {
  const failures = [];
  for (const r of rows) {
    const key = configKey(r.players, r.deckSize);
    const limit = targets.includes(key) ? TARGET_LIMIT : OTHER_LIMIT;
    if (r.durakPct == null) {
      failures.push(`${key}: нет результативных партий`);
      continue;
    }
    if (r.durakPct > limit) {
      failures.push(`${key}: ${r.durakPct.toFixed(2)} % > ${limit} %${targets.includes(key) ? ' (целевая)' : ''}`);
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `Прогонщик матрицы конфигураций (issue #46).

  node scripts/evalBots.js [--games=10000] [--a=smart] [--b=simple]
                           [--matrix=main|quick|full] [--configs=2x24,4x36]
                           [--throw-in=all|neighbors|attackerOnly]
                           [--json=bench/run.json] [--baseline=bench/baseline.json]
                           [--seed=<n>] [--target=4x24,4x36] [--no-gate]
                           [--date=<ISO>] [--quiet]
                           [--a-flag=exactEndgameSolver] [--b-flag=...]
                           [--solver-nodes=20000] [--solver-ms=200]

  --target   целевые конфигурации: доля «дурака» у A должна быть ≤ ${TARGET_LIMIT} %,
             у остальных ≤ ${OTHER_LIMIT} %. Не выполнено — ненулевой код возврата.
  --a-flag   включить флаги профиля умного бота стороне A (через запятую); --b-flag — стороне B.
             Так сравнивают «новую версию» с «текущей»: --a=smart --b=smart --a-flag=exactEndgameSolver.
  --solver-nodes / --solver-ms  бюджет решателя концовки (по умолчанию — как в игре: 400000 узлов, 2000 мс).
  --no-gate  не проверять критерий приёмки (короткий контроль в CI: только ошибки и зависания).
  --date     проставить дату в JSON. Без него дата не пишется — чтобы два прогона
             с одним --seed давали побайтово одинаковый файл.
`;

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }

  const levelA = normalizeBotLevel(opts.a);
  const levelB = normalizeBotLevel(opts.b);
  for (const [raw, norm] of [[opts.a, levelA], [opts.b, levelB]]) {
    if (String(raw).trim().toLowerCase() !== norm) {
      console.warn(
        `Предупреждение: неизвестный уровень "${raw}" — использую "${norm}". ` +
          `Доступные уровни: ${BOT_LEVELS.map((l) => l.id).join(', ')}.`,
      );
    }
  }

  // Флаги профиля умного бота для сторон A/B и бюджет решателя концовки.
  const buildBrain = (flags) => {
    const brain = {};
    if (flags.length) {
      const unknown = flags.filter((f) => !(f in SMART_PROFILE));
      if (unknown.length) {
        console.error(`Неизвестные флаги профиля: ${unknown.join(', ')}. Есть: ${Object.keys(SMART_PROFILE).join(', ')}.`);
        process.exit(2);
      }
      brain.profile = Object.fromEntries(flags.map((f) => [f, true]));
    }
    const solver = {};
    if (opts.solverNodes != null) solver.maxNodes = opts.solverNodes;
    if (opts.solverMs != null) solver.maxMs = opts.solverMs;
    if (Object.keys(solver).length) brain.solver = solver;
    return brain;
  };
  const brainA = buildBrain(opts.aFlags);
  const brainB = buildBrain(opts.bFlags);

  if (!Number.isFinite(opts.games) || opts.games < 1) {
    console.error('--games должно быть положительным числом.');
    process.exit(2);
  }
  if (!Number.isFinite(opts.seed)) {
    console.error('--seed должно быть числом.');
    process.exit(2);
  }

  const configs = (opts.configs || matrixByName(opts.matrix)).filter(([p, d]) => {
    if (isPlayableConfig(p, d)) return true;
    console.warn(`Предупреждение: конфигурация ${p}x${d} невозможна по правилам — пропускаю.`);
    return false;
  });
  if (configs.length === 0) {
    console.error('Не осталось ни одной допустимой конфигурации.');
    process.exit(2);
  }

  let baseline = null;
  if (opts.baseline) {
    try {
      baseline = loadBaseline(opts.baseline);
    } catch (e) {
      console.error(`Не удалось прочитать baseline "${opts.baseline}": ${e.message}`);
      process.exit(2);
    }
  }

  console.log('=== Матрица очных матчей ботов ===');
  console.log(`A: ${levelA} (${botLevelLabel(levelA)})  vs  B: ${levelB} (${botLevelLabel(levelB)})`);
  console.log(
    `Партий на конфигурацию: ${opts.games} | throwInPolicy: ${opts.throwIn} | seed: ${opts.seed} | конфигураций: ${configs.length}`,
  );
  if (opts.aFlags.length || opts.bFlags.length) {
    console.log(`Включённые флаги: A [${opts.aFlags.join(', ') || '—'}], B [${opts.bFlags.join(', ') || '—'}]`);
  }
  if (opts.solverNodes != null || opts.solverMs != null) {
    console.log(`Бюджет решателя концовки: узлов ${opts.solverNodes ?? 'по умолчанию'}, мс ${opts.solverMs ?? 'по умолчанию'}`);
  }
  if (opts.target.length) console.log(`Целевые конфигурации: ${opts.target.join(', ')}`);
  console.log('');

  const rows = [];
  for (const [players, deckSize] of configs) {
    const row = runConfig({
      players,
      deckSize,
      throwInPolicy: opts.throwIn,
      games: opts.games,
      levelA,
      levelB,
      seed: opts.seed,
      brainA,
      brainB,
    });
    if (baseline) row._delta = deltaVsBaseline(row, baseline.byKey.get(configKey(players, deckSize)));
    rows.push(row);
    if (!opts.quiet) {
      let line =
        `${String(`${players}×${deckSize}`).padEnd(6)} ` +
        `партий ${String(row.games).padStart(6)} | ` +
        `дурак A ${fmtPct(row.durakPct).padStart(8)} ± ${row.ci95 == null ? '—' : row.ci95.toFixed(2)} | ` +
        `ничьи ${row.draws} | ошибок ${row.errors} | зависаний ${row.stuck} | ` +
        `${row._gamesPerSec == null ? '—' : row._gamesPerSec.toFixed(0)} партий/с`;
      if (row._delta) {
        line += ` | Δ ${row._delta.delta >= 0 ? '+' : ''}${row._delta.delta.toFixed(2)}` +
          (row._delta.significant ? ' (значимо)' : '');
      }
      console.log(line);
      for (const msg of row._firstErrors) console.log(`   ошибка движка: ${msg}`);
    }
  }

  console.log('');
  console.log('--- Таблица для PR (Markdown) ---');
  console.log(markdownTable(rows, Boolean(baseline)));
  console.log('');

  const totals = rows.reduce(
    (acc, r) => ({
      games: acc.games + r.games,
      errors: acc.errors + r.errors,
      stuck: acc.stuck + r.stuck,
      draws: acc.draws + r.draws,
    }),
    { games: 0, errors: 0, stuck: 0, draws: 0 },
  );
  console.log(
    `Итого: ${totals.games} партий, ошибок движка ${totals.errors}, зависаний ${totals.stuck}, ничьих ${totals.draws}.`,
  );

  // --- JSON-снимок прогона -------------------------------------------------
  if (opts.json) {
    const snapshot = {
      version: 1,
      tool: 'scripts/evalBots.js',
      // Дата пишется только по явному --date: иначе два прогона с одним --seed
      // отличались бы байтами, а DoD требует побайтового совпадения.
      date: opts.date || null,
      levelA,
      levelB,
      seed: opts.seed,
      gamesPerConfig: opts.games,
      throwInPolicy: opts.throwIn,
      matrix: opts.configs ? 'custom' : opts.matrix,
      target: opts.target,
      ...(opts.aFlags.length || opts.bFlags.length ? { aFlags: opts.aFlags, bFlags: opts.bFlags } : {}),
      ...(opts.solverNodes != null || opts.solverMs != null ? { solver: { maxNodes: opts.solverNodes, maxMs: opts.solverMs } } : {}),
      configs: rows.map((r) => ({
        players: r.players,
        deckSize: r.deckSize,
        throwInPolicy: r.throwInPolicy,
        games: r.games,
        decided: r.decided,
        durakA: r.durakA,
        durakPct: r.durakPct,
        se: r.se,
        ci95: r.ci95,
        errors: r.errors,
        stuck: r.stuck,
        draws: r.draws,
        avgSteps: r.avgSteps,
      })),
    };
    const dir = path.dirname(opts.json);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(opts.json, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`JSON прогона сохранён: ${opts.json}`);
  }

  // --- Вердикт -------------------------------------------------------------
  let failed = false;
  if (totals.errors > 0 || totals.stuck > 0) {
    console.log(`ВЕРДИКТ: ПРОВАЛ — ошибок движка ${totals.errors}, зависаний ${totals.stuck}.`);
    failed = true;
  }

  if (!opts.gate) {
    console.log('Критерий приёмки не проверялся (--no-gate): смотрим только ошибки и зависания.');
  } else {
    const failures = checkAcceptance(rows, opts.target);
    if (failures.length === 0) {
      console.log(
        `ВЕРДИКТ: критерий приёмки выполнен — целевые ≤ ${TARGET_LIMIT} %, остальные ≤ ${OTHER_LIMIT} %.`,
      );
    } else {
      console.log(`ВЕРДИКТ: критерий приёмки НЕ выполнен (${failures.length} конфигураций):`);
      for (const f of failures) console.log(`  - ${f}`);
      failed = true;
    }
  }

  if (failed) process.exitCode = 1;
}

// Paired calibration shares the production match loop. Version factories are
// injected per seat; level names deliberately remain "smart" on both sides.
export function pairSeed(seed, players, deckSize, throwInPolicy, pairIndex) {
  return hash32(`${seed}|${players}x${deckSize}|${throwInPolicy}|${pairIndex}`);
}

// Ratio-of-sums CI with the independent unit = initial deal (two games).
// Normal approximation, descriptive only: no false precision for tiny samples
// or degenerate residuals. Report all denominators alongside it.
export function pairedShare(pairs) {
  const n = pairs.length;
  const losses = pairs.reduce((s, p) => s + p.lossesA, 0);
  const decided = pairs.reduce((s, p) => s + p.decided, 0);
  if (!decided) return { durakPct: null, ci95: null, se: null, ciWarning: 'no decided games' };
  const p = losses / decided;
  const residuals = pairs.map(x => x.lossesA - p * x.decided);
  const sumSquares = residuals.reduce((s, x) => s + x * x, 0);
  if (n < 2 || sumSquares === 0) return {
    durakPct: round2(p * 100), ci95: null, se: null,
    ciWarning: 'insufficient pairs or degenerate cluster variance',
  };
  const se = Math.sqrt(n / (n - 1) * sumSquares / decided ** 2);
  return {
    durakPct: round2(100 * p), se: round2(100 * se),
    ci95: [round2(100 * Math.max(0, p - Z95 * se)), round2(100 * Math.min(1, p + Z95 * se))],
    ciWarning: n < 30 ? 'small sample; asymptotic paired CI unreliable' : null,
  };
}

export function runPairedConfig({
  players, deckSize, throwInPolicy = 'all', pairs, seed,
  levelA = 'smart', levelB = 'smart', factoryA, factoryB,
  brainA = {}, brainB = {}, maxSteps,
}) {
  if (!Number.isSafeInteger(pairs) || pairs < 1) throw new Error('pairs must be a positive integer');
  const records = [];
  const clusters = [];
  const measurements = [];
  const initialDeals = [];
  for (let pair = 0; pair < pairs; pair++) {
    const dealSeed = pairSeed(seed, players, deckSize, throwInPolicy, pair);
    const cluster = { lossesA: 0, decided: 0 };
    let firstDeal = null;
    for (const direction of [0, 1]) {
      const levels = seatLevels(levelA, levelB, players, direction);
      const record = { pair, seed: dealSeed, direction };
      const choose = (a, b) => levels.map((_, seat) => seatBelongsToA(seat, direction) ? a : b);
      try {
        const result = playOneGame(levels, deckSize, players, false, {
          rng: mulberry32(dealSeed), throwInPolicy, maxSteps,
          seatFactories: choose(factoryA, factoryB),
          seatOptions: choose(brainA, brainB),
          verifyLegal: true, measure: true,
          onInitialDeal(deal) {
            const serialized = JSON.stringify(deal);
            if (direction === 0) {
              firstDeal = serialized;
              initialDeals.push({ pair, seed: dealSeed, deal });
            } else if (serialized !== firstDeal) {
              throw new Error('paired initial deal mismatch');
            }
            record.dealHash = createHash('sha256').update(serialized).digest('hex');
          },
        });
        record.steps = result.steps;
        record.status = result.stuck ? 'unfinished' : result.durakSeat < 0 ? 'draw' : 'decided';
        record.durakSeat = result.durakSeat;
        record.loser = record.status === 'decided'
          ? (seatBelongsToA(result.durakSeat, direction) ? 'A' : 'B') : null;
        record.drawReason = result.drawReason;
        if (record.status === 'decided') {
          cluster.decided++;
          if (record.loser === 'A') cluster.lossesA++;
        }
        // Timings are explicitly separate from deterministic outcomes.
        measurements.push({ pair, direction, ...result.metrics });
      } catch (e) {
        record.status = 'error';
        record.code = e.code ?? null;
        record.message = e.message;
      }
      records.push(record);
    }
    clusters.push(cluster);
  }
  const count = status => records.filter(r => r.status === status).length;
  const decided = count('decided');
  const durakA = records.filter(r => r.loser === 'A').length;
  return {
    players, deckSize, throwInPolicy, pairs, planned: pairs * 2,
    completed: decided + count('draw'), decided, durakA, durakB: decided - durakA,
    draws: count('draw'), unfinished: count('unfinished'), errors: count('error'),
    illegal: records.filter(r => r.code === 'ILLEGAL_ACTION').length,
    lossPctAllPlanned: round2(100 * durakA / (pairs * 2)),
    ...pairedShare(clusters),
    records, initialDeals, measurements,
  };
}

// Load complete bot dependency trees from clean, pinned checkouts, not a lone
// smartBot.js copied onto today's dependencies. The ENGINE stays the common one.
async function loadVersion(root) {
  root = path.resolve(root);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) {
    throw new Error(`Version checkout must have no tracked modifications: ${root}`);
  }
  const bots = await import(pathToFileURL(path.join(root, 'src/bots/index.js')).href);
  const policy = await import(pathToFileURL(path.join(root, 'src/bots/smartBot.js')).href);
  if (!policy.SMART_PROFILES || Object.values(policy.SMART_PROFILES).some(p => p.safeRoundAttack)) {
    throw new Error('Calibration requires existing profiles with safeRoundAttack=false (#70 unchanged)');
  }
  return {
    factory: bots.createBotBrain,
    metadata: { commit, profiles: policy.SMART_PROFILES, profileOverrides: null },
  };
}

function summarizeMeasurements(row) {
  const sides = Object.fromEntries(['A', 'B'].map(side => [side, { times: [], solver: {} }]));
  for (const m of row.measurements) {
    m.decisionMsBySeat.forEach((times, seat) => {
      const side = sides[seatBelongsToA(seat, m.direction) ? 'A' : 'B'];
      side.times.push(...times);
      for (const [key, value] of Object.entries(m.solverBySeat[seat] || {})) {
        side.solver[key] = (side.solver[key] || 0) + value;
      }
    });
  }
  return Object.fromEntries(Object.entries(sides).map(([side, { times, solver }]) => {
    times.sort((a, b) => a - b);
    const percentile = p => times.length ? times[Math.ceil(p * times.length) - 1] : null;
    return [side, {
      decisions: times.length,
      meanMs: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null,
      p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99),
      maxMs: times.at(-1) ?? null, over2000Ms: times.filter(t => t > 2000).length,
      // timedOut is the solver's combined budget status, NOT a wall-clock timeout count.
      solver,
    }];
  }));
}

export function pairedMarkdown(rows) {
  return [
    '| config/policy | pairs | completed/planned | loss A/decided | loss A % | paired 95% CI | draws | errors/illegal/unfinished |',
    '|---|---:|---:|---:|---:|---|---:|---|',
    ...rows.map(r => `| ${r.players}x${r.deckSize}/${r.throwInPolicy} | ${r.pairs} | ${r.completed}/${r.planned} | ${r.durakA}/${r.decided} | ${r.durakPct ?? '—'} | ${r.ci95?.join('–') ?? 'unavailable'}${r.ciWarning ? ' *' : ''} | ${r.draws} | ${r.errors}/${r.illegal}/${r.unfinished} |`),
    '',
    '* CI uses independent deal pairs; tiny samples/degenerate variance are not evidence of strength.',
  ].join('\n');
}

async function pairedMain(argv) {
  const opts = { pairs: 200, seed: 720072, group: 'old', newRoot: '.', oldRoot: null,
    configs: null, throwIn: 'all', solverNodes: 500, json: null };
  for (const arg of argv) {
    if (arg === '--paired') continue;
    if (arg === '--help') {
      console.log(`Paired calibration (existing matchCore engine):
  node scripts/evalBots.js --paired --old-root=/tmp/old --new-root=/tmp/new
    --group=old|self|simple --pairs=200 --seed=720072 --solver-nodes=500
    --json=bench/result.json [--configs=2x36,3x36,4x36]
    [--throw-in=all|neighbors|attackerOnly]
Default: 13 valid configs + 4x36 neighbors/attackerOnly (15 rows).
--pairs counts DEALS; each deal is played twice with exchanged sides.
No strength gate/baseline update. Technical errors produce exit 1.
Both checkouts must be clean; new-root defaults to current checkout.
Node budget deterministic, maxMs=Number.MAX_SAFE_INTEGER. Do not enable #70.`);
      return;
    }
    const m = /^--([^=]+)=(.+)$/.exec(arg);
    if (!m) throw new Error(`Expected --option=value, got ${arg}`);
    const [, name, value] = m;
    switch (name) {
      case 'pairs': opts.pairs = Number(value); break;
      case 'seed': opts.seed = Number(value); break;
      case 'solver-nodes': opts.solverNodes = Number(value); break;
      case 'group': opts.group = value; break;
      case 'old-root': opts.oldRoot = value; break;
      case 'new-root': opts.newRoot = value; break;
      case 'configs': opts.configs = parseConfigList(value); break;
      case 'throw-in': opts.throwIn = value; break;
      case 'json': opts.json = value; break;
      default: throw new Error(`Unknown paired option --${name}`);
    }
  }
  for (const key of ['pairs', 'solverNodes']) {
    if (!Number.isSafeInteger(opts[key]) || opts[key] < 1) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(opts.seed) || opts.seed < 0) throw new Error('seed must be a nonnegative integer');
  if (!['old', 'self', 'simple'].includes(opts.group)) throw new Error('group must be old|self|simple');
  if (!['all', 'neighbors', 'attackerOnly'].includes(opts.throwIn)) throw new Error('Invalid throw-in policy');
  if (!opts.json) throw new Error('--json is required (preserve all outcomes, including errors)');
  if (opts.group === 'old' && !opts.oldRoot) throw new Error('--old-root is required for group=old');
  if (opts.configs?.some(([p, d]) => !isPlayableConfig(p, d))) throw new Error('Invalid config; none silently skipped');
  const configs = opts.configs
    ? opts.configs.map(([p, d]) => [p, d, opts.throwIn])
    : [...MAIN_MATRIX.map(([p, d]) => [p, d, opts.throwIn]),
      ...(opts.throwIn === 'all' ? [[4, 36, 'neighbors'], [4, 36, 'attackerOnly']] : [])];
  const newVersion = await loadVersion(opts.newRoot);
  const opponent = opts.group === 'old' ? await loadVersion(opts.oldRoot) : newVersion;
  const solver = { maxNodes: opts.solverNodes, maxMs: Number.MAX_SAFE_INTEGER };
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const snapshot = {
    schema: 2, tool: 'scripts/evalBots.js --paired',
    toolCommit: git('rev-parse', 'HEAD'), toolDirty: !!git('status', '--porcelain', '--untracked-files=no'),
    engineCommit: git('rev-parse', 'HEAD'), group: opts.group,
    a: { level: 'smart', ...newVersion.metadata },
    b: { level: opts.group === 'simple' ? 'simple' : 'smart', ...opponent.metadata },
    solver, seed: opts.seed, pairsPerConfig: opts.pairs,
    seedAlgorithm: 'FNV1a(master|playersxdeck|throwInPolicy|pairIndex), mulberry32',
    pairing: 'same initial deck/hands, alternating side membership by seat parity',
    ciMethod: '95% normal cluster ratio-of-sums; independent unit=deal pair',
    baselineSha256: createHash('sha256').update(fs.readFileSync('bench/baseline.json')).digest('hex'),
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      release: os.release(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length },
    command: ['node', ...process.argv.slice(1)],
    plannedConfigs: configs, complete: false, configs: [],
  };
  if (snapshot.toolDirty) throw new Error('Commit runner/engine tracked changes before calibration');
  fs.mkdirSync(path.dirname(opts.json), { recursive: true });
  const save = () => {
    // Checkpoint after EVERY row; partial files explicitly marked incomplete.
    fs.writeFileSync(opts.json, JSON.stringify(snapshot, null, 2) + '\n');
    fs.writeFileSync(opts.json + '.md', pairedMarkdown(snapshot.configs) + '\n');
  };
  save();
  for (const [players, deckSize, throwInPolicy] of configs) {
    const row = runPairedConfig({
      players, deckSize, throwInPolicy, pairs: opts.pairs, seed: opts.seed,
      levelA: 'smart', levelB: snapshot.b.level,
      factoryA: newVersion.factory, factoryB: opponent.factory,
      brainA: { solver }, brainB: { solver },
    });
    row.latencyBySide = summarizeMeasurements(row);
    snapshot.configs.push(row);
    save();
    console.log(pairedMarkdown([row]));
  }
  snapshot.complete = true;
  snapshot.technicalAccepted = snapshot.configs.every(r => !r.errors && !r.illegal && !r.unfinished);
  snapshot.releaseDecision = 'deferred; baseline and #70 unchanged; no strength claim';
  save();
  if (!snapshot.technicalAccepted) process.exitCode = 1;
}

export { mulberry32, seatBelongsToA, MAIN_MATRIX };
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--paired')) pairedMain(process.argv.slice(2)).catch(e => {
    console.error(e.stack);
    process.exitCode = 2;
  });
  else main();
}
