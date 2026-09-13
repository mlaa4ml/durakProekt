// Бот уровня "умный": считает карты, помнит, что уже выходило из игры и что
// забрал себе соперник, и на основе этого строит план на партию.
//
// Чем он отличается от simpleBot:
//  1. ПАМЯТЬ (BotMemory). Между ходами бот запоминает:
//     - все карты, которые он когда-либо видел на столе (они либо ушли в бито,
//       либо к тому, кто забрал взятку);
//     - какие конкретно карты забрал себе каждый соперник (карты со стола в
//       момент "беру") и какие из них он потом уже отыграл;
//     - что ушло в бито.
//     Отсюда считается множество "невидимых" карт — тех, что лежат в прикупе
//     или в закрытых руках соперников.
//  2. АНАЛИЗ СТОЛА. Перед защитой бот проверяет, сможет ли он отбить ВСЕ
//     неотбитые карты на столе; если нет — не тратит карты зря и берёт сразу.
//  3. ПЛАН НА ЭНДШПИЛЬ. Когда прикуп пуст и соперник остался один, множество
//     невидимых карт — это ровно его рука: игра становится с открытыми картами.
//     Бот ищет ход, который соперник не может отбить, и добивает его.
//  4. ОЦЕНКА РУКИ. Учитывает "гарантированно выигрышные" карты (старшая
//     оставшаяся в масти, старшие козыри) и бережёт их, пока есть смысл.
//
// Каждое решение возвращается вместе с человекочитаемым объяснением (reason),
// которое сервер может писать в лог партии — чтобы было видно, почему бот
// сходил именно так.

import { SUITS, cardToString, rankName } from '../deck.js';

const MIN_RANK_BY_DECK_SIZE = { 24: 9, 36: 6, 52: 2 };

export function cardKey(card) {
  return `${card.suit}${card.rank}`;
}

function cardValue(card, trumpSuit) {
  return (card.suit === trumpSuit ? 100 : 0) + card.rank;
}

function beats(attackCard, defendCard, trumpSuit) {
  if (defendCard.suit === attackCard.suit) return defendCard.rank > attackCard.rank;
  return defendCard.suit === trumpSuit && attackCard.suit !== trumpSuit;
}

function tableCards(state) {
  const res = [];
  for (const t of state.table || []) {
    if (t.attack) res.push(t.attack);
    if (t.defense) res.push(t.defense);
  }
  return res;
}

function myHand(state, playerId) {
  const me = (state.players || []).find((p) => p.id === playerId);
  return (me && me.hand) ? me.hand : [];
}

// Полный размер колоды выводится из самого состояния: все карты партии лежат
// либо в прикупе, либо в бито, либо в руках, либо на столе. Так бот работает
// с любой колодой (24/36/52), не получая её размер отдельным параметром.
function inferDeckSize(state) {
  const inHands = (state.players || []).reduce((sum, p) => sum + (p.handCount || 0), 0);
  const total = (state.talonCount || 0) + (state.discardCount || 0) + inHands + tableCards(state).length;
  if (MIN_RANK_BY_DECK_SIZE[total]) return total;
  // Подстраховка: округляем вверх до ближайшей известной колоды.
  if (total <= 24) return 24;
  if (total <= 36) return 36;
  return 52;
}

function fullDeck(deckSize) {
  const minRank = MIN_RANK_BY_DECK_SIZE[deckSize] ?? 9;
  const cards = [];
  for (const suit of SUITS) {
    for (let rank = minRank; rank <= 14; rank++) cards.push({ suit, rank });
  }
  return cards;
}

/**
 * Память бота между ходами. Один экземпляр на одно место за столом.
 * Вызывающая сторона должна дергать observe(state, myId) перед каждым решением
 * (botDecide это делает сам) — тогда память остаётся актуальной, даже если
 * между ходами бота прошло несколько чужих ходов.
 */
export class BotMemory {
  constructor() {
    this.seen = new Set();       // всё, что бот когда-либо видел (стол + своя рука)
    this.discarded = new Set();  // ушло в бито
    this.known = new Map();      // playerId -> Set(key) карт, про которые точно известно, что они у него
    this._prevTableKeys = [];
    this._prevGoingToDefender = false;
    this._prevDefenderId = null;
  }

