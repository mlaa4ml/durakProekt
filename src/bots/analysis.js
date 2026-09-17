// Анализ позиции для умного бота: ЧИСТЫЕ функции без состояния.
//
// Этап 3 плана умного бота (issue #33, спецификация — раздел 5.1 SMART_BOT_PLAN.md).
//
// Правила этого файла:
//   * ни одна функция ничего не мутирует и ничего не помнит между вызовами;
//   * `tracker` (см. `./memory.js`) — необязательный аргумент: без него функции
//     работают по «пессимистичному» предположению, что вне моей руки может быть
//     любая карта колоды. Так analysis.js остаётся тестируемым в отрыве от памяти;
//   * знание о картах берётся ТОЛЬКО из трекера (то есть из наблюдаемых состояний),
//     никакого доступа к чужим рукам здесь нет и быть не может.
//
// Движок (`src/game.js`) и простой бот (`src/bots/simpleBot.js`) этим файлом не затрагиваются.

import { createDeck } from '../deck.js';
import { cardKey } from './memory.js';

/**
 * Бьёт ли `defCard` карту `atkCard` — строго по правилам движка
 * (`canBeat` в src/game.js): та же масть и старше, либо козырь по некозырю.
 */
export function beats(defCard, atkCard, trumpSuit) {
  if (!defCard || !atkCard) return false;
  if (defCard.suit === atkCard.suit) return defCard.rank > atkCard.rank;
  return defCard.suit === trumpSuit && atkCard.suit !== trumpSuit;
}

/**
 * Числовая ценность карты: козырь всегда дороже любого некозыря.
 * Шкала совместима с простым ботом (`cardValue`), чтобы сравнения читались одинаково.
 */
export function cardPower(card, trumpSuit) {
  if (!card) return 0;
  return (card.suit === trumpSuit ? 100 : 0) + card.rank;
}

/** Сортировка копии массива карт по возрастанию ценности. */
export function sortByPower(cards, trumpSuit) {
  return [...cards].sort((a, b) => cardPower(a, trumpSuit) - cardPower(b, trumpSuit));
}

/**
 * Все карты, которые МОГУТ оказаться у соперников (или в прикупе).
 * С трекером — его честный «пул неизвестного» + то, что точно забрали соперники.
 * Без трекера — вся колода за вычетом моей руки и карт на столе.
 */
export function outsideCards(hand, tracker = null, { deckSize = 36, table = [] } = {}) {
  if (tracker) {
    const res = [];
    const seen = new Set();
    for (const c of tracker.toCards(tracker.unknownCards())) {
      const k = cardKey(c);
      if (!seen.has(k)) { seen.add(k); res.push(c); }
    }
    for (const id of tracker.playerIds) {
      if (id === tracker.meId) continue;
      for (const c of tracker.toCards(tracker.opponentKnownCards(id))) {
        const k = cardKey(c);
        if (!seen.has(k)) { seen.add(k); res.push(c); }
      }
    }
    return res;
  }
  const mine = new Set(hand.map(cardKey));
  for (const t of table) {
    if (t.attack) mine.add(cardKey(t.attack));
    if (t.defense) mine.add(cardKey(t.defense));
  }
  return createDeck(deckSize).filter((c) => !mine.has(cardKey(c)));
}

/**
 * Держу ли я старшую НЕвышедшую карту масти.
 * @returns {{ suit, controlled: boolean, myBest: object|null, theirBest: object|null }}
 */
export function suitControl(hand, suit, tracker = null, opts = {}) {
  const mine = hand.filter((c) => c.suit === suit);
  let myBest = null;
  for (const c of mine) if (!myBest || c.rank > myBest.rank) myBest = c;

  let theirBest = null;
  if (tracker && typeof tracker.highestRemaining === 'function') {
    theirBest = tracker.highestRemaining(suit);
  } else {
    for (const c of outsideCards(hand, null, opts)) {
      if (c.suit !== suit) continue;
      if (!theirBest || c.rank > theirBest.rank) theirBest = c;
    }
  }

  return {
    suit,
    controlled: !!myBest && (!theirBest || myBest.rank > theirBest.rank),
    myBest: myBest ? { ...myBest } : null,
    theirBest: theirBest ? { ...theirBest } : null,
  };
}

/**
 * Карты руки, которые соперники уже НИЧЕМ не побьют
 * (ни старшей в масти, ни козырем — если карта некозырная, а козыри вне моей руки ещё есть,
 *  она побиваемой считается).
 */
export function unbeatableCards(hand, trumpSuit, tracker = null, opts = {}) {
  const outside = outsideCards(hand, tracker, opts);
  return hand.filter((card) => !outside.some((o) => beats(o, card, trumpSuit)));
}

/**
 * Оценка руки: сколько козырей, сколько «непобиваемых», средний ранг и суммарная ценность.
 */
