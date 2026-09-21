// Точный решатель концовки (SMART_BOT_ROADMAP.md, этап 3, issue #48).
// Запуск: node --test
//
// Что проверяем:
//   A. Копии партии в движке (`clone`, `fromPosition`, `applyLegalAction`, тихий режим):
//      перебор идёт через сам DurakGame, поэтому копия обязана вести себя ровно как оригинал.
//   B. `canSolve` / `positionFromState`: когда решатель применим и как позиция собирается
//      из публичного состояния и известной руки соперника.
//   C. Сам решатель: ручные позиции с известным ответом (выиграно / проиграно / ничья /
//      единственный выигрывающий ход / выигрыш только через перевод) и сверка с НЕЗАВИСИМЫМ
//      эталоном — полным обходом графа партии и обратным анализом, без alpha-beta и таблиц.
//   D. Бюджет: решатель не бросает исключений, не виснет и честно говорит «не решено».
//   E. Умный бот за флагом `exactEndgameSolver`: ходы легальны, объяснения на русском и не
//      раскрывают неизвестного, с выключенным флагом решатель не вызывается.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { DurakGame } from '../src/game.js';
import { SUITS } from '../src/deck.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';
import { SmartBot, SMART_PROFILE } from '../src/bots/smartBot.js';
import {
  solveEndgame,
  canSolve,
  positionFromState,
  solveFromState,
  sameEndgameAction,
  DEFAULT_SOLVER_OPTIONS,
} from '../src/bots/endgame.js';

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

const RANK_BY_NAME = { J: 11, Q: 12, K: 13, A: 14 };
const NAME_BY_RANK = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
/** '10♠' | 'J♥' | 'A♣' → { suit, rank } */
const C = (s) => ({ suit: s.slice(-1), rank: RANK_BY_NAME[s.slice(0, -1)] || Number(s.slice(0, -1)) });
const cs = (c) => `${NAME_BY_RANK[c.rank] || c.rank}${c.suit}`;
const CARD_TOKEN = /(?:10|[2-9]|[JQKA])[♠♥♦♣]/g;

const makePlayers = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));

/**
 * Позиция из короткой записи. Игроки: 'a' (атакующий) и 'd' (защищающийся).
 *   table: ['10♠/-', '9♦/J♦'] — «атака/защита», '-' = не отбито.
 */
function makePosition({ trump, a, d, table = [], phase = 'need-attack', rules = {}, took = false, count = 0, handAtStart = null }) {
  const pairs = table.map((s) => {
    const [atk, def] = s.split('/');
    return { attack: C(atk), defense: def === '-' ? null : C(def) };
  });
  return {
    rules: { deckSize: 24, numPlayers: 2, ...rules },
    trumpSuit: trump,
    players: [{ id: 'a', hand: a.map(C) }, { id: 'd', hand: d.map(C) }],
    attacker: 'a',
    defender: 'd',
    phase,
    table: pairs,
    tookCards: took,
    allowAnyCardNow: phase === 'need-attack' && pairs.length === 0 && !took,
    attackCountThisRound: count,
    defenderHandAtStart: handAtStart ?? d.length + pairs.filter((p) => p.defense).length,
  };
}

const describeMove = (m) => (m.type === 'transfer' ? `transfer ${m.cards.map(cs).join('+')}` : m.card ? `${m.type} ${cs(m.card)}` : m.type);

/** Точный ключ состояния — без каких-либо упрощений, которыми пользуется решатель. */
function exactKey(g) {
  const hand = (p) => p.hand.map(cs).sort().join(' ');
  return JSON.stringify([
    g.phase, g.attackerIndex, g.defenderIndex, g.tookCards, g.postTakeMode, g.allowAnyCardNow,
    g.attackCountThisRound, g._defenderHandAtStart, g.throwInQueuePos, g.throwInQueue, [...g.passedPlayers],
    g.players.map(hand), g.table.map((t) => [cs(t.attack), t.defense ? cs(t.defense) : null]), g.durak,
  ]);
}

/**
 * ЭТАЛОН. Обходим весь граф партии и делаем обратный анализ (retrograde): победа — то, что
 * можно форсировать за конечное число ходов; всё, что не форсируется ни в победу, ни в поражение
 * (в том числе бесконечная игра по кругу), — ничья. Никаких отсечений и таблиц позиций: алгоритм
 * иной, чем у решателя, поэтому совпадение ответов — не «сам с собой».
 */
function referenceSolve(pos, { maxStates = 300000 } = {}) {
  const root = DurakGame.fromPosition(pos);
  const me = root.currentActorId();
  const opp = root.players.find((p) => p.id !== me).id;
  const nodes = new Map();
  const queue = [];
  const add = (g) => {
    const k = exactKey(g);
    let n = nodes.get(k);
    if (!n) {
      n = { g, terminal: g.phase === 'finished', actor: null, edges: [], val: 0 };
      if (n.terminal) n.val = g.durak === opp ? 1 : g.durak === me ? -1 : 0;
      nodes.set(k, n);
      queue.push(n);
      if (nodes.size > maxStates) throw new Error('эталон: слишком много состояний');
    }
    return n;
  };
  const rootNode = add(root);
  for (let i = 0; i < queue.length; i++) {
    const n = queue[i];
    if (n.terminal) continue;
    n.actor = n.g.currentActorId();
    for (const move of n.g.getLegalActions(n.actor)) {
      const c = n.g.clone();
      c.applyLegalAction(n.actor, move);
      n.edges.push({ move, to: add(c) });
    }
    n.g = null;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values()) {
      if (n.terminal || n.val !== 0 || n.edges.length === 0) continue;
      const vals = n.edges.map((e) => e.to.val);
      let v;
      if (n.actor === me) v = vals.some((x) => x === 1) ? 1 : vals.every((x) => x === -1) ? -1 : 0;
      else v = vals.some((x) => x === -1) ? -1 : vals.every((x) => x === 1) ? 1 : 0;
      if (v !== 0) { n.val = v; changed = true; }
    }
  }
  return {
    value: rootNode.val,
    player: me,
    moves: rootNode.edges.map((e) => ({ move: e.move, value: e.to.val })),
    states: nodes.size,
  };
}