  knownOf(playerId) {
    return this.known.get(playerId) || new Set();
  }

  _forget(key) {
    for (const set of this.known.values()) set.delete(key);
  }

  observe(state, myId) {
    const onTable = tableCards(state);
    const onTableKeys = onTable.map(cardKey);
    const onTableSet = new Set(onTableKeys);

    for (const k of onTableKeys) this.seen.add(k);
    for (const c of myHand(state, myId)) {
      const k = cardKey(c);
      this.seen.add(k);
      this._forget(k); // карта у меня — значит уже не у соперника
    }
    // Карта, выложенная на стол, покинула руку того, у кого мы её "помнили".
    for (const k of onTableKeys) this._forget(k);

    // Что случилось с картами, которые лежали на столе на прошлом наблюдении и
    // исчезли: либо ушли в бито, либо их забрал защищавшийся.
    const gone = this._prevTableKeys.filter((k) => !onTableSet.has(k));
    if (gone.length > 0) {
      if (this._prevGoingToDefender && this._prevDefenderId && this._prevDefenderId !== myId) {
        let set = this.known.get(this._prevDefenderId);
        if (!set) { set = new Set(); this.known.set(this._prevDefenderId, set); }
        for (const k of gone) set.add(k);
      } else if (this._prevGoingToDefender && this._prevDefenderId === myId) {
        // Забрал я сам — карты видны в моей руке, отдельно помнить не нужно.
      } else {
        for (const k of gone) this.discarded.add(k);
      }
    }

    this._prevTableKeys = onTableKeys;
    this._prevGoingToDefender = state.tableGoingToDefender === true;
    this._prevDefenderId = state.defender || null;

    // Соперник не может держать больше карт, чем у него на руке (он мог сбросить
    // запомненную карту в момент, когда мы её не видели) — подрезаем память.
    for (const p of state.players || []) {
      const set = this.known.get(p.id);
      if (!set) continue;
      if (p.out) { set.clear(); continue; }
      while (set.size > (p.handCount || 0)) set.delete(set.values().next().value);
    }
  }

  /**
   * Карты, местоположение которых боту неизвестно: прикуп + закрытые руки
   * соперников (за вычетом тех, что мы точно помним).
   */
  unknownCards(state, myId) {
    const deckSize = inferDeckSize(state);
    const excluded = new Set([...this.discarded]);
    for (const c of myHand(state, myId)) excluded.add(cardKey(c));
    for (const c of tableCards(state)) excluded.add(cardKey(c));
    for (const set of this.known.values()) for (const k of set) excluded.add(k);
    if (state.trumpCard && (state.talonCount || 0) > 0) {
      // Козырная карта под низом колоды видна всем — она не в руках соперника.
      excluded.add(cardKey(state.trumpCard));
    }
    return fullDeck(deckSize).filter((c) => !excluded.has(cardKey(c)));
  }

  /**
   * Что может быть в руке у конкретного соперника.
   * certain === true, когда прикуп пуст и соперник остался один: тогда все
   * "невидимые" карты — это ровно его рука, и игра для бота открытая.
   */
  opponentCards(state, myId, oppId) {
    const active = (state.players || []).filter((p) => !p.out && p.id !== myId);
    const known = [...this.knownOf(oppId)];
    const unknown = this.unknownCards(state, myId);
    const trumpCardKnown = (state.talonCount || 0) > 0 && state.trumpCard;
    const certain = (state.talonCount || 0) === 0 && active.length === 1 && !trumpCardKnown;
    const knownCards = this._decodeKeys(known);
    return {
      certain,
      known: knownCards,
      possible: certain ? unknown.slice() : knownCards.concat(unknown),
    };
  }

  _decodeKeys(keys) {
    return keys.map((k) => ({ suit: k[0], rank: Number(k.slice(1)) }));
  }
}

// ---------- вспомогательная аналитика ----------

// Может ли набор карт cards отбить карту attackCard.
function anyBeats(cards, attackCard, trumpSuit) {
  return cards.some((c) => beats(attackCard, c, trumpSuit));
}

