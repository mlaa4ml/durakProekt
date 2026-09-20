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
import { normalizeBotLevel, botLevelLabel, BOT_LEVELS } from '../src/bots/index.js';
import { seatLevels, playOneGame } from '../src/cli/matchCore.js';

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

function runConfig({ players, deckSize, throwInPolicy, games, levelA, levelB, seed }) {
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
      const res = playOneGame(levels, deckSize, players, false, { rng, throwInPolicy });
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

  // Если уровни совпадают (калибровка simple vs simple), «A» — это просто чётные места
  // в первой половине матча; ожидаемая доля ровно 50 %.
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

  --target   целевые конфигурации: доля «дурака» у A должна быть ≤ ${TARGET_LIMIT} %,
             у остальных ≤ ${OTHER_LIMIT} %. Не выполнено — ненулевой код возврата.
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

main();
