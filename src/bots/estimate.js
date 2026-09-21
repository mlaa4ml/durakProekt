// Вероятностные оценки середины партии для умного бота: ЧИСТЫЕ функции.
//
// Этап 4 плана умного бота (issue #49, раздел 3 SMART_BOT_ROADMAP.md).
//
// Зачем отдельный файл: `analysis.js` отвечает на вопросы «что я могу прямо сейчас»
// (побить / сколько стоит / какая фаза), а здесь — «чем это скорее всего кончится»:
// оценки вероятностей поверх памяти (`./memory.js`, CardTracker).
//
// Правила файла — те же, что и у analysis.js:
//   * ни одна функция ничего не мутирует (ни трекер, ни состояние, ни переданные массивы)
//     и ничего не помнит между вызовами;
//   * знание о картах берётся ТОЛЬКО из трекера, то есть выведено из наблюдаемых состояний;
//     доступа к чужим рукам здесь нет и быть не может;
//   * без трекера функции работают по «пессимистичному» предположению (соперник отобьётся),
//     чтобы вероятностные правила без памяти просто ничего не советовали;
//   * все вероятности лежат в [0, 1]; когда рука соперника восстановлена точно
//     (`isOpponentHandCertain`), оценка вырождается в точный ответ 0 или 1.
//
// Движок (`src/game.js`) и простой бот (`src/bots/simpleBot.js`) этим файлом не затрагиваются.

import { beats, cardPower, outsideCards, planDefense } from './analysis.js';
import { cardKey } from './memory.js';