// Сколько карт из hand я смогу отбить, если атаки пойдут подряд (жадно, самой
// дешёвой подходящей картой). Возвращает {allBeatable, cost} — cost это сумма
// ценностей карт, которые придётся потратить.
function planDefense(undefendedAttacks, hand, trumpSuit) {
  const left = hand.slice();
  let cost = 0;
  for (const attack of undefendedAttacks) {
    const options = left
      .filter((c) => beats(attack, c, trumpSuit))
      .sort((a, b) => cardValue(a, trumpSuit) - cardValue(b, trumpSuit));
    if (options.length === 0) return { allBeatable: false, cost };
    const used = options[0];
    cost += cardValue(used, trumpSuit);
    left.splice(left.findIndex((c) => cardKey(c) === cardKey(used)), 1);
  }
  return { allBeatable: true, cost };
}

// Карта "непобиваемая" — никто из живых карт (possible) её не бьёт.
function isUnbeatableBy(card, possible, trumpSuit) {
  return !anyBeats(possible, card, trumpSuit);
}

function describe(card) {
  return cardToString(card);
}

function countTrumps(cards, trumpSuit) {
  return cards.filter((c) => c.suit === trumpSuit).length;
}

// ---------- собственно решения ----------

function decideAttack(ctx) {
  const { state, trumpSuit, attacks, pass, hand, opp, oppInfo, endgame } = ctx;
  const sorted = attacks.slice().sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
  const mustAttack = !pass;
  const oppHandCount = oppInfo ? oppInfo.handCount : 6;
  const tableOpen = (state.table || []).length > 0;

  // 1. Добивающий ход: знаем руку соперника (или видим, что он точно не отобьётся)
  //    и можем положить карту, которую он не бьёт.
  if (opp && opp.possible.length > 0) {
    const killers = sorted.filter((a) => isUnbeatableBy(a.card, opp.possible, trumpSuit));
    if (killers.length > 0 && (opp.certain || endgame)) {
      const pick = killers[0];
      return {
        action: pick,
        reason: opp.certain
          ? `прикуп пуст, вся рука соперника мне известна (${opp.possible.map(describe).join(' ')}) — ${describe(pick.card)} ему бить нечем, он заберёт карты`
          : `по моим подсчётам ${describe(pick.card)} соперник отбить не может — атакую именно ей`,
      };
    }
  }

  // 2. Добивание "по количеству": у соперника мало карт, стол уже открыт —
  //    подкидываем всё, что можно, чтобы перегрузить его руку.
  if (tableOpen && oppHandCount <= 2) {
    const cheap = sorted.find((a) => a.card.suit !== trumpSuit) || sorted[0];
    return {
      action: cheap,
      reason: `у соперника всего ${oppHandCount} карт(ы) — подкидываю ${describe(cheap.card)}, чтобы он не успел отбиться и забрал стол`,
    };
  }

  // 3. Обычная атака: ищем самую дешёвую карту, которую не жалко.
  //    Придерживаем козыри и "гарантированно выигрышные" карты (старшая
  //    оставшаяся в масти) — они понадобятся в концовке.
  const unseen = opp ? opp.possible : [];
  const scored = sorted.map((a) => {
    const card = a.card;
    let score = cardValue(card, trumpSuit);
    const isTrump = card.suit === trumpSuit;
    if (isTrump) score += 60;
    const topOfSuit = unseen.length > 0 && !unseen.some((c) => c.suit === card.suit && c.rank > card.rank);
    if (topOfSuit && !endgame) score += 25; // старшая оставшаяся в масти — ценный "гвоздь"
    // Ранг, которого у меня несколько, кидать выгоднее: сможем подкинуть ещё.
    const sameRank = hand.filter((c) => c.rank === card.rank).length;
    if (sameRank > 1) score -= 8;
    // Если соперник точно не может её отбить — это лучший ход.
    if (unseen.length > 0 && isUnbeatableBy(card, unseen, trumpSuit)) score -= 40;
    return { action: a, card, score, isTrump, topOfSuit };
  }).sort((x, y) => x.score - y.score);

  const best = scored[0];

  if (mustAttack) {
    return {
      action: best.action,
      reason: `ходить обязан — начинаю с самой дешёвой карты ${describe(best.card)}` +
        (best.isTrump ? ' (некозырных вариантов нет)' : ''),
    };
  }

  // Решаем, стоит ли подкидывать вообще.
  const holdBecauseTrump = best.isTrump;
  const holdBecauseValuable = best.topOfSuit && !endgame;
  const holdBecauseHigh = best.card.rank >= 12 && !endgame && best.card.suit !== trumpSuit && !tableOpen;
  if (holdBecauseTrump || holdBecauseValuable || holdBecauseHigh) {
    const why = holdBecauseTrump
      ? `осталось кинуть только козырь ${describe(best.card)} — берегу его`
      : holdBecauseValuable
        ? `${describe(best.card)} — старшая оставшаяся в масти ${best.card.suit}, ей ещё выиграю заход`
        : `${describe(best.card)} слишком крупная, пока в прикупе ${state.talonCount} карт — придержу`;
    return { action: pass, reason: `пас: ${why}` };
  }

  return {
    action: best.action,
    reason: `подкидываю ${describe(best.card)} — самая ненужная карта в руке` +
      (endgame ? ' (прикуп пуст, надо разгружаться)' : ''),
  };
}