export function handStrength(hand, trumpSuit, tracker = null, opts = {}) {
  const size = hand.length;
  const trumps = hand.filter((c) => c.suit === trumpSuit);
  const unbeatable = unbeatableCards(hand, trumpSuit, tracker, opts);
  const avgRank = size ? hand.reduce((s, c) => s + c.rank, 0) / size : 0;
  const power = hand.reduce((s, c) => s + cardPower(c, trumpSuit), 0);

  // Пары/тройки одного ранга — «топливо» для подкидывания.
  const byRank = new Map();
  for (const c of hand) byRank.set(c.rank, (byRank.get(c.rank) || 0) + 1);
  let pairs = 0;
  for (const n of byRank.values()) if (n >= 2) pairs++;

  // Козыри вне моей руки (то, чем меня ещё могут перебить).
  const trumpsOutside = tracker && typeof tracker.trumpsLeftOutside === 'function'
    ? tracker.trumpsLeftOutside(hand)
    : outsideCards(hand, tracker, opts).filter((c) => c.suit === trumpSuit).length;

  // Грубая скалярная оценка «насколько мне комфортно»: козыри и непобиваемые в плюс,
  // лишние карты на руках — в минус.
  const score = trumps.length * 2 + unbeatable.length * 1.5 + pairs * 0.5 - size * 0.5;

  return {
    size,
    trumpCount: trumps.length,
    trumps: trumps.map((c) => ({ ...c })),
    unbeatableCount: unbeatable.length,
    unbeatable: unbeatable.map((c) => ({ ...c })),
    pairs,
    avgRank,
    power,
    trumpsOutside,
    score,
  };
}

/**
 * Можно ли отбить ВЕСЬ стол и какой минимальной ценой.
 *
 * Перебор жадный с откатом (стол не больше 6 атак — полный перебор дёшев):
 * каждой неотбитой атаке подбираем карту, минимизируя суммарную ценность защиты.
 *
 * @param {Array} table   [{ attack, defense }] в формате state.table
 * @param {Array} hand    моя рука
 * @returns {{ canDefendAll: boolean, assignment: Array<{attack, card}>,
 *             cost: number, trumpsUsed: number, undefendedCount: number,
 *             beatableCount: number }}
 */
export function planDefense(table, hand, trumpSuit) {
  const targets = (table || []).filter((t) => t && t.attack && !t.defense).map((t) => t.attack);
  if (targets.length === 0) {
    return { canDefendAll: true, assignment: [], cost: 0, trumpsUsed: 0, undefendedCount: 0, beatableCount: 0 };
  }

  // Сначала самые «трудные» атаки (меньше всего вариантов ответа) — это резко режет перебор.
  const options = targets.map((atk) => ({
    atk,
    cards: sortByPower(hand.filter((c) => beats(c, atk, trumpSuit)), trumpSuit),
  }));
  options.sort((a, b) => a.cards.length - b.cards.length);

  const beatableCount = options.filter((o) => o.cards.length > 0).length;

  let best = null;
  const used = new Set();
  const acc = [];

  const rec = (i, cost) => {
    if (best && cost >= best.cost) return;           // отсечение по цене
    if (i === options.length) {
      best = { cost, assignment: acc.map((x) => ({ attack: { ...x.attack }, card: { ...x.card } })) };
      return;
    }
    const { atk, cards } = options[i];
    for (const c of cards) {
      const k = cardKey(c);
      if (used.has(k)) continue;
      used.add(k);
      acc.push({ attack: atk, card: c });
      rec(i + 1, cost + cardPower(c, trumpSuit));
      acc.pop();
      used.delete(k);
    }
  };
  rec(0, 0);

  if (!best) {
    // Отбить всё нельзя — считаем, сколько атак вообще остаётся без ответа.
    return {
      canDefendAll: false,
      assignment: [],
      cost: Infinity,
      trumpsUsed: 0,
      undefendedCount: targets.length - beatableCount,
      beatableCount,
    };
  }

  return {
    canDefendAll: true,
    assignment: best.assignment,
    cost: best.cost,
    trumpsUsed: best.assignment.filter((x) => x.card.suit === trumpSuit).length,
    undefendedCount: 0,
    beatableCount,
  };
}

/**
 * Фаза партии (раздел 5.2 плана).
 * @returns {'debut'|'middle'|'endgame'}
 */
export function gamePhase(state, handSize = 6) {
  const talon = state.talonCount || 0;
  if (talon === 0) return 'endgame';
  const active = (state.players || []).filter((p) => !p.out).length || 2;
  return talon > handSize * active ? 'debut' : 'middle';
}

export default {
  beats,
  cardPower,
  sortByPower,
  outsideCards,
  handStrength,
  planDefense,
  unbeatableCards,
  suitControl,
  gamePhase,
};