/** Позиция из живой партии — для тестов, читает внутренности движка. */
function toPosition(g) {
  return {
    rules: { ...g.rules },
    trumpSuit: g.trumpSuit,
    trumpCard: g.trumpCard,
    players: g.players.map((p) => ({ id: p.id, hand: p.hand.map((c) => ({ ...c })) })),
    attacker: g.players[g.attackerIndex].id,
    defender: g.players[g.defenderIndex].id,
    phase: g.phase,
    table: g.table.map((t) => ({ attack: { ...t.attack }, defense: t.defense ? { ...t.defense } : null })),
    tookCards: g.tookCards,
    allowAnyCardNow: g.allowAnyCardNow,
    attackCountThisRound: g.attackCountThisRound,
    defenderHandAtStart: g._defenderHandAtStart,
  };
}

/** Случайная позиция начала раунда, затем 0..maxPlies случайных ходов вглубь раунда. */
function randomPosition(rng, { minCards = 1, maxCards = 3, maxPlies = 4, ranks = [9, 10, 11, 12, 13, 14], rules = {} } = {}) {
  const deck = [];
  for (const suit of SUITS) for (const rank of ranks) deck.push({ suit, rank });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const na = minCards + Math.floor(rng() * (maxCards - minCards + 1));
  const nd = minCards + Math.floor(rng() * (maxCards - minCards + 1));
  const pos = {
    rules: { deckSize: 24, numPlayers: 2, ...rules },
    trumpSuit: SUITS[Math.floor(rng() * SUITS.length)],
    players: [{ id: 'a', hand: deck.slice(0, na) }, { id: 'd', hand: deck.slice(na, na + nd) }],
    attacker: 'a',
    defender: 'd',
    phase: 'need-attack',
    table: [],
    allowAnyCardNow: true,
  };
  const g = DurakGame.fromPosition(pos);
  const plies = Math.floor(rng() * (maxPlies + 1));
  for (let i = 0; i < plies && g.phase !== 'finished'; i++) {
    const actor = g.currentActorId();
    const legal = g.getLegalActions(actor);
    g.applyLegalAction(actor, legal[Math.floor(rng() * legal.length)]);
  }
  return g.phase === 'finished' ? randomPosition(rng, { minCards, maxCards, maxPlies, ranks, rules }) : toPosition(g);
}

const bigSolve = (pos) => solveEndgame(pos, { maxNodes: 5e6, maxMs: 1e9 });
const valueOfMove = (ref, move) => ref.moves.find((m) => sameEndgameAction(m.move, move))?.value;

/** Кто сейчас должен ходить в живой партии. */
function actorOf(game) {
  const ids = game.players.map((p) => p.id).filter((id) => game.getLegalActions(id).length > 0);
  assert.ok(ids.length <= 1, `ходить одновременно могут сразу несколько игроков: ${ids}`);
  return ids[0] || null;
}

function pickRandom(list, rng) {
  return list[Math.floor(rng() * list.length)];
}

/**
 * Живая партия случайными легальными ходами; `onStep(game, actor, legal)` — перед каждым ходом.
 * Если onStep сам сделал ход в партии, он возвращает true, и ход по умолчанию пропускается.
 */
function playRandomGame({ numPlayers = 2, deckSize = 24, seed = 1, rules = {}, onStep }) {
  const rng = mulberry32(seed);
  const game = new DurakGame(makePlayers(numPlayers), { numPlayers, deckSize, ...rules }, rng);
  let steps = 0;
  while (game.phase !== 'finished') {
    assert.ok(++steps < 4000, `партия не закончилась (seed ${seed})`);
    const actor = actorOf(game);
    assert.ok(actor, 'нет ходящего игрока');
    const legal = game.getLegalActions(actor);
    // onStep вернул true — он сам сделал ход в партии (например, чтобы сравнить с копией).
    if (onStep && onStep(game, actor, legal) === true) continue;
    game.applyAction(actor, pickRandom(legal, rng));
  }
  return game;
}

/** Живая дуэль до момента, когда решатель применим; возвращает всё, что нужно для проверок. */
function findSolvableSpot(seed, deckSize = 24) {
  const rng = mulberry32(seed);
  const game = new DurakGame(makePlayers(2), { numPlayers: 2, deckSize }, rng);
  const bots = new Map(game.players.map((p) => [p.id, new SmartBot({ meId: p.id }).reset(game.getState(p.id), p.id)]));
  let steps = 0;
  while (game.phase !== 'finished' && steps++ < 3000) {
    const id = actorOf(game);
    const state = game.getState(id);
    const legal = game.getLegalActions(id);
    const bot = bots.get(id);
    bot.observe(state, id);
    if (canSolve(state, bot.tracker, id)) return { game, state, bot, id, legal };
    game.applyAction(id, bot.decide(state, id, legal).action);
  }
  return null;
}

// =================================================================== A. Копии партии в движке

test('clone(): копия совпадает с оригиналом по всем полям и не зависит от него', () => {
  let checked = 0;
  for (const [numPlayers, deckSize, seed] of [[2, 24, 1], [3, 36, 2], [4, 36, 3], [6, 52, 4]]) {
    const rng = mulberry32(seed + 100);
    playRandomGame({
      numPlayers, deckSize, seed,
      onStep(game, actor, legal) {
        const copy = game.clone();
        // Все собственные поля: если в движок добавят новое поле, а clone() его забудет — упадёт здесь.
        assert.deepStrictEqual({ ...copy }, { ...game }, 'clone() потерял или исказил поле');
        assert.notStrictEqual(copy.players[0].hand, game.players[0].hand, 'руки должны быть скопированы');
        assert.notStrictEqual(copy.table, game.table);

        // Независимость: ход в копии не двигает оригинал…
        const before = JSON.stringify(game.getState());
        const beforeLog = game.log.length;
        const move = pickRandom(legal, rng);
        copy.applyAction(actor, move);
        assert.equal(JSON.stringify(game.getState()), before, 'ход в копии изменил оригинал');
        assert.equal(game.log.length, beforeLog);

        // …а тот же ход в оригинале даёт то же самое, что вышло в копии.
        game.applyAction(actor, move);
        assert.deepStrictEqual(game.getState(), copy.getState(), 'копия и оригинал разошлись после одного хода');
        assert.deepStrictEqual(game.log, copy.log);
        checked++;
        return true;
      },
    });
  }
  assert.ok(checked > 300, `слишком мало проверок: ${checked}`);
});