function decideDefense(ctx) {
  const { state, trumpSuit, defends, transfers, take, hand, opp, endgame } = ctx;
  const undefended = (state.table || []).filter((t) => t.defense === null).map((t) => t.attack);
  const plan = planDefense(undefended, hand, trumpSuit);

  // Перевод считаем отдельно: он выгоден, когда иначе пришлось бы тратить козырь.
  const transferSorted = transfers.slice().sort((a, b) => {
    const at = countTrumps(a.cards, trumpSuit);
    const bt = countTrumps(b.cards, trumpSuit);
    if (at !== bt) return at - bt;
    return a.cards.length - b.cards.length;
  });
  const transfer = transferSorted[0];

  const defendsSorted = defends.slice().sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
  const cheapest = defendsSorted[0];

  // 1. Стол отбить целиком нечем — не разбрасываемся картами, берём сразу.
  if (!plan.allBeatable && undefended.length > 1) {
    if (transfer && countTrumps(transfer.cards, trumpSuit) === 0) {
      return {
        action: transfer,
        reason: `весь стол (${undefended.map(describe).join(' ')}) мне не отбить, но могу перевести ${transfer.cards.map(describe).join(' ')} — перевожу, чтобы не брать`,
      };
    }
    if (take) {
      return {
        action: take,
        reason: `на столе ${undefended.length} карт(ы) (${undefended.map(describe).join(' ')}), отбить все нечем — беру сразу, чтобы не потерять ещё и козыри`,
      };
    }
  }

  if (!cheapest) {
    if (transfer) return { action: transfer, reason: `отбиться нечем, но есть перевод ${transfer.cards.map(describe).join(' ')} — перевожу` };
    if (take) return { action: take, reason: 'отбиться нечем — беру карты' };
  }

  const wouldUseTrump = cheapest && cheapest.card.suit === trumpSuit;
  const attackCard = undefended[0];

  // 2. Перевод вместо траты козыря.
  if (transfer && wouldUseTrump && countTrumps(transfer.cards, trumpSuit) === 0) {
    return {
      action: transfer,
      reason: `бить ${describe(attackCard)} пришлось бы козырем ${describe(cheapest.card)} — вместо этого перевожу ${transfer.cards.map(describe).join(' ')}`,
    };
  }

  // 3. Не стоит жечь крупный козырь ради мелкой карты, пока идёт "прикупная" фаза
  //    и у меня ещё нормальная рука — выгоднее взять.
  if (wouldUseTrump && take && !endgame) {
    const trumpsLeft = countTrumps(hand, trumpSuit);
    const expensive = cheapest.card.rank >= 12;
    const cheapAttack = attackCard.suit !== trumpSuit && attackCard.rank <= 11;
    if (expensive && cheapAttack && trumpsLeft <= 2) {
      return {
        action: take,
        reason: `за мелкую ${describe(attackCard)} пришлось бы отдать крупный козырь ${describe(cheapest.card)} — выгоднее взять и сохранить козырь на концовку`,
      };
    }
  }

  // 4. В эндшпиле считаем, чем останемся: если после защиты соперник добьёт нас
  //    следующей же картой, а взятие оставляет шанс — берём.
  if (cheapest && endgame && opp && opp.certain && take) {
    const rest = hand.filter((c) => cardKey(c) !== cardKey(cheapest.card));
    const oppCanKillRest = opp.possible.some((oc) => rest.length > 0 && !anyBeats(rest, oc, trumpSuit));
    if (oppCanKillRest && rest.length <= 2) {
      return {
        action: take,
        reason: `знаю руку соперника (${opp.possible.map(describe).join(' ')}) — если отобьюсь ${describe(cheapest.card)}, следующий его ход я уже не покрою; беру и перехватываю ход позже`,
      };
    }
  }

  if (cheapest) {
    return {
      action: cheapest,
      reason: `бью ${describe(attackCard)} самой дешёвой подходящей — ${describe(cheapest.card)}` +
        (wouldUseTrump ? ' (некозырной нет, но стол отбиваю целиком)' : ''),
    };
  }

  if (take) return { action: take, reason: 'подходящих карт нет — беру' };
  return null;
}

