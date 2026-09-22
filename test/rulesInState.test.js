// Правила партии в состоянии для бота (SMART_BOT_ROADMAP.md, этап 2, issue #47).
// Запуск: node --test test/
//
// Проверяем, что `game.getState(playerId)`:
//   1) отдаёт блок `rules` со всеми полями и производные `maxAttacksNow`,
//      `allowedThrowInRanks`, `throwInPlayers`;
//   2) НЕ ПОДГЛЯДЫВАЕТ: чужих рук нет, и ни одна карта из чужой руки не просочилась
//      в состояние где-то ещё (в том числе через новые поля);
//   3) согласован с `getLegalActions` — при всех трёх `throwInPolicy`;
//   4) остаётся JSON-сериализуемым (без Set/Map): его шлёт по сети server/rooms.js.
// А также, что умный бот и трекер читают `state.rules` безопасно и что от этого решения бота
// НЕ меняются (поведенческие правки — этапы 3–5).

import test from 'node:test';
import assert from 'node:assert/strict';

import { DurakGame } from '../src/game.js';
import { DEFAULT_RULES } from '../src/rules.js';
import { SmartBot, rulesOfState } from '../src/bots/smartBot.js';
import { CardTracker } from '../src/bots/memory.js';

const RULE_FIELDS = [
  'deckSize', 'numPlayers', 'handSize',
  'throwInPolicy', 'throwInAfterTake',
  'maxTableAttacks', 'attackLimitByDefenderHand',
  'allowPerevod', 'perevodOnlyOnFirstCard', 'perevodRequiresEnoughCards',
  'stallLimit', 'stallWarning',
];
const POLICIES = ['attackerOnly', 'neighbors', 'all'];
const MAX_STEPS = 4000;

// ------------------------------------------------------------------ помощники

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const makePlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
const cardId = (c) => `${c.suit}${c.rank}`;

/** Кто сейчас должен ходить: единственный игрок с непустым списком легальных действий. */
function actorOf(game) {
  const ids = game.players.map((p) => p.id).filter((id) => game.getLegalActions(id).length > 0);
  assert.ok(ids.length <= 1, `ходить одновременно могут сразу несколько игроков: ${ids}`);
  return ids[0] || null;
}

/** Случайное легальное действие; активные ходы (атака, отбой, перевод) выбираем чаще паса и взятия. */
function pickAction(legal, rng) {
  const active = legal.filter((a) => a.type !== 'pass' && a.type !== 'take');
  const pool = active.length > 0 && rng() < 0.75 ? active : legal;
  return pool[Math.floor(rng() * pool.length)];
}

/** Обходит состояние и собирает всё, что похоже на карту {suit, rank}, вместе с путём до неё. */
function collectCards(value, path = 'state', out = []) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectCards(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    if ('suit' in value && 'rank' in value) out.push({ path, card: value });
    for (const [k, v] of Object.entries(value)) collectCards(v, `${path}.${k}`, out);
  }
  return out;
}

/** Ищет в состоянии то, что не переживёт JSON: Set, Map, функции, NaN/Infinity, undefined вне hand. */
function findNonJson(value, path = 'state', out = []) {
  if (value === undefined) {
    if (!/\.hand$/.test(path)) out.push(`${path}: undefined`);
  } else if (typeof value === 'function' || typeof value === 'bigint' || typeof value === 'symbol') {
    out.push(`${path}: ${typeof value}`);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}: ${value}`);
  } else if (value instanceof Set || value instanceof Map) {
    out.push(`${path}: ${value.constructor.name}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findNonJson(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findNonJson(v, `${path}.${k}`, out);
  }
  return out;
}

/** Убирает undefined-поля так же, как это сделает JSON.stringify. */
function stripUndefined(value) {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (value && typeof value === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined) res[k] = stripUndefined(v);
    return res;
  }
  return value;
}

/** Общая (для всех игроков) часть нового состояния — то, что не должно зависеть от зрителя. */
const sharedPart = (s) => ({
  rules: s.rules,
  maxAttacksNow: s.maxAttacksNow,
  allowedThrowInRanks: s.allowedThrowInRanks,
  throwInPlayers: s.throwInPlayers,
});