test('лог движка: все сообщения — строки (ленивые сообщения не просочились), а тихая партия лога не ведёт', () => {
  for (const [numPlayers, deckSize, seed] of [[2, 24, 11], [3, 36, 12], [5, 52, 13]]) {
    const game = playRandomGame({ numPlayers, deckSize, seed });
    assert.ok(game.log.length > 5);
    assert.ok(game.log.every((m) => typeof m === 'string' && m.length > 0), 'в логе не строка');
    assert.ok(!game.log.some((m) => /undefined|\[object|=>/.test(m)), 'в логе мусор');
  }

  const pos = makePosition({ trump: '♦', a: ['J♥', '9♣'], d: ['Q♥'] });
  const silent = DurakGame.fromPosition(pos);
  assert.equal(silent.silent, true);
  const actor = silent.currentActorId();
  const move = silent.getLegalActions(actor)[0];
  assert.equal(silent.applyLegalAction(actor, move), null, 'тихая партия не собирает состояние');
  assert.deepEqual(silent.log, [], 'тихая партия не пишет лог');
  // Обычная партия по-прежнему возвращает состояние из applyAction.
  const loud = new DurakGame(makePlayers(2), {}, mulberry32(5));
  const id = actorOf(loud);
  const st = loud.applyAction(id, loud.getLegalActions(id)[0]);
  assert.ok(st && st.phase && Array.isArray(st.players));
});

test('applyLegalAction даёт то же, что applyAction, а applyAction по-прежнему отвергает нелегальное', () => {
  const rng = mulberry32(21);
  playRandomGame({
    numPlayers: 3, deckSize: 36, seed: 21,
    onStep(game, actor, legal) {
      const move = pickRandom(legal, rng);
      const viaLegal = game.clone();
      const viaApply = game.clone();
      viaLegal.applyLegalAction(actor, move);
      viaApply.applyAction(actor, move);
      assert.deepStrictEqual({ ...viaLegal }, { ...viaApply });
      assert.throws(() => game.applyAction(actor, { type: 'attack', card: { suit: '♠', rank: 1 } }), /Недопустимое действие/);
    },
  });
});

test('currentActorId совпадает с тем, у кого есть легальные действия', () => {
  for (const seed of [31, 32, 33]) {
    playRandomGame({
      numPlayers: 2 + (seed % 3), deckSize: 36, seed,
      onStep(game, actor) {
        assert.equal(game.currentActorId(), actor);
      },
    });
  }
  const done = playRandomGame({ seed: 34 });
  assert.equal(done.currentActorId(), null);
});

test('fromPosition(positionFromState(...)) ведёт партию так же, как настоящий движок, до самого конца', () => {
  let starts = 0;
  let steps = 0;
  for (const [numPlayers, deckSize] of [[2, 24], [2, 36], [3, 36], [4, 36]]) {
    for (let seed = 1; seed <= 12; seed++) {
      const rng = mulberry32(seed * 31 + numPlayers);
      let copy = null;
      let copyMe = null;
      playRandomGame({
        numPlayers, deckSize, seed: seed * 7,
        onStep(game, actor, legal) {
          // Сверка: копия и настоящая партия согласны о том, кто ходит и что ему можно.
          if (copy) {
            assert.equal(copy.currentActorId(), actor);
            const mine = copy.getLegalActions(actor);
            assert.equal(mine.length, legal.length, `число легальных ходов разошлось: ${mine.map(describeMove)} vs ${legal.map(describeMove)}`);
            assert.ok(legal.every((a) => mine.some((b) => sameEndgameAction(a, b))));
            const real = game.getState(actor);
            const cst = copy.getState();
            assert.equal(cst.maxAttacksNow, real.maxAttacksNow);
            assert.deepEqual(cst.allowedThrowInRanks, real.allowedThrowInRanks);
            assert.equal(cst.phase, real.phase);
            assert.equal(cst.table.length, real.table.length);
            const move = pickRandom(legal, rng);
            copy.applyLegalAction(actor, mine.find((b) => sameEndgameAction(move, b)));
            game.applyAction(actor, move);
            steps++;
            if (game.phase === 'finished') assert.equal(copy.durak, game.durak, 'исход партии разошёлся');
            return true;
          }
          // Старт копии: прикуп пуст и живых двое.
          const alive = game.players.filter((p) => !p.out);
          if (game.talon.length !== 0 || alive.length !== 2) return;
          const state = game.getState(actor);
          const opp = alive.find((p) => p.id !== actor);
          const position = positionFromState(state, actor, opp.hand);
          copy = DurakGame.fromPosition(position);
          copyMe = actor;
          starts++;
          assert.equal(copy.currentActorId(), copyMe);
          const move = pickRandom(legal, rng);
          const mine = copy.getLegalActions(actor);
          assert.equal(mine.length, legal.length, 'на старте копии число ходов разошлось');
          copy.applyLegalAction(actor, mine.find((b) => sameEndgameAction(move, b)));
          game.applyAction(actor, move);
          steps++;
          return true;
        },
      });
    }
  }
  assert.ok(starts >= 20, `слишком мало стартов: ${starts}`);
  assert.ok(steps > 100, `слишком мало сверенных шагов: ${steps}`);
});

test('positionFromState согласован с движком в КАЖДОМ состоянии концовки, в том числе посреди раунда', () => {
  let checked = 0;
  let midRound = 0;
  let limited = 0;
  for (const [numPlayers, deckSize, rules] of [
    [2, 24, {}], [2, 36, {}], [3, 36, {}], [2, 24, { attackLimitByDefenderHand: false }], [2, 36, { maxTableAttacks: 3 }],
    [2, 24, { allowPerevod: false }], [2, 24, { throwInAfterTake: false }],
  ]) {
    for (let seed = 1; seed <= 10; seed++) {
      playRandomGame({
        numPlayers, deckSize, seed: seed * 17 + deckSize, rules,
        onStep(game, actor, legal) {
          const alive = game.players.filter((p) => !p.out);
          if (game.talon.length !== 0 || alive.length !== 2) return;
          const state = game.getState(actor);
          const opp = alive.find((p) => p.id !== actor);
          const copy = DurakGame.fromPosition(positionFromState(state, actor, opp.hand));
          const cst = copy.getState();
          assert.equal(cst.maxAttacksNow, state.maxAttacksNow, `лимит стола разошёлся (${JSON.stringify(rules)}, стол ${state.table.length})`);
          assert.deepEqual(cst.allowedThrowInRanks, state.allowedThrowInRanks);
          assert.deepEqual(cst.throwInPlayers, state.throwInPlayers);
          assert.equal(cst.phase, state.phase);
          assert.equal(cst.tableGoingToDefender, state.tableGoingToDefender);
          const mine = copy.getLegalActions(actor);
          assert.equal(mine.length, legal.length);
          assert.ok(legal.every((a) => mine.some((b) => sameEndgameAction(a, b))));
          checked++;
          if (state.table.length > 0) midRound++;
          if (state.maxAttacksNow < (rules.maxTableAttacks ?? 6)) limited++;
        },
      });
    }
  }
  assert.ok(checked > 300, `слишком мало проверок: ${checked}`);
  assert.ok(midRound > 100, `мало состояний посреди раунда: ${midRound}`);
  assert.ok(limited > 50, `мало состояний с уже потраченным лимитом: ${limited}`);
});

// =================================================================== B. canSolve и позиция из состояния

test('canSolve: истинно только при пустом прикупе, двух живых и точно известной руке соперника', () => {
  const spot = findSolvableSpot(1);
  assert.ok(spot, 'в партии не нашлось момента, когда решатель применим');
  const { game, state, bot, id } = spot;

  assert.equal(canSolve(state, bot.tracker, id), true);

  // прикуп не пуст
  assert.equal(canSolve({ ...state, talonCount: 1 }, bot.tracker, id), false);
  // нет правил партии (старое состояние)
  const noRules = { ...state };
  delete noRules.rules;
  assert.equal(canSolve(noRules, bot.tracker, id), false);
  // рука соперника не восстановлена
  const uncertain = { isOpponentHandCertain: () => false, opponentKnownCards: () => new Set() };
  assert.equal(canSolve(state, uncertain, id), false);
  // «certain», но названа не вся рука
  const liar = { isOpponentHandCertain: () => true, opponentKnownCards: () => new Set() };
  assert.equal(canSolve(state, liar, id), false);
  // третий живой игрок → не дуэль
  const three = { ...state, players: [...state.players, { id: 'p3', handCount: 3, out: false }] };
  assert.equal(canSolve(three, bot.tracker, id), false);
  // мусор не роняет
  for (const junk of [null, undefined, {}, { talonCount: 0 }, { talonCount: 0, players: null, rules: {} }]) {
    assert.equal(canSolve(junk, bot.tracker, id), false);
  }
  assert.equal(canSolve(state, null, id), false);
  assert.equal(canSolve(state, bot.tracker, null), false);
  assert.equal(game.phase === 'finished', false);
});

// Здесь проверяется только canSolve, поэтому решателю нужен узкий бюджет: с боевым (2 с на ход) эти
// 25 партий занимали ~50 с из-за позиций, которые не решаются, и такие ходы упирались в лимит времени.
test('canSolve: в партии на 3+ игроков истинно, только когда осталось двое живых', () => {
  let trueSeen = 0;
  let threeAliveSeen = 0;
  for (let seed = 1; seed <= 25; seed++) {
    const rng = mulberry32(seed);
    const game = new DurakGame(makePlayers(3), { numPlayers: 3, deckSize: 36 }, rng);
    const bots = new Map(game.players.map((p) => [p.id, new SmartBot({ meId: p.id, solver: { maxNodes: 5000, maxMs: 1000 } }).reset(game.getState(p.id), p.id)]));
    let steps = 0;
    while (game.phase !== 'finished' && steps++ < 3000) {
      const id = actorOf(game);
      const state = game.getState(id);
      const legal = game.getLegalActions(id);
      const bot = bots.get(id);
      bot.observe(state, id);
      const alive = state.players.filter((p) => !p.out).length;
      const ok = canSolve(state, bot.tracker, id);
      if (alive === 3) { threeAliveSeen++; assert.equal(ok, false, 'на троих решатель включаться не должен'); }
      if (ok) trueSeen++;
      game.applyAction(id, bot.decide(state, id, legal).action);
    }
  }
  assert.ok(threeAliveSeen > 100);
  assert.ok(trueSeen > 0, 'после выхода одного игрока решатель ни разу не сработал');
});

test('positionFromState: позиция воспроизводит лимит стола и не зависит от изменений живой партии', () => {
  const spot = findSolvableSpot(2);
  assert.ok(spot);
  const { game, state, id } = spot;
  const oppId = state.players.find((p) => p.id !== id).id;
  const opp = game.players.find((p) => p.id === oppId);
  const position = positionFromState(state, id, opp.hand);

  // Копия, а не ссылки на живые массивы движка: партия идёт дальше, позиция не должна «портиться».
  const snapshot = JSON.stringify(position);
  game.applyAction(id, spot.legal[0]);
  assert.equal(JSON.stringify(position), snapshot, 'позиция ссылается на живые массивы движка');

  const probe = DurakGame.fromPosition(position);
  assert.equal(probe.getState().maxAttacksNow, state.maxAttacksNow);
  assert.equal(probe.currentActorId(), id);
});

test('canSolve отказывается в единственном неточном варианте: перевод после частичной защиты при лимите по руке защитника', () => {
  const spot = findSolvableSpot(4);
  assert.ok(spot);
  const { state, bot, id } = spot;
  const withDefended = (rules) => ({
    ...state,
    rules: { ...state.rules, ...rules },
    table: [{ attack: C('9♠'), defense: C('10♠') }],
  });
  // Размер руки защитника «на начало раунда» тут неизвестен, лимит стола не восстановить — решатель молчит.
  assert.equal(canSolve(withDefended({ allowPerevod: true, perevodOnlyOnFirstCard: false, attackLimitByDefenderHand: true }), bot.tracker, id), false);
  // Стоит убрать любое из трёх условий — позиция восстанавливается точно.
  assert.equal(canSolve(withDefended({ allowPerevod: false, perevodOnlyOnFirstCard: false, attackLimitByDefenderHand: true }), bot.tracker, id), true);
  assert.equal(canSolve(withDefended({ allowPerevod: true, perevodOnlyOnFirstCard: true, attackLimitByDefenderHand: true }), bot.tracker, id), true);
  assert.equal(canSolve(withDefended({ allowPerevod: true, perevodOnlyOnFirstCard: false, attackLimitByDefenderHand: false }), bot.tracker, id), true);
});

test('solveFromState: если позиция восстановлена с расхождением, результат помечен как неверный', () => {
  const spot = findSolvableSpot(3);
  assert.ok(spot);
  const { state, bot, id } = spot;

  const good = solveFromState(state, bot.tracker, id, { maxNodes: 200000, maxMs: 5000 });
  assert.ok(good && (good.solved || good.timedOut));

  const broken = solveFromState({ ...state, maxAttacksNow: state.maxAttacksNow + 1 }, bot.tracker, id);
  assert.equal(broken.solved, false);
  assert.equal(broken.action, null);
  assert.equal(broken.mismatch, true);

  assert.equal(solveFromState({ ...state, talonCount: 3 }, bot.tracker, id), null, 'неприменимо → null');
});

// =================================================================== C. Решатель: известные позиции

test('выиграно: атакующий отдаёт соперника его собственной нехваткой карт', () => {
  // Козырь ♣. У защитника одна карта, и она ничего не бьёт. Любая атака заставляет его взять;
  // а потом у атакующего остаётся ровно одна карта, и соперник берёт её тоже — атакующий выходит.
  const pos = makePosition({ trump: '♣', a: ['9♠', '10♠'], d: ['9♥'] });
  const res = bigSolve(pos);
  assert.equal(res.solved, true);
  assert.equal(res.win, true);
  assert.equal(res.value, 1);
  assert.equal(res.player, 'a');
  assert.equal(res.action.type, 'attack');
  assert.equal(referenceSolve(pos).value, 1, 'эталон согласен');
});

test('единственный выигрывающий ход атакующего: сначала отдать «мусор», который придётся взять', () => {
  // Козырь ♦. Атака 9♣: защитник Q♥ её не бьёт и берёт; следом валет ♥ бьётся дамой ♥, но карт
  // у атакующего уже нет — он выходит. Атака J♥ первой: дама ♥ бьёт валета, а 9♣ подкинуть нельзя
  // (лимит по руке защитника — одна карта) — дураком остаётся атакующий.
  const pos = makePosition({ trump: '♦', a: ['J♥', '9♣'], d: ['Q♥'] });
  const res = bigSolve(pos);
  const ref = referenceSolve(pos);
  assert.equal(res.value, 1);
  assert.equal(res.win, true);
  assert.equal(cs(res.action.card), '9♣');
  assert.equal(res.action.type, 'attack');
  assert.equal(valueOfMove(ref, { type: 'attack', card: C('J♥') }), -1, 'атака J♥ проигрывает');
  assert.equal(valueOfMove(ref, { type: 'attack', card: C('9♣') }), 1);
  assert.deepEqual(ref.moves.filter((m) => m.value === 1).length, 1, 'выигрывающий ход единственный');
});

test('проиграно: соперник всегда бьёт единственной картой, а подкинуть больше нечем', () => {
  // Козырь ♥. У защитника одна карта — лимит стола один раз, и он отбивает каждую атаку,
  // оставляя атакующего с лишней картой на руках.
  const pos = makePosition({ trump: '♥', a: ['10♥', 'J♦'], d: ['J♥'] });
  const res = bigSolve(pos);
  assert.equal(res.solved, true);
  assert.equal(res.win, false);
  assert.equal(res.value, -1);
  const ref = referenceSolve(pos);
  assert.equal(ref.value, -1);
  assert.ok(ref.moves.every((m) => m.value === -1), 'проигрывают все ходы');
  assert.ok(res.legal.some((m) => sameEndgameAction(m, res.action)), 'даже в проигрыше действие — легальное');
});

test('ничья: по одной карте, соперник может отбиться козырем — оба выходят одновременно', () => {
  // Козырь ♠. Атака A♥: если защитник берёт — выходит атакующий (проигрыш защитника), поэтому
  // он бьёт козырем 9♠, и обе руки пустеют в один момент.
  const pos = makePosition({ trump: '♠', a: ['A♥'], d: ['9♠'] });
  const res = bigSolve(pos);
  assert.equal(res.solved, true);
  assert.equal(res.value, 0);
  assert.equal(res.win, false);
  assert.equal(referenceSolve(pos).value, 0);
});

test('единственный выигрывающий ход защитника: отбить нужной картой, а не взять и не тратить козырь', () => {
  // Козырь ♥. Защитник Q♥/J♠ против 10♠. Отбить валетом ♠ — и следом дама ♥ выигрывает атаку
  // (у соперника дама ♦ её не бьёт). Отбить козырной дамой — проигрыш: соперник подкидывает
  // даму ♦, и валетом ♠ её не отбить. Взять — тоже проигрыш.
  const pos = makePosition({
    trump: '♥', a: ['Q♦'], d: ['Q♥', 'J♠'], table: ['10♠/-'], phase: 'defender-to-act', count: 1, handAtStart: 2,
  });
  const res = bigSolve(pos);
  const ref = referenceSolve(pos);
  assert.equal(res.player, 'd');
  assert.equal(res.value, 1);
  assert.equal(res.action.type, 'defend');
  assert.equal(cs(res.action.card), 'J♠');
  assert.equal(valueOfMove(ref, { type: 'defend', card: C('Q♥'), against: C('10♠') }), -1);
  assert.equal(valueOfMove(ref, { type: 'take' }), -1);
  assert.equal(ref.moves.filter((m) => m.value === 1).length, 1);
});

test('выигрыш только через перевод (allowPerevod: true) решается верно; без перевода позиция проиграна', () => {
  // Козырь ♦. Защитник не может отбить 10♦ (у него нет старших козырей) и, если брать, проигрывает.
  // Но у него есть 10♣ — перевод. Нападающий вынужден отбиваться от двух десяток, у него это не
  // выходит, он берёт, и защитник выходит последней картой K♣ (её бьёт козырь, но карт уже нет).
  const spec = { trump: '♦', a: ['K♦', '10♥'], d: ['10♣', 'K♣'], table: ['10♦/-'], phase: 'defender-to-act', count: 1, handAtStart: 2 };

  const withPerevod = makePosition({ ...spec, rules: { allowPerevod: true } });
  const res = bigSolve(withPerevod);
  const ref = referenceSolve(withPerevod);
  assert.equal(res.solved, true);
  assert.equal(res.win, true);
  assert.equal(res.action.type, 'transfer');
  assert.deepEqual(res.action.cards.map(cs), ['10♣']);
  assert.equal(ref.moves.filter((m) => m.value === 1).length, 1, 'единственный выигрывающий ход — перевод');
  assert.equal(valueOfMove(ref, { type: 'take' }), -1);

  const withoutPerevod = makePosition({ ...spec, rules: { allowPerevod: false } });
  const res2 = bigSolve(withoutPerevod);
  assert.equal(res2.solved, true);
  assert.equal(res2.win, false);
  assert.equal(res2.value, -1);
  assert.ok(!res2.legal.some((m) => m.type === 'transfer'), 'без перевода перевода в списке нет');
  assert.equal(referenceSolve(withoutPerevod).value, -1);
});

test('сверка с независимым эталоном: 300 случайных позиций, включая середину раунда, взятие и перевод', () => {
  const rng = mulberry32(2024);
  const stat = { win: 0, draw: 0, loss: 0 };
  let phases = new Set();
  for (let i = 0; i < 300; i++) {
    const rules = i % 3 === 0 ? { allowPerevod: false } : i % 3 === 1 ? {} : { perevodOnlyOnFirstCard: false };
    const pos = randomPosition(rng, { maxCards: 3, maxPlies: 4, rules });
    phases.add(`${pos.phase}${pos.tookCards ? '+take' : ''}`);
    const ref = referenceSolve(pos);
    const res = bigSolve(pos);
    assert.equal(res.solved, true, `не решено: ${JSON.stringify(pos)}`);
    assert.equal(res.value, ref.value, `значение разошлось с эталоном: ${JSON.stringify(pos)}`);
    assert.equal(res.win, ref.value === 1);
    assert.ok(res.action, 'действие не названо');
    assert.equal(valueOfMove(ref, res.action), ref.value, `действие ${describeMove(res.action)} не достигает оптимума`);
    stat[ref.value > 0 ? 'win' : ref.value < 0 ? 'loss' : 'draw']++;
  }
  assert.ok(stat.win > 30 && stat.loss > 30 && stat.draw > 3, `выборка однобокая: ${JSON.stringify(stat)}`);
  assert.ok(phases.size >= 3, `мало разных ситуаций: ${[...phases]}`);
});

test('сверка с эталоном на позициях покрупнее (до 4 карт) и на «циклоопасных»: мало рангов, много переводов', () => {
  const rng = mulberry32(99);
  for (let i = 0; i < 40; i++) {
    const pos = randomPosition(rng, { maxCards: 4, maxPlies: 5 });
    const ref = referenceSolve(pos, { maxStates: 200000 });
    const res = bigSolve(pos);
    assert.equal(res.value, ref.value);
    assert.equal(valueOfMove(ref, res.action), ref.value);
  }
  // Только десятки и девятки: одинаковые ранги — переводы и подкидывание по кругу, повторы позиций.
  for (let i = 0; i < 60; i++) {
    const pos = randomPosition(rng, { minCards: 2, maxCards: 3, maxPlies: 3, ranks: [9, 10] });
    const ref = referenceSolve(pos, { maxStates: 200000 });
    const res = bigSolve(pos);
    assert.equal(res.solved, true);
    assert.equal(res.value, ref.value, `цикл: значение разошлось ${JSON.stringify(pos)}`);
    assert.equal(valueOfMove(ref, res.action), ref.value);
  }
});

test('решатель никогда не возвращает действие вне легальных', () => {
  const rng = mulberry32(5);
  let checked = 0;
  for (let i = 0; i < 150; i++) {
    const pos = randomPosition(rng, { maxCards: 4, maxPlies: 5, rules: i % 2 ? {} : { allowPerevod: false } });
    for (const budget of [{ maxNodes: 5e6, maxMs: 1e9 }, { maxNodes: 40, maxMs: 1e9 }]) {
      const res = solveEndgame(pos, budget);
      const root = DurakGame.fromPosition(pos);
      const legal = root.getLegalActions(root.currentActorId());
      if (res.action) {
        assert.ok(legal.some((m) => sameEndgameAction(m, res.action)), `действие ${describeMove(res.action)} вне легальных`);
        assert.ok(res.legal.some((m) => sameEndgameAction(m, res.action)));
      } else {
        assert.equal(res.solved, false);
      }
      if (res.legal.length) assert.equal(res.legal.length, legal.length, 'список легальных ходов в корне разошёлся с движком');
      assert.ok(res.bestActions.every((b) => legal.some((m) => sameEndgameAction(m, b))));
      checked++;
    }
  }
  assert.equal(checked, 300);
});

test('партия, которую ведёт решатель, не проигрывает выигранное и не уходит по кругу (соперник играет случайно)', () => {
  const rng = mulberry32(77);
  let wins = 0;
  let draws = 0;
  for (let i = 0; i < 80; i++) {
    const pos = randomPosition(rng, { maxCards: 4, maxPlies: 3, rules: i % 2 ? {} : { allowPerevod: false } });
    const first = bigSolve(pos);
    if (first.value < 0) continue;
    const g = DurakGame.fromPosition(pos);
    const me = g.currentActorId();
    let steps = 0;
    while (g.phase !== 'finished') {
      assert.ok(++steps < 300, `партия зациклилась: ${JSON.stringify(pos)}`);
      const actor = g.currentActorId();
      const legal = g.getLegalActions(actor);
      let move;
      if (actor === me) {
        const res = bigSolve(toPosition(g));
        assert.equal(res.solved, true);
        assert.ok(res.value >= first.value, `оценка упала с ${first.value} до ${res.value} после хода по решателю`);
        move = legal.find((m) => sameEndgameAction(m, res.action));
        assert.ok(move, 'решатель назвал нелегальный ход');
      } else {
        move = pickRandom(legal, rng);
      }
      g.applyLegalAction(actor, move);
    }
    if (first.value === 1) { assert.notEqual(g.durak, me); assert.notEqual(g.durak, null, 'выигранная позиция закончилась ничьей'); wins++; }
    else { assert.notEqual(g.durak, me, 'позиция, где ничья, закончилась поражением'); draws++; }
  }
  assert.ok(wins > 25, `мало выигранных партий в выборке: ${wins}`);
  assert.ok(draws >= 0);
});

test('решение детерминировано: одна и та же позиция — тот же ответ', () => {
  const rng = mulberry32(8);
  for (let i = 0; i < 30; i++) {
    const pos = randomPosition(rng, { maxCards: 4, maxPlies: 4 });
    const a = bigSolve(pos);
    const b = bigSolve(pos);
    assert.equal(a.value, b.value);
    assert.equal(a.nodes, b.nodes);
    assert.deepEqual(a.action, b.action);
  }
});

test('таблицу позиций можно переиспользовать между вызовами — ответ тот же', () => {
  const rng = mulberry32(9);
  const table = new Map();
  for (let i = 0; i < 30; i++) {
    const pos = randomPosition(rng, { maxCards: 3, maxPlies: 3, rules: { allowPerevod: false } });
    const fresh = bigSolve(pos);
    const shared = solveEndgame(pos, { maxNodes: 5e6, maxMs: 1e9, table });
    assert.equal(shared.value, fresh.value);
  }
  assert.ok(table.size > 0);
});

// =================================================================== D. Бюджет

test('бюджет узлов срабатывает: timedOut, действия нет, исключений нет, счётчики возвращены', () => {
  const rng = mulberry32(3);
  // Большая позиция: по 6 карт у каждого — за 50 узлов её не решить.
  const pos = randomPosition(rng, { minCards: 6, maxCards: 6, maxPlies: 0 });
  const res = solveEndgame(pos, { maxNodes: 50, maxMs: 1e9 });
  assert.equal(res.timedOut, true);
  assert.equal(res.solved, false);
  assert.equal(res.action, null);
  assert.equal(res.win, false);
  assert.ok(res.nodes >= 50 && res.nodes <= 51, `узлов ${res.nodes}`);
  assert.equal(typeof res.ms, 'number');
  assert.ok(res.ms >= 0);
  assert.ok(Number.isInteger(res.depth) && res.depth >= 0);
  assert.equal(res.player, 'a');
  assert.ok(Array.isArray(res.legal) && res.legal.length > 0);

  // Ничего не сломалось: с нормальным бюджетом та же позиция решается или упирается снова, но не падает.
  const again = solveEndgame(pos, { maxNodes: 200000, maxMs: 1e9 });
  assert.equal(typeof again.timedOut, 'boolean');
});

test('бюджет времени срабатывает быстро и честно', () => {
  // Позиция с seed 1 требует больше 300 000 узлов (≈ 1,7 с), поэтому за 5 мс её не решить.
  const pos = randomPosition(mulberry32(1), { minCards: 6, maxCards: 6, maxPlies: 0 });
  const started = Date.now();
  const res = solveEndgame(pos, { maxNodes: 1e9, maxMs: 5 });
  const wall = Date.now() - started;
  assert.equal(res.timedOut, true);
  assert.equal(res.action, null);
  assert.ok(wall < 1500, `решатель не остановился по времени: ${wall} мс`);
});

test('бюджет по умолчанию: до 2 секунд и 400 000 узлов на ход', () => {
  assert.equal(DEFAULT_SOLVER_OPTIONS.maxMs, 2000);
  assert.equal(DEFAULT_SOLVER_OPTIONS.maxNodes, 400000);
  assert.ok(Object.isFrozen(DEFAULT_SOLVER_OPTIONS));
  // Без options берутся именно они: маленькая позиция решается, большая не «вечная».
  const small = solveEndgame(makePosition({ trump: '♣', a: ['9♠', '10♠'], d: ['9♥'] }));
  assert.equal(small.solved, true);
});

test('решатель не бросает исключений на мусорных позициях', () => {
  const good = makePosition({ trump: '♣', a: ['9♠', '10♠'], d: ['9♥'] });
  const junk = [
    null, undefined, {}, [], 'позиция', 42,
    { ...good, players: [] },
    { ...good, players: [good.players[0]] },
    { ...good, phase: 'finished' },
    { ...good, phase: 'нет такой фазы' },
    { ...good, attacker: 'x' },
    { ...good, defender: 'a' },
    { ...good, table: [{ attack: null, defense: null }] },
    { ...good, players: [{ id: 'a', hand: null }, good.players[1]] },
  ];
  for (const pos of junk) {
    let res;
    assert.doesNotThrow(() => { res = solveEndgame(pos, { maxNodes: 1000 }); });
    assert.equal(res.solved, false, `мусор ${JSON.stringify(pos)} не должен «решаться»`);
    assert.equal(res.action, null);
    assert.equal(res.win, false);
  }
  // Правила в позиции не указаны — это правила по умолчанию, а не ошибка (низкоуровневый вызов;
  // бот же без state.rules решатель вообще не включает — см. canSolve).
  const noRules = solveEndgame({ ...good, rules: null }, { maxNodes: 1e5 });
  assert.equal(noRules.solved, true);
  assert.equal(noRules.value, solveEndgame(good, { maxNodes: 1e5 }).value);
  // и мусорные опции
  for (const options of [undefined, null, {}, { maxNodes: 'много' }, { maxMs: NaN }, { table: 'нет' }]) {
    assert.doesNotThrow(() => solveEndgame(good, options ?? undefined));
  }
});

// =================================================================== E. Умный бот за флагом

test('флаг exactEndgameSolver есть в профиле; выключенный — решатель не вызывается', () => {
  assert.equal(typeof SMART_PROFILE.exactEndgameSolver, 'boolean');
  let calls = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const rng = mulberry32(seed);
    const game = new DurakGame(makePlayers(2), { numPlayers: 2, deckSize: 24 }, rng);
    const bot = new SmartBot({ meId: 'p1', profile: { exactEndgameSolver: false } });
    bot.reset(game.getState('p1'), 'p1');
    let steps = 0;
    while (game.phase !== 'finished' && steps++ < 3000) {
      const id = actorOf(game);
      const state = game.getState(id);
      const legal = game.getLegalActions(id);
      let action;
      if (id === 'p1') { bot.observe(state, id); action = bot.decide(state, id, legal).action; } else action = simpleBotDecide(state, id, legal);
      game.applyAction(id, action);
    }
    calls += bot.solverStats.calls;
  }
  assert.equal(calls, 0, 'при выключенном флаге решатель не должен вызываться');
});