/**
 * Основная точка входа умного бота.
 * @param {object} state  результат game.getState(playerId) (чужие руки замаскированы)
 * @param {string} playerId
 * @param {Array}  legalActions
 * @param {BotMemory} [memory] память между ходами; если не передать — бот сыграет
 *                             без истории (только по видимому состоянию)
 * @returns {{action: object|null, reason: string}}
 */
export function smartBotDecide(state, playerId, legalActions, memory = null) {
  if (!legalActions || legalActions.length === 0) return { action: null, reason: '' };
  const mem = memory || new BotMemory();
  mem.observe(state, playerId);

  const trumpSuit = state.trumpSuit;
  const hand = myHand(state, playerId);
  const endgame = (state.talonCount || 0) === 0;

  const attacks = legalActions.filter((a) => a.type === 'attack');
  const defends = legalActions.filter((a) => a.type === 'defend');
  const transfers = legalActions.filter((a) => a.type === 'transfer');
  const take = legalActions.find((a) => a.type === 'take');
  const pass = legalActions.find((a) => a.type === 'pass');

  // Кто сейчас наш главный оппонент: при защите — атакующий, при атаке — защищающийся.
  const oppId = (defends.length > 0 || transfers.length > 0 || take)
    ? state.attacker
    : state.defender;
  const oppInfo = (state.players || []).find((p) => p.id === oppId && p.id !== playerId) || null;
  const opp = oppInfo ? mem.opponentCards(state, playerId, oppInfo.id) : null;

  const ctx = { state, trumpSuit, hand, attacks, defends, transfers, take, pass, opp, oppInfo, endgame, mem };

  let result = null;
  if (defends.length > 0 || (take && state.phase === 'defender-to-act')) {
    result = decideDefense(ctx);
  }
  if (!result && attacks.length > 0) {
    result = decideAttack(ctx);
  }
  if (!result && transfers.length > 0) {
    result = { action: transfers[0], reason: 'перевожу — других разумных вариантов нет' };
  }
  if (!result && take) result = { action: take, reason: 'беру карты — отбиваться нечем' };
  if (!result && pass) result = { action: pass, reason: 'пас — подкидывать нечего' };
  if (!result) result = { action: legalActions[0], reason: 'единственный доступный ход' };

  // Добавляем к объяснению короткую сводку "что бот знает" — именно она
  // показывает, что решение принято по подсчёту карт, а не наугад.
  const unknown = mem.unknownCards(state, playerId);
  const trumpsOut = unknown.filter((c) => c.suit === trumpSuit).length;
  const knownOpp = opp && opp.known.length > 0 ? `; помню у соперника: ${opp.known.map(describe).join(' ')}` : '';
  const certainNote = opp && opp.certain ? '; рука соперника просчитана полностью' : '';
  result.analysis = `в игре ещё ${unknown.length} неизвестных карт, из них козырей ${trumpsOut}` +
    `; в прикупе ${state.talonCount}, в бито ${state.discardCount}${knownOpp}${certainNote}`;
  void rankName;
  return result;
}