/** Кто по политике вправе подкидывать, вычисленное независимо от движка — по публичным местам за столом. */
function expectedThrowInPlayers(state) {
  const ids = state.players.map((p) => p.id);
  const alive = (id) => !state.players.find((p) => p.id === id).out;
  const n = ids.length;
  const from = ids.indexOf(state.attacker);
  const defenderPos = ids.indexOf(state.defender);

  const circle = [];
  for (let i = 0; i < n; i++) {
    const id = ids[(from + i) % n];
    if (id !== state.defender && alive(id)) circle.push(id);
  }
  switch (state.rules.throwInPolicy) {
    case 'attackerOnly':
      return [state.attacker];
    case 'neighbors': {
      let after = null;
      for (let step = 1; step <= n; step++) {
        const id = ids[(defenderPos + step) % n];
        if (alive(id)) { after = id; break; }
      }
      return after && after !== state.attacker ? [state.attacker, after] : [state.attacker];
    }
    default:
      return circle;
  }
}

/**
 * Одна партия случайными легальными ходами. На каждом шаге для каждого игрока вызывается
 * `check(game, viewerId, state)`; `onStep(game, actor, action, before)` — вокруг каждого хода.
 */
function playRandomGame({ numPlayers, ruleOverrides = {}, seed, check, onStep }) {
  const rng = mulberry32(seed);
  const game = new DurakGame(makePlayers(numPlayers), { numPlayers, ...ruleOverrides }, rng);
  let steps = 0;
  while (game.phase !== 'finished') {
    assert.ok(++steps < MAX_STEPS, `партия не закончилась за ${MAX_STEPS} шагов (seed ${seed})`);
    const states = new Map(game.players.map((p) => [p.id, game.getState(p.id)]));
    if (check) for (const [id, st] of states) check(game, id, st);

    const actor = actorOf(game);
    assert.ok(actor, `нет ходящего игрока в фазе ${game.phase} (seed ${seed})`);
    const action = pickAction(game.getLegalActions(actor), rng);
    const before = states.get(actor);
    game.applyAction(actor, action);
    if (onStep) onStep(game, actor, action, before);
  }
  if (check) for (const p of game.players) check(game, p.id, game.getState(p.id));
  return game;
}

const CONFIGS = [
  { numPlayers: 2, deckSize: 24 },
  { numPlayers: 3, deckSize: 36 },
  { numPlayers: 4, deckSize: 36 },
  { numPlayers: 6, deckSize: 36 },
];

// ------------------------------------------------------------------ 1. блок rules

test('getState(id) содержит rules со всеми перечисленными полями и значениями партии', () => {
  const overrides = {
    deckSize: 36,
    handSize: 5,
    throwInPolicy: 'neighbors',
    throwInAfterTake: false,
    maxTableAttacks: 4,
    attackLimitByDefenderHand: false,
    allowPerevod: false,
    perevodOnlyOnFirstCard: false,
    perevodRequiresEnoughCards: false,
  };
  const game = new DurakGame(makePlayers(3), overrides, mulberry32(1));
  const { rules } = game.getState('p1');

  assert.deepEqual(Object.keys(rules).sort(), [...RULE_FIELDS].sort(), 'набор полей rules');
  assert.deepEqual(rules, { ...overrides, numPlayers: 3, stallLimit: DEFAULT_RULES.stallLimit, stallWarning: DEFAULT_RULES.stallWarning });
});

test('rules по умолчанию берутся из DEFAULT_RULES; numPlayers — по числу игроков', () => {
  const game = new DurakGame(makePlayers(2), {}, mulberry32(2));
  const { rules } = game.getState('p2');
  for (const f of RULE_FIELDS) {
    assert.equal(rules[f], f === 'numPlayers' ? 2 : DEFAULT_RULES[f], `поле ${f}`);
  }
});

test('rules защищён от порчи: объект заморожен, копия (structuredClone/JSON) правится безопасно', () => {
  const game = new DurakGame(makePlayers(2), {}, mulberry32(3));
  const state = game.getState('p1');

  assert.ok(Object.isFrozen(state.rules), 'rules должен быть заморожен');
  assert.throws(() => { state.rules.throwInPolicy = 'attackerOnly'; }, TypeError);
  assert.throws(() => { state.rules.maxTableAttacks = 1; }, TypeError);

  for (const copy of [structuredClone(state.rules), JSON.parse(JSON.stringify(state.rules))]) {
    copy.throwInPolicy = 'attackerOnly';
    copy.maxTableAttacks = 1;
  }
  assert.equal(game.rules.throwInPolicy, DEFAULT_RULES.throwInPolicy);
  assert.equal(game.rules.maxTableAttacks, DEFAULT_RULES.maxTableAttacks);
  assert.equal(game.getState('p1').rules.throwInPolicy, DEFAULT_RULES.throwInPolicy);
  assert.deepEqual(game.getState('p1').rules, state.rules);
});