test('умный бот с решателем: ходы легальны, объяснения на русском, откатов на «первый ход» нет', () => {
  const budget = { maxNodes: 20000, maxMs: 500 };
  const total = { calls: 0, used: 0, wins: 0, draws: 0, timedOut: 0 };
  const reasons = new Set();
  for (const [deckSize, games] of [[24, 14], [36, 6]]) {
    for (let seed = 1; seed <= games; seed++) {
      const rng = mulberry32(seed * 13 + deckSize);
      const game = new DurakGame(makePlayers(2), { numPlayers: 2, deckSize }, rng);
      const meId = seed % 2 ? 'p1' : 'p2';
      const bot = new SmartBot({ meId, explain: true, profile: { exactEndgameSolver: true }, solver: budget });
      bot.reset(game.getState(meId), meId);
      let steps = 0;
      while (game.phase !== 'finished' && steps++ < 3000) {
        const id = actorOf(game);
        const state = game.getState(id);
        const legal = game.getLegalActions(id);
        let action;
        if (id === meId) {
          bot.observe(state, id);
          const usedBefore = bot.solverStats.used;
          const decision = bot.decide(state, id, legal);
          action = decision.action;
          assert.ok(legal.includes(action), 'бот вернул действие вне списка легальных');
          if (bot.solverStats.used > usedBefore) {
            // Решатель сработал: объяснение обязано быть его, а не заглушкой из-за спрятанного исключения.
            assert.notEqual(decision.reason, 'Играю первым доступным ходом.', 'в _choose упало исключение, ход подменён');
            assert.match(decision.reason, /прикуп пуст, рука соперника вычислена, партия просчитана до конца/);
            assert.match(decision.reason, /выигрываю|ничья/);
            assert.ok(!/undefined|\[object|null|NaN/.test(decision.reason), decision.reason);
            assert.ok(/[а-яё]/i.test(decision.reason));
            // Не раскрывает неизвестного: в тексте только карты самого хода.
            const named = decision.reason.match(CARD_TOKEN) || [];
            const own = [action.card, action.against, ...(action.cards || [])].filter(Boolean).map(cs);
            assert.ok(named.every((c) => own.includes(c)), `в объяснении лишние карты: ${named} / ${own}`);
            reasons.add(decision.reason.split(':')[0].replace(/[♠♥♦♣]/g, '').replace(/\b(10|[2-9]|[JQKA])\b/g, '').trim());
          }
        } else {
          action = simpleBotDecide(state, id, legal);
        }
        game.applyAction(id, action);
      }
      assert.equal(game.phase, 'finished', 'партия зависла');
      for (const k of Object.keys(total)) total[k] += bot.solverStats[k];
    }
  }
  assert.ok(total.calls > 20, `решатель почти не вызывался: ${JSON.stringify(total)}`);
  assert.ok(total.used > 10, `решатель почти не использовался: ${JSON.stringify(total)}`);
  assert.ok(total.wins > 0);
  assert.ok(reasons.size >= 2, `мало разных формулировок: ${[...reasons]}`);
});

test('при исчерпанном бюджете бот откатывается на эвристику и партия идёт дальше', () => {
  let timedOut = 0;
  let used = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const rng = mulberry32(seed * 5);
    const game = new DurakGame(makePlayers(2), { numPlayers: 2, deckSize: 24 }, rng);
    const bot = new SmartBot({ meId: 'p1', explain: true, profile: { exactEndgameSolver: true }, solver: { maxNodes: 30, maxMs: 1000 } });
    bot.reset(game.getState('p1'), 'p1');
    let steps = 0;
    while (game.phase !== 'finished' && steps++ < 3000) {
      const id = actorOf(game);
      const state = game.getState(id);
      const legal = game.getLegalActions(id);
      let action;
      if (id === 'p1') { bot.observe(state, id); action = bot.decide(state, id, legal).action; assert.ok(legal.includes(action)); } else action = simpleBotDecide(state, id, legal);
      game.applyAction(id, action);
    }
    assert.equal(game.phase, 'finished');
    timedOut += bot.solverStats.timedOut;
    used += bot.solverStats.used;
  }
  assert.ok(timedOut > 0, 'бюджет в 30 узлов ни разу не исчерпался — тест ничего не проверил');
  assert.ok(used >= 0);
});