/** Приведение к отрезку [0, 1] (страховка от накопленной погрешности). */
export function clamp01(p) {
  if (!Number.isFinite(p)) return 0;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Гипергеометрика без факториалов: вероятность вытянуть хотя бы одну «нужную» карту,
 * если из пула `N` карт (в нём `K` нужных) соперник держит `n` штук.
 *   P = 1 - C(N-K, n) / C(N, n)  = 1 - произведение (N-K-i)/(N-i), i = 0..n-1
 */
export function pAtLeastOne(N, K, n) {
  if (n <= 0 || K <= 0 || N <= 0) return 0;
  if (n >= N) return 1;              // держит весь пул целиком — значит, и нужную карту тоже
  let q = 1;
  for (let i = 0; i < n; i++) {
    const bad = N - K - i;           // сколько «ненужных» ещё осталось
    const total = N - i;
    if (bad <= 0) return 1;
    q *= bad / total;
  }
  return clamp01(1 - q);
}

/**
 * Что я знаю о руке соперника, в одном объекте (копии карт, трекер не меняется).
 *
 * @returns {{ known: Array, pool: Array, slots: number, certain: boolean, handCount: number }}
 *   known     — карты, которые он ТОЧНО держит;
 *   pool      — кандидаты на остальные его карты (пул неизвестного, отфильтрованный
 *               предположениями `voidSuits` / «спасовал → нет ранга», если useAssumptions);
 *   slots     — сколько карт его руки ещё не опознано (из pool);
 *   certain   — рука восстановлена полностью.
 */
export function opponentView(tracker, oppId, { useAssumptions = true } = {}) {
  const empty = { known: [], pool: [], slots: 0, certain: false, handCount: 0 };
  if (!tracker || !oppId || typeof tracker.opponentPossibleCards !== 'function') return empty;
  try {
    const handCount = tracker.handCounts.get(oppId) || 0;
    const knownKeys = tracker.opponentKnownCards(oppId);
    const known = tracker.toCards(knownKeys);
    const certain = tracker.isOpponentHandCertain(oppId);
    const possible = tracker.opponentPossibleCards(oppId, { useAssumptions });
    const pool = tracker.toCards([...possible].filter((k) => !knownKeys.has(k)));
    const slots = Math.max(0, (handCount || known.length) - known.length);
    return { known, pool, slots, certain, handCount };
  } catch {
    return empty;
  }
}

/** Масти, которых у соперника (по наблюдениям) скорее всего нет. Только для объяснений. */
export function voidSuitsOf(tracker, oppId) {
  if (!tracker || !oppId || !tracker.voidSuits) return [];
  const set = tracker.voidSuits.get(oppId);
  return set ? [...set] : [];
}

/**
 * Вероятность, что соперник `oppId` побьёт карту `card`.
 *
 * Учитывает `voidSuits`: если масти у него, судя по игре, нет, то побить он сможет
 * только козырем — такие варианты из пула кандидатов просто исчезают.
 *
 * Без трекера возвращает 1 (пессимизм): правила, построенные на этой оценке,
 * в таком случае ничего не советуют и политика играет как раньше.
 */
export function pOpponentBeats(card, tracker, oppId, trumpSuit = null, options = {}) {
  if (!card) return 0;
  if (!tracker || !oppId) return 1;
  const trump = trumpSuit || tracker.trumpSuit || null;
  const view = opponentView(tracker, oppId, options);
  if (view.handCount === 0 && view.known.length === 0) return 0;   // карт у него нет
  if (view.known.some((c) => beats(c, card, trump))) return 1;     // точно знаю, чем побьёт
  if (view.certain || view.slots <= 0) return 0;                   // рука известна, бить нечем
  const beaters = view.pool.filter((c) => beats(c, card, trump)).length;
  return pAtLeastOne(view.pool.length, beaters, view.slots);
}

// ---------------------------------------------------------------------------
//  Подкидывание
// ---------------------------------------------------------------------------

/** Ранги, которые сейчас разрешено подкидывать: массив, либо null = «любая карта». */
export function allowedThrowInRanksOf(state) {
  if (!state) return null;
  if (Array.isArray(state.allowedThrowInRanks)) return [...state.allowedThrowInRanks];
  if (state.allowedThrowInRanks === null && 'allowedThrowInRanks' in state) return null;
  const table = state.table || [];
  if (table.length === 0) return null;
  const ranks = new Set();
  for (const t of table) {
    if (t && t.attack) ranks.add(t.attack.rank);
    if (t && t.defense) ranks.add(t.defense.rank);
  }
  return [...ranks].sort((a, b) => a - b);
}

/** Кто по правилам партии имеет право подкидывать (без меня и без защитника). */
export function throwInPlayersOf(state, meId = null) {
  if (!state) return [];
  const players = state.players || [];
  const alive = (id) => {
    const p = players.find((x) => x.id === id);
    return !!p && !p.out && (p.handCount || 0) > 0;
  };
  const skip = new Set([state.defender, meId].filter((x) => x !== null && x !== undefined));

  if (Array.isArray(state.throwInPlayers) && state.throwInPlayers.length) {
    return state.throwInPlayers.filter((id) => !skip.has(id) && alive(id));
  }
  const policy = (state.rules && state.rules.throwInPolicy) || 'all';
  if (policy === 'attackerOnly') {
    return [state.attacker].filter((id) => id && !skip.has(id) && alive(id));
  }
  if (policy === 'neighbors') {
    const ids = players.map((p) => p.id);
    const di = ids.indexOf(state.defender);
    const res = new Set();
    if (state.attacker) res.add(state.attacker);
    if (di !== -1 && ids.length > 1) {
      res.add(ids[(di + 1) % ids.length]);
      res.add(ids[(di - 1 + ids.length) % ids.length]);
    }
    return [...res].filter((id) => !skip.has(id) && alive(id));
  }
  return players.map((p) => p.id).filter((id) => !skip.has(id) && alive(id));
}

/** Сколько карт ещё физически влезет на стол в этом заходе. */
export function throwInRoom(state) {
  if (!state) return 0;
  const table = state.table || [];
  if (Number.isInteger(state.maxAttacksNow)) return Math.max(0, state.maxAttacksNow);
  const rules = (state.rules && typeof state.rules === 'object') ? state.rules : {};
  const limit = Number.isInteger(rules.maxTableAttacks) ? rules.maxTableAttacks : 6;
  const undefended = table.filter((t) => t && t.attack && !t.defense).length;
  const defender = (state.players || []).find((p) => p.id === state.defender);
  const defHand = defender ? (defender.handCount || 0) : limit;
  return Math.max(0, Math.min(limit - table.length, defHand - undefended));
}

/**
 * Сколько карт мне реально подкинут в этом заходе (ожидание, дробное число).
 *
 * Учитывает: сколько места осталось на столе (`maxAttacksNow` / правила),
 * какие ранги сейчас разрешены (`allowedThrowInRanks`), кто имеет право подкидывать
 * (`throwInPolicy` / `throwInPlayers`) и сколько подходящих карт у них может быть
 * по памяти (точно известные считаются как есть, неизвестные — по вероятности).
 */
export function expectedThrowIn(state, tracker = null, meId = null) {
  const room = throwInRoom(state);
  if (room <= 0) return 0;
  const ranks = allowedThrowInRanksOf(state);
  const rankOk = (c) => ranks === null || ranks.includes(c.rank);
  const throwers = throwInPlayersOf(state, meId);
  if (throwers.length === 0) return 0;

  let expected = 0;
  for (const oppId of throwers) {
    const view = opponentView(tracker, oppId, { useAssumptions: true });
    if (!tracker || (view.handCount === 0 && view.known.length === 0)) {
      // Без памяти: грубо считаем, что разрешённые ранги распределены по руке равномерно.
      const p = (state.players || []).find((x) => x.id === oppId);
      const hand = p ? (p.handCount || 0) : 0;
      const deckSize = (state.rules && state.rules.deckSize) || 36;
      const share = ranks === null ? 1 : Math.min(1, (ranks.length * 4) / deckSize);
      expected += hand * share;
      continue;
    }
    expected += view.known.filter(rankOk).length;
    if (view.slots > 0 && view.pool.length > 0) {
      const good = view.pool.filter(rankOk).length;
      expected += view.slots * (good / view.pool.length);
    }
  }
  return clamp01(expected / room) * room;   // ожидание, обрезанное местом на столе
}

/**
 * Карты, которыми меня сейчас реально могут подкинуть: разрешённые ранги
 * из того, что может быть на руках у подкидывающих.
 */
export function throwInCandidates(state, tracker = null, myHand = [], meId = null) {
  const ranks = allowedThrowInRanksOf(state);
  const rankOk = (c) => ranks === null || ranks.includes(c.rank);
  const seen = new Set();
  const res = [];
  const push = (c) => {
    const k = cardKey(c);
    if (seen.has(k)) return;
    seen.add(k);
    res.push({ ...c });
  };

  const throwers = throwInPlayersOf(state, meId);
  if (tracker && throwers.length) {
    for (const oppId of throwers) {
      const view = opponentView(tracker, oppId, { useAssumptions: true });
      for (const c of view.known) if (rankOk(c)) push(c);
      if (view.slots > 0) for (const c of view.pool) if (rankOk(c)) push(c);
    }
    return res;
  }
  const deckSize = (state && state.rules && state.rules.deckSize) || 36;
  for (const c of outsideCards(myHand, null, { deckSize, table: (state && state.table) || [] })) {
    if (rankOk(c)) push(c);
  }
  return res;
}

/**
 * Вероятность отбиться, когда защитник — я: отбить весь стол и пережить подкидывание.
 *
 * Стол считается точно (моя рука мне известна: `planDefense`), а подкидывание —
 * вероятностно: сколько карт ещё положат (`expectedThrowIn`) и какая доля возможных
 * подкидышей мне по зубам оставшейся рукой.
 */
export function pDefenseSurvives(table, myHand, tracker = null, state = {}) {
  const hand = Array.isArray(myHand) ? myHand : [];
  const trump = (state && state.trumpSuit) || (tracker && tracker.trumpSuit) || null;
  const plan = planDefense(table, hand, trump);
  if (!plan.canDefendAll) return 0;

  const used = new Set(plan.assignment.map((x) => cardKey(x.card)));
  let rest = hand.filter((c) => !used.has(cardKey(c)));
  const meId = (state && state.defender) || (tracker && tracker.meId) || null;
  const extra = Math.min(expectedThrowIn(state, tracker, meId), rest.length);
  if (extra <= 0) return 1;

  const candidates = throwInCandidates(state, tracker, hand, meId);
  if (candidates.length === 0) return 1;

  // Доля подкидышей, которые я могу побить текущим остатком руки.
  const share = (pool) => {
    if (pool.length === 0) return 0;
    const ok = candidates.filter((c) => pool.some((m) => beats(m, c, trump))).length;
    return ok / candidates.length;
  };
  // Каждая отбитая карта уходит с руки: снимаем самую дешёвую из тех, что вообще что-то бьют.
  const spendCheapest = (pool) => {
    let idx = -1;
    for (let i = 0; i < pool.length; i++) {
      if (!candidates.some((c) => beats(pool[i], c, trump))) continue;
      if (idx === -1 || cardPower(pool[i], trump) < cardPower(pool[idx], trump)) idx = i;
    }
    if (idx === -1) return pool;
    return pool.filter((_, i) => i !== idx);
  };

  let p = 1;
  const whole = Math.floor(extra);
  for (let i = 0; i < whole; i++) {
    p *= share(rest);
    if (p === 0) return 0;
    rest = spendCheapest(rest);
  }
  const frac = extra - whole;
  if (frac > 0) p *= 1 - frac * (1 - share(rest));
  return clamp01(p);
}

// ---------------------------------------------------------------------------
//  Выбор атаки
// ---------------------------------------------------------------------------

/** Козырный туз — верхняя граница шкалы `cardPower`, по ней нормируем цену карты. */
export const MAX_CARD_POWER = 114;

/**
 * Упорядочить атаки по «шансу, что соперник НЕ отобьётся», с поправкой на цену
 * отдаваемой карты: дорогую карту не стоит дарить ради пары процентов давления.
 *
 * @returns {Array<{action, card, pBeat, pressure, cost, score}>} новый массив,
 *          отсортированный по убыванию `score`; входной массив не меняется.
 */
export function bestAttackByPressure(legalAttacks, tracker, state, options = {}) {
  const { costWeight = 0.35, oppId = null, trumpSuit = null } = options;
  const trump = trumpSuit || (state && state.trumpSuit) || (tracker && tracker.trumpSuit) || null;
  const defenderId = oppId || (state && state.defender) || null;
  return [...(legalAttacks || [])]
    .map((a) => {
      const card = a && a.card ? a.card : a;
      const pBeat = pOpponentBeats(card, tracker, defenderId, trump);
      const cost = cardPower(card, trump) / MAX_CARD_POWER;
      const pressure = 1 - pBeat;
      return { action: a, card, pBeat, pressure, cost, score: pressure - costWeight * cost };
    })
    .sort((x, y) => y.score - x.score || x.cost - y.cost);
}

export default {
  clamp01,
  pAtLeastOne,
  opponentView,
  voidSuitsOf,
  pOpponentBeats,
  allowedThrowInRanksOf,
  throwInPlayersOf,
  throwInRoom,
  expectedThrowIn,
  throwInCandidates,
  pDefenseSurvives,
  bestAttackByPressure,
  MAX_CARD_POWER,
};