// ------------------------------------------------------------------ 2. «не подглядывает»

test('не подглядывает: чужих рук нет, и ни одна чужая карта не просочилась в состояние', () => {
  let checked = 0;
  for (const cfg of CONFIGS) {
    for (const throwInPolicy of POLICIES) {
      playRandomGame({
        ...cfg,
        ruleOverrides: { deckSize: cfg.deckSize, throwInPolicy },
        seed: 100 + cfg.numPlayers,
        check(game, viewerId, state) {
          checked++;
          const opponentCards = new Set();
          for (const p of game.players) {
            if (p.id !== viewerId) p.hand.forEach((c) => opponentCards.add(cardId(c)));
          }

          for (const sp of state.players) {
            if (sp.id === viewerId) {
              const own = game.players.find((p) => p.id === viewerId);
              assert.ok(Array.isArray(sp.hand), 'своя рука должна быть видна');
              assert.equal(sp.hand.length, sp.handCount);
              assert.deepEqual(sp.hand.map(cardId).sort(), own.hand.map(cardId).sort());
            } else {
              assert.equal(sp.hand, undefined, `рука ${sp.id} видна игроку ${viewerId}`);
            }
          }

          // Ни в rules, ни в производных полях, ни где-либо ещё нет карт из чужих рук.
          const ownHand = state.players.find((p) => p.id === viewerId).hand;
          const own = new Set(ownHand.map(cardId));
          for (const { path, card } of collectCards(state)) {
            if (own.has(cardId(card)) && /\.hand\[/.test(path)) continue;
            // Козырная карта открыта всем с первого хода; когда прикуп кончается, она уходит
            // в чью-то руку, оставаясь публичной, — это не утечка.
            if (path === 'state.trumpCard') continue;
            assert.ok(!opponentCards.has(cardId(card)), `чужая карта ${cardId(card)} утекла в ${path}`);
          }
        },
      });
    }
  }
  assert.ok(checked > 500, `слишком мало проверок: ${checked}`);
});

test('новые поля одинаковы для всех игроков — от зрителя они не зависят', () => {
  for (const cfg of CONFIGS) {
    playRandomGame({
      ...cfg,
      ruleOverrides: { deckSize: cfg.deckSize },
      seed: 200 + cfg.numPlayers,
      check(game) {
        const ref = sharedPart(game.getState(game.players[0].id));
        for (const p of game.players) assert.deepEqual(sharedPart(game.getState(p.id)), ref);
        assert.deepEqual(sharedPart(game.getState()), ref, 'getState() без игрока — то же самое');
      },
    });
  }
});

// ------------------------------------------------------------------ 3. согласованность с getLegalActions

test('allowedThrowInRanks совпадает с рангами легальных атак — при attackerOnly / neighbors / all', () => {
  let throwIns = 0;
  for (const cfg of CONFIGS) {
    for (const throwInPolicy of POLICIES) {
      for (const seed of [11, 12, 13]) {
        playRandomGame({
          ...cfg,
          ruleOverrides: { deckSize: cfg.deckSize, throwInPolicy },
          seed: seed * 10 + cfg.numPlayers,
          check(game, viewerId, state) {
            const legal = game.getLegalActions(viewerId);
            const attacks = legal.filter((a) => a.type === 'attack');
            if (state.phase !== 'need-attack' || legal.length === 0) {
              assert.equal(attacks.length, 0, 'атаковать можно только в фазе need-attack');
              return;
            }
            throwIns++;
            const allowed = state.allowedThrowInRanks;
            assert.ok(allowed === null || Array.isArray(allowed), 'массив или null, но не Set');

            const hand = state.players.find((p) => p.id === viewerId).hand;
            const fits = (c) => allowed === null || allowed.includes(c.rank);
            const expected = state.maxAttacksNow > 0 ? hand.filter(fits) : [];

            assert.deepEqual(
              attacks.map((a) => cardId(a.card)).sort(),
              expected.map(cardId).sort(),
              `${throwInPolicy}: легальные атаки не совпали с allowedThrowInRanks=${JSON.stringify(allowed)}, ` +
              `maxAttacksNow=${state.maxAttacksNow}`,
            );
            for (const a of attacks) {
              if (allowed !== null) assert.ok(allowed.includes(a.card.rank), 'ранг атаки вне allowedThrowInRanks');
            }
            assert.ok(state.throwInPlayers.includes(viewerId), 'подкидывающий обязан быть в throwInPlayers');
          },
        });
      }
    }
  }
  assert.ok(throwIns > 100, `слишком мало ситуаций подкидывания: ${throwIns}`);
});

test('allowedThrowInRanks: null на пустом столе в начале раунда, иначе — ранги стола по возрастанию', () => {
  let nullSeen = 0;
  let ranksSeen = 0;
  for (const cfg of CONFIGS) {
    playRandomGame({
      ...cfg,
      ruleOverrides: { deckSize: cfg.deckSize },
      seed: 300 + cfg.numPlayers,
      check(game, viewerId, state) {
        if (viewerId !== 'p1' || state.finished) return;
        const allowed = state.allowedThrowInRanks;
        if (state.table.length === 0) {
          assert.equal(allowed, null, 'пустой стол в начале раунда: разрешено всё');
          nullSeen++;
        } else {
          const onTable = new Set();
          for (const t of state.table) {
            onTable.add(t.attack.rank);
            if (t.defense) onTable.add(t.defense.rank);
          }
          assert.deepEqual(allowed, [...onTable].sort((a, b) => a - b));
          ranksSeen++;
        }
      },
    });
  }
  assert.ok(nullSeen > 0 && ranksSeen > 0);
});

test('throwInPlayers соответствует throwInPolicy для 2–6 игроков', () => {
  const seenPolicies = new Set();
  for (const cfg of CONFIGS) {
    for (const throwInPolicy of POLICIES) {
      playRandomGame({
        ...cfg,
        ruleOverrides: { deckSize: cfg.deckSize, throwInPolicy },
        seed: 400 + cfg.numPlayers,
        check(game, viewerId, state) {
          if (viewerId !== 'p1' || state.finished) return;
          assert.deepEqual(state.throwInPlayers, expectedThrowInPlayers(state), `${throwInPolicy}, ${cfg.numPlayers} игр.`);
          assert.ok(!state.throwInPlayers.includes(state.defender), 'защищающийся не подкидывает');
          seenPolicies.add(throwInPolicy);
        },
      });
    }
  }
  assert.equal(seenPolicies.size, 3);
});

test('maxAttacksNow: на старте раунда = min(maxTableAttacks, рука защитника), каждая атака уменьшает его на 1', () => {
  let roundStarts = 0;
  let attacksChecked = 0;
  const variants = [
    { attackLimitByDefenderHand: true, maxTableAttacks: 6 },
    { attackLimitByDefenderHand: true, maxTableAttacks: 3 },
    { attackLimitByDefenderHand: false, maxTableAttacks: 4 },
  ];
  for (const cfg of CONFIGS) {
    for (const variant of variants) {
      playRandomGame({
        ...cfg,
        ruleOverrides: { deckSize: cfg.deckSize, ...variant },
        seed: 500 + cfg.numPlayers,
        check(game, viewerId, state) {
          if (viewerId !== 'p1' || state.finished) return;
          assert.ok(Number.isInteger(state.maxAttacksNow) && state.maxAttacksNow >= 0);
          assert.ok(state.maxAttacksNow <= variant.maxTableAttacks);
          if (state.table.length === 0 && state.allowedThrowInRanks === null) {
            const defenderCards = state.players.find((p) => p.id === state.defender).handCount;
            const expected = variant.attackLimitByDefenderHand
              ? Math.min(variant.maxTableAttacks, defenderCards)
              : variant.maxTableAttacks;
            assert.equal(state.maxAttacksNow, expected, 'начало раунда');
            roundStarts++;
          }
        },
        onStep(game, actor, action, before) {
          if (action.type !== 'attack') return;
          const after = game.getState(actor);
          if (after.finished || after.defender !== before.defender) return; // новый раунд / перевод
          assert.equal(after.maxAttacksNow, before.maxAttacksNow - 1, 'атака должна тратить ровно одну единицу лимита');
          attacksChecked++;
        },
      });
    }
  }
  assert.ok(roundStarts > 50 && attacksChecked > 100, `мало проверок: ${roundStarts}/${attacksChecked}`);
});

test('maxAttacksNow = 0 → никто не может атаковать; лимит по руке защитника реально работает', () => {
  // Стол на 2 карты: у защитника на начало раунда было 2 карты — больше двух атак не положить.
  let zeroSeen = 0;
  for (const cfg of CONFIGS) {
    playRandomGame({
      ...cfg,
      ruleOverrides: { deckSize: cfg.deckSize, maxTableAttacks: 2 },
      seed: 600 + cfg.numPlayers,
      check(game, viewerId, state) {
        if (state.finished || state.maxAttacksNow > 0) return;
        zeroSeen++;
        const attacks = game.getLegalActions(viewerId).filter((a) => a.type === 'attack');
        assert.equal(attacks.length, 0, `лимит исчерпан, а ${viewerId} может атаковать`);
      },
    });
  }
  assert.ok(zeroSeen > 0, 'лимит ни разу не исчерпался — тест ничего не проверил');
});

test('throwInAfterTake=false: после взятия подкидывать некому, состояние всё равно согласовано', () => {
  for (const cfg of CONFIGS) {
    playRandomGame({
      ...cfg,
      ruleOverrides: { deckSize: cfg.deckSize, throwInAfterTake: false },
      seed: 700 + cfg.numPlayers,
      check(game, viewerId, state) {
        if (viewerId !== 'p1' || state.finished) return;
        assert.equal(state.rules.throwInAfterTake, false);
        assert.deepEqual(state.throwInPlayers, expectedThrowInPlayers(state));
      },
    });
  }
});

test('после конца партии: подкидывать нельзя, поля пустые, но присутствуют', () => {
  const game = playRandomGame({ numPlayers: 3, ruleOverrides: { deckSize: 36 }, seed: 800 });
  const state = game.getState('p1');
  assert.equal(state.finished, true);
  assert.equal(state.maxAttacksNow, 0);
  assert.deepEqual(state.allowedThrowInRanks, []);
  assert.deepEqual(state.throwInPlayers, []);
  assert.deepEqual(Object.keys(state.rules).sort(), [...RULE_FIELDS].sort());
});

// ------------------------------------------------------------------ 4. сериализуемость

test('состояние JSON-сериализуемо: нет Set/Map, JSON.parse(JSON.stringify(state)) не теряет полей', () => {
  let checked = 0;
  for (const cfg of CONFIGS) {
    for (const throwInPolicy of POLICIES) {
      playRandomGame({
        ...cfg,
        ruleOverrides: { deckSize: cfg.deckSize, throwInPolicy },
        seed: 900 + cfg.numPlayers,
        check(game, viewerId, state) {
          checked++;
          assert.deepEqual(findNonJson(state), [], 'в состоянии есть то, что не переживёт JSON');

          const roundTrip = JSON.parse(JSON.stringify(state));
          assert.deepEqual(roundTrip, stripUndefined(state), 'JSON потерял или исказил поля');
          for (const key of ['rules', 'maxAttacksNow', 'allowedThrowInRanks', 'throwInPlayers']) {
            assert.ok(key in roundTrip, `после JSON пропало поле ${key}`);
          }
          assert.deepEqual(Object.keys(roundTrip.rules).sort(), [...RULE_FIELDS].sort());
        },
      });
    }
  }
  assert.ok(checked > 300);
});

// ------------------------------------------------------------------ 5. бот и память

test('rulesOfState: берёт state.rules, а без него выводит числа из состояния и не падает', () => {
  const game = new DurakGame(makePlayers(4), { deckSize: 36, throwInPolicy: 'neighbors' }, mulberry32(5));
  const state = game.getState('p1');

  assert.deepEqual(rulesOfState(state), { ...DEFAULT_RULES, ...state.rules }, 'значения из state.rules главнее умолчаний');
  assert.equal(rulesOfState(state).throwInPolicy, 'neighbors');

  const legacy = { ...state };
  delete legacy.rules;
  const fallback = rulesOfState(legacy);
  assert.equal(fallback.numPlayers, 4, 'число игроков — из состояния');
  assert.equal(fallback.deckSize, 36, 'размер колоды — по картам');
  assert.equal(fallback.throwInPolicy, DEFAULT_RULES.throwInPolicy, 'остальное — по умолчанию');

  for (const junk of [null, undefined, {}, { players: null }, { rules: null }, { rules: 'x' }]) {
    assert.doesNotThrow(() => rulesOfState(junk));
    assert.equal(rulesOfState(junk).throwInPolicy, DEFAULT_RULES.throwInPolicy);
  }
});

test('SmartBot видит правила партии (bot.rules) и не падает на состоянии без rules', () => {
  const game = new DurakGame(makePlayers(3), { deckSize: 36, throwInPolicy: 'attackerOnly' }, mulberry32(6));
  const actor = actorOf(game);
  const legal = game.getLegalActions(actor);

  const bot = new SmartBot({ meId: actor });
  bot.observe(game.getState(actor), actor);
  assert.equal(bot.rules.throwInPolicy, 'attackerOnly');
  assert.equal(bot.rules.numPlayers, 3);
  assert.equal(bot.rules.deckSize, 36);

  // Старое состояние (например, от устаревшего сетевого клиента): поля rules нет вообще.
  const stale = game.getState(actor);
  delete stale.rules;
  const legacyBot = new SmartBot({ meId: actor });
  legacyBot.observe(stale, actor);
  assert.equal(legacyBot.rules.numPlayers, 3, 'число игроков выводится из состояния');
  assert.equal(legacyBot.rules.deckSize, 36, 'размер колоды выводится по картам');

  const decision = legacyBot.decide(stale, actor, legal);
  assert.ok(legal.includes(decision.action), 'бот вернул действие вне списка легальных');
});

test('поведение бота не изменилось: с state.rules и без него решения совпадают ход в ход', () => {
  // Решатель концовки (issue #48) по замыслу требует настоящих `state.rules` (`canSolve` без них отказывает:
  // лучше эвристика, чем позиция с угаданными правилами), поэтому «с правилами» и «без правил» он ведёт себя
  // по-разному — и это не ошибка. Тест проверяет, что ЭВРИСТИКА не зависит от способа получения правил,
  // потому решатель здесь выключен у обоих ботов.
  const NO_SOLVER = { exactEndgameSolver: false };
  let decisions = 0;
  for (const cfg of CONFIGS) {
    const rng = mulberry32(1000 + cfg.numPlayers);
    const game = new DurakGame(makePlayers(cfg.numPlayers), { numPlayers: cfg.numPlayers, deckSize: cfg.deckSize }, rng);
    const withRules = new Map();
    const withoutRules = new Map();
    const strip = (s) => { const c = structuredClone(s); delete c.rules; return c; };
    for (const p of game.players) {
      withRules.set(p.id, new SmartBot({ meId: p.id, profile: NO_SOLVER }).reset(structuredClone(game.getState(p.id)), p.id));
      withoutRules.set(p.id, new SmartBot({ meId: p.id, profile: NO_SOLVER }).reset(strip(game.getState(p.id)), p.id));
    }

    let steps = 0;
    while (game.phase !== 'finished' && steps++ < MAX_STEPS) {
      for (const p of game.players) {
        const s = game.getState(p.id);
        withRules.get(p.id).observe(structuredClone(s), p.id);
        withoutRules.get(p.id).observe(strip(s), p.id);
      }
      const actor = actorOf(game);
      const legal = game.getLegalActions(actor);
      const a = withRules.get(actor).decide(structuredClone(game.getState(actor)), actor, legal);
      const b = withoutRules.get(actor).decide(strip(game.getState(actor)), actor, legal);
      assert.deepEqual(a.action, b.action, `решения разошлись (${cfg.numPlayers}×${cfg.deckSize}, шаг ${steps})`);
      decisions++;
      game.applyAction(actor, a.action);
    }
    assert.equal(game.phase, 'finished');
  }
  assert.ok(decisions > 100);
});

test('CardTracker.fromState берёт размер колоды из state.rules, а без него — угадывает как раньше', () => {
  const game = new DurakGame(makePlayers(2), { deckSize: 36 }, mulberry32(7));
  const state = game.getState('p1');

  assert.equal(CardTracker.fromState(state, 'p1').deckSize, 36);

  // Нарочно «кривое» состояние: карт на виду меньше, чем в колоде. Угадывание дало бы 24,
  // а правила знают точно.
  const partial = structuredClone(state);
  partial.talonCount = 0;
  partial.players[1].handCount = 1;
  assert.equal(CardTracker.fromState(partial, 'p1').deckSize, 36, 'правила важнее угадывания');

  const noRules = structuredClone(partial);
  delete noRules.rules;
  assert.equal(CardTracker.fromState(noRules, 'p1').deckSize, CardTracker.guessDeckSize(noRules));

  // Явная подсказка по-прежнему главнее всего.
  assert.equal(CardTracker.fromState(state, 'p1', 24).deckSize, 24);
  // Мусор в rules.deckSize не ломает инициализацию.
  const junk = structuredClone(state);
  junk.rules.deckSize = 999;
  assert.equal(CardTracker.fromState(junk, 'p1').deckSize, CardTracker.guessDeckSize(junk));
});