test('с решателем бот проходит партии на 3–4 игроков без ошибок; решатель вступает, когда остаётся двое', () => {
  let usedTotal = 0;
  for (const [numPlayers, deckSize, seeds] of [[3, 36, 6], [4, 36, 4]]) {
    for (let seed = 1; seed <= seeds; seed++) {
      const rng = mulberry32(seed * 3 + numPlayers);
      const game = new DurakGame(makePlayers(numPlayers), { numPlayers, deckSize }, rng);
      const bots = new Map(game.players.map((p) => [p.id, new SmartBot({ meId: p.id, profile: { exactEndgameSolver: true }, solver: { maxNodes: 20000, maxMs: 300 } }).reset(game.getState(p.id), p.id)]));
      let steps = 0;
      while (game.phase !== 'finished' && steps++ < 4000) {
        const id = actorOf(game);
        const state = game.getState(id);
        const legal = game.getLegalActions(id);
        const bot = bots.get(id);
        bot.observe(state, id);
        const decision = bot.decide(state, id, legal);
        assert.ok(legal.includes(decision.action));
        game.applyAction(id, decision.action);
      }
      assert.equal(game.phase, 'finished');
      for (const b of bots.values()) usedTotal += b.solverStats.used;
    }
  }
  assert.ok(usedTotal > 0, 'после выхода игроков решатель ни разу не пригодился');
});

test('SmartBot без решателя и с решателем в неприменимых позициях ходит одинаково', () => {
  // Пока прикуп не пуст, флаг ничего не меняет: решения совпадают ход в ход.
  for (let seed = 1; seed <= 6; seed++) {
    const rngA = mulberry32(seed);
    const game = new DurakGame(makePlayers(2), { numPlayers: 2, deckSize: 36 }, rngA);
    const on = new SmartBot({ meId: 'p1', profile: { exactEndgameSolver: true } }).reset(game.getState('p1'), 'p1');
    const off = new SmartBot({ meId: 'p1', profile: { exactEndgameSolver: false } }).reset(game.getState('p1'), 'p1');
    let steps = 0;
    while (game.phase !== 'finished' && game.talon.length > 0 && steps++ < 500) {
      const id = actorOf(game);
      const state = game.getState(id);
      const legal = game.getLegalActions(id);
      if (id === 'p1') {
        on.observe(structuredClone(state), id);
        off.observe(structuredClone(state), id);
        const a = on.decide(structuredClone(state), id, legal);
        const b = off.decide(structuredClone(state), id, legal);
        assert.deepEqual(a.action, b.action, 'до опустения прикупа флаг не должен менять ходы');
      }
      game.applyAction(id, pickRandom(legal, mulberry32(seed + steps)));
    }
  }
});

// =================================================================== Сборка клиента

test('решатель попал в сборку клиента (visual/index.html и docs/index.html)', () => {
  for (const file of ['visual/index.html', 'docs/index.html']) {
    const html = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(html.includes('function solveEndgame'), `${file}: нет solveEndgame`);
    assert.ok(html.includes('exactEndgameSolver'), `${file}: нет флага exactEndgameSolver`);
    assert.ok(html.includes('static fromPosition'), `${file}: нет DurakGame.fromPosition`);
  }
});
