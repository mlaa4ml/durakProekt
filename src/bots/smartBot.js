// Умный бот: политика решений (раздел 5.3 SMART_BOT_PLAN.md, issue #33, этап 3).
//
// Устройство:
//   память (`./memory.js`, CardTracker)  ->  анализ (`./analysis.js`, чистые функции)
//   ->  политика (этот файл)  ->  { action, reason, analysis }.
//
// Жёсткие правила файла:
//   * бот НИКОГДА не придумывает действие сам — он только ВЫБИРАЕТ объект из списка
//     `legalActions`, который дал движок. Поэтому нелегальный ход физически невозможен;
//   * бот видит только маскированное состояние `game.getState(meId)`; чужие руки в нём
//     отсутствуют, и обращений к ним здесь нет — вся «осведомлённость» идёт из трекера,
//     то есть выведена из публично наблюдаемых событий;
//   * объяснения (`reason` / `analysis`) на русском, без терминов кода, и НЕ раскрывают
//     того, чего бот не знает: чужие карты называются, только если трекер восстановил
//     руку соперника точно (`isOpponentHandCertain`);
//   * `src/bots/simpleBot.js` не трогаем — он остаётся эталоном для сравнения.
//
// Каждое эвристическое правило спрятано за именованным флагом профиля, чтобы его вклад
// можно было измерить A/B-прогоном `src/cli/botMatch.js`.

import { cardToString } from '../deck.js';
import { CardTracker } from './memory.js';
import {
  beats,
  cardPower,
  handStrength,
  planDefense,
  unbeatableCards,
  suitControl,
  gamePhase,
} from './analysis.js';

/** Профиль эвристик. Каждый флаг — отдельное правило раздела 5.3, включается/выключается для A/B. */
export const SMART_PROFILE = {
  holdTrumpsWhileTalon: true,   // беречь козыри и крупные карты, пока идёт прикуп
  finishOffWeakOpponent: true,  // добивать соперника картой, которую он (по подсчётам) не бьёт
  takeWhenTableUnbeatable: true,// брать сразу, если весь стол не отбить
  exactEndgame: true,           // точный счёт, когда прикуп пуст
  dumpPairs: true,              // разгружаться парами/тройками одного ранга
};

const HIGH_RANK = 12;  // дама и старше
const BIG_TRUMP = 13;  // козырные король и туз

const list = (cards) => cards.map(cardToString).join(', ');

function myHandOf(state, playerId) {
  const me = (state.players || []).find((p) => p.id === playerId);
  return me && Array.isArray(me.hand) ? me.hand : [];
}

function handCountOf(state, id) {
  const p = (state.players || []).find((x) => x.id === id);
  return p ? p.handCount || 0 : 0;
}

const PHASE_LABEL = { debut: 'начало партии', middle: 'середина партии', endgame: 'эндшпиль' };

/**
 * Умный бот. Один экземпляр = один игрок в одной партии (в нём живёт память).
 */
export class SmartBot {
  constructor(options = {}) {
    this.profile = { ...SMART_PROFILE, ...(options.profile || {}) };
    this.explain = options.explain === true;
    this.meId = options.meId || null;
    this.tracker = null;
  }

  reset(state = null, meId = null) {
    if (meId) this.meId = meId;
    this.tracker = null;
    if (state) this.observe(state, this.meId);
    return this;
  }

  observe(state, meId = null) {
    if (meId) this.meId = meId;
    if (!state) return;
    try {
      if (!this.tracker) this.tracker = CardTracker.fromState(state, this.meId);
      else this.tracker.observe(state);
    } catch {
      // Память — вспомогательный слой. Если она почему-то не смогла разобрать состояние,
      // бот продолжает играть «вслепую», но НИКОГДА не падает и не ходит нелегально.
      this.tracker = null;
    }
  }

  // ------------------------------------------------------------------
  //  Знания о сопернике (только то, что выведено из наблюдений)
  // ------------------------------------------------------------------

  _opponentKnownHand(oppId) {
    if (!this.tracker || !oppId) return null;
    try {
      if (!this.tracker.isOpponentHandCertain(oppId)) return null;
      return this.tracker.toCards(this.tracker.opponentKnownCards(oppId));
    } catch {
      return null;
    }
  }

  /** true — соперник ТОЧНО не побьёт эту карту (рука восстановлена полностью). */
  _opponentSurelyCannotBeat(oppId, card, trumpSuit) {
    const known = this._opponentKnownHand(oppId);
    if (!known) return false;
    return !known.some((c) => beats(c, card, trumpSuit));
  }

  /** true — карту вообще некому побить: ни одной бьющей карты нет вне моей руки. */
  _nobodyCanBeat(card, hand, trumpSuit) {
    if (!this.tracker) return false;
    try {
      return unbeatableCards(hand, trumpSuit, this.tracker).some(
        (c) => c.rank === card.rank && c.suit === card.suit,
      );
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------
  //  Общий «расклад» для объяснений
  // ------------------------------------------------------------------

  _analysisText(state, hand, trumpSuit, oppId) {
    const phase = gamePhase(state);
    const strength = handStrength(hand, trumpSuit, this.tracker);
    const parts = [PHASE_LABEL[phase]];
    parts.push(state.talonCount > 0 ? `в колоде ещё ${state.talonCount} карт` : 'колода пуста');
    parts.push(`у меня ${hand.length} карт (козырей ${strength.trumpCount})`);
    if (strength.unbeatableCount > 0) {
      parts.push(`непробиваемых на руках ${strength.unbeatableCount}`);
    }
    const known = this._opponentKnownHand(oppId);
    if (known && known.length) {
      // Называть чужие карты можно ТОЛЬКО когда они выведены из наблюдений однозначно.
      parts.push(`соперник держит ${list(known)}`);
    } else if (oppId) {
      parts.push(`у соперника ${handCountOf(state, oppId)} карт`);
    }
    return parts.join(', ');
  }

  // ------------------------------------------------------------------
  //  Точка входа
  // ------------------------------------------------------------------

  decide(state, playerId, legalActions) {
    if (!legalActions || legalActions.length === 0) return { action: null };
    if (playerId) this.meId = playerId;

    let picked;
    try {
      picked = this._choose(state, playerId, legalActions);
    } catch {
      picked = null;
    }
    // Страховка: что бы ни случилось внутри эвристик, наружу уходит действие ИЗ СПИСКА легальных.
    if (!picked || !legalActions.includes(picked.action)) {
      picked = { action: legalActions[0], reason: 'Играю первым доступным ходом.' };
    }
    if (!this.explain) return { action: picked.action };

    const hand = myHandOf(state, playerId);
    const oppId = playerId === state.defender ? state.attacker : state.defender;
    return {
      action: picked.action,
      reason: picked.reason,
      analysis: this._analysisText(state, hand, state.trumpSuit, oppId),
    };
  }

  _choose(state, playerId, legalActions) {
    const defends = legalActions.filter((a) => a.type === 'defend');
    const transfers = legalActions.filter((a) => a.type === 'transfer');
    const take = legalActions.find((a) => a.type === 'take');
    if (defends.length > 0 || transfers.length > 0 || take) {
      return this._decideDefense(state, playerId, legalActions, { defends, transfers, take });
    }
    return this._decideAttack(state, playerId, legalActions);
  }

  // ------------------------------------------------------------------
  //  Ход и подкидывание
  // ------------------------------------------------------------------

  _decideAttack(state, playerId, legalActions) {
    const trumpSuit = state.trumpSuit;
    const hand = myHandOf(state, playerId);
    const attacks = legalActions.filter((a) => a.type === 'attack');
    const pass = legalActions.find((a) => a.type === 'pass');

    if (attacks.length === 0) {
      return { action: pass || legalActions[0], reason: 'Подкинуть нечего — пропускаю ход.' };
    }

    const mustAttack = !pass;
    const defenderId = state.defender;
    const defenderCards = handCountOf(state, defenderId);
    const endgame = (state.talonCount || 0) === 0;
    const takingNow = state.tableGoingToDefender === true; // соперник уже решил забрать

    // Сколько карт каждого ранга у меня на руках — «топливо» для разгрузки парами.
    const rankCount = new Map();
    for (const c of hand) rankCount.set(c.rank, (rankCount.get(c.rank) || 0) + 1);

    // 1. Добивание: у соперника мало карт и есть та, которую он не отобьёт.
    if (this.profile.finishOffWeakOpponent && defenderCards > 0 && defenderCards <= 2) {
      const killers = attacks.filter(
        (a) =>
          this._opponentSurelyCannotBeat(defenderId, a.card, trumpSuit) ||
          this._nobodyCanBeat(a.card, hand, trumpSuit),
      );
      if (killers.length > 0) {
        // Из «неотбиваемых» отдаём самую дешёвую — дорогие пригодятся дальше.
        killers.sort((a, b) => cardPower(a.card, trumpSuit) - cardPower(b.card, trumpSuit));
        const known = this._opponentKnownHand(defenderId);
        return {
          action: killers[0],
          reason: known
            ? `Хожу ${cardToString(killers[0].card)} — соперник этой картой не отобьётся, а карт у него всего ${defenderCards}.`
            : `Хожу ${cardToString(killers[0].card)} — такой карты, чтобы её побить, уже ни у кого не осталось.`,
        };
      }
    }

    // 2. Сортировка кандидатов: дешевле — лучше; парные ранги идут вперёд (разгрузка).
    const scored = attacks.map((a) => {
      let score = cardPower(a.card, trumpSuit);
      if (this.profile.dumpPairs && (rankCount.get(a.card.rank) || 0) >= 2) score -= 3;
      return { a, score };
    });
    scored.sort((x, y) => x.score - y.score || cardPower(x.a.card, trumpSuit) - cardPower(y.a.card, trumpSuit));
    const choice = scored[0].a;
    const card = choice.card;
    const isTrump = card.suit === trumpSuit;
    const isHigh = card.rank >= HIGH_RANK;

    if (mustAttack) {
      return { action: choice, reason: `Захожу ${cardToString(card)} — это самая дешёвая карта, с которой не жалко начать.` };
    }

    // 3–5. Придерживание. Козырь бережём, пока это имеет смысл; крупную карту —
    // только пока идёт прикуп. В эндшпиле и при «соперник уже забирает» придерживание слабеет.
    let shouldHold = false;
    if (this.profile.holdTrumpsWhileTalon) {
      if (isTrump) {
        // Козырь отдаём, только если он уже никем не бьётся (тогда это чистая нагрузка сопернику).
        shouldHold = !(endgame && this._nobodyCanBeat(card, hand, trumpSuit));
      } else if (isHigh) {
        // Крупную некозырную придерживаем, пока есть прикуп и соперник не забирает стол.
        shouldHold = !endgame && !takingNow;
      }
    } else if (isTrump) {
      shouldHold = !endgame;
    }

    // 4. Если защитнику уже нечем отбиваться (он берёт или у него кончились карты) —
    //    грузим стол по максимуму: каждая подкинутая карта уходит ему, а у меня руки чище.
    if (takingNow && !isTrump) shouldHold = false;
    if (defenderCards === 0) shouldHold = false;

    if (!shouldHold) {
      if (takingNow) {
        return { action: choice, reason: `Подкидываю ${cardToString(card)} — соперник всё равно забирает стол, пусть берёт больше.` };
      }
      if (endgame) {
        return { action: choice, reason: `Подкидываю ${cardToString(card)} — колода пуста, сейчас главное избавляться от карт.` };
      }
      return { action: choice, reason: `Подкидываю ${cardToString(card)} — недорогая карта, её не жалко.` };
    }

    // 6. Пас: подкидывание сейчас только навредит (отдали бы козырь или крупную карту).
    return {
      action: pass,
      reason: isTrump
        ? 'Пропускаю: подкинуть могу только козырем, а его лучше приберечь.'
        : 'Пропускаю: остались только крупные карты, пока их отдавать рано.',
    };
  }

  // ------------------------------------------------------------------
  //  Защита: отбиться / перевести / взять
  // ------------------------------------------------------------------

  _decideDefense(state, playerId, legalActions, { defends, transfers, take }) {
    const trumpSuit = state.trumpSuit;
    const hand = myHandOf(state, playerId);
    const table = state.table || [];
    const undefended = table.filter((t) => t && t.attack && !t.defense);
    const endgame = (state.talonCount || 0) === 0;
    const attackerId = state.attacker;

    const plan = planDefense(table, hand, trumpSuit);

    // Перевод: предпочитаем не отдавать козырь и переводить минимумом карт.
    const sortedTransfers = [...transfers].sort((a, b) => {
      const at = a.cards.some((c) => c.suit === trumpSuit) ? 1 : 0;
      const bt = b.cards.some((c) => c.suit === trumpSuit) ? 1 : 0;
      if (at !== bt) return at - bt;
      return a.cards.length - b.cards.length;
    });
    const transfer = sortedTransfers[0];
    const cheapTransfer = transfer && !transfer.cards.some((c) => c.suit === trumpSuit) ? transfer : null;

    // 1. Весь стол не отбить и неотбитых уже несколько — берём сразу,
    //    не разбазаривая карты на заведомо проигранную защиту.
    if (this.profile.takeWhenTableUnbeatable && take && !plan.canDefendAll && undefended.length >= 2) {
      if (cheapTransfer) {
        return { action: cheapTransfer, reason: `Перевожу ${list(cheapTransfer.cards)} — весь стол мне не отбить, пусть отбивается следующий.` };
      }
      return { action: take, reason: 'Беру карты: весь стол мне всё равно не отбить, нет смысла тратить карты впустую.' };
    }

    if (defends.length === 0) {
      if (cheapTransfer) {
        return { action: cheapTransfer, reason: `Перевожу ${list(cheapTransfer.cards)} — отбиться нечем, зато ход уходит дальше.` };
      }
      if (transfer) {
        return { action: transfer, reason: `Перевожу ${list(transfer.cards)} — отбиться нечем.` };
      }
      return { action: take, reason: 'Беру карты: отбиться нечем.' };
    }

    // 2. Бьём минимальной достаточной картой; козырь — только если некозырной нет.
    const sortedDefends = [...defends].sort(
      (a, b) => cardPower(a.card, trumpSuit) - cardPower(b.card, trumpSuit),
    );
    const best = sortedDefends[0];
    const target = undefended[0] ? undefended[0].attack : best.against;
    const usesTrump = best.card.suit === trumpSuit;

    // 3. Перевод дешевле защиты козырем — переводим.
    if (usesTrump && cheapTransfer) {
      return { action: cheapTransfer, reason: `Перевожу ${list(cheapTransfer.cards)} — иначе пришлось бы тратить козырь.` };
    }

    // 5. Эндшпиль: колода пуста, считаем по-простому и точно.
    if (this.profile.exactEndgame && endgame) {
      const known = this._opponentKnownHand(attackerId);
      // Отбился — рука стала меньше; взял — больше. Когда карт мало, это решает партию.
      if (plan.canDefendAll) {
        return {
          action: best,
          reason: known
            ? `Бью ${cardToString(target)} картой ${cardToString(best.card)} — колода пуста, а я знаю, что осталось у соперника, и отбиваюсь весь стол.`
            : `Бью ${cardToString(target)} картой ${cardToString(best.card)} — колода пуста, брать карты сейчас нельзя.`,
        };
      }
      if (take) {
        return { action: take, reason: 'Беру карты: колода пуста, а отбить весь стол уже не получится.' };
      }
    }

    // 4. Не жжём крупный козырь (K/A) ради мелкой карты, пока идёт прикуп и взятие дёшево.
    if (
      this.profile.holdTrumpsWhileTalon &&
      take &&
      !endgame &&
      usesTrump &&
      best.card.rank >= BIG_TRUMP &&
      target &&
      target.suit !== trumpSuit &&
      target.rank < HIGH_RANK &&
      table.length <= 2
    ) {
      return {
        action: take,
        reason: `Беру карты: отбиться можно было бы только крупным козырем, а он дороже, чем ${cardToString(target)}.`,
      };
    }

    // Если бью некозырной, но при этом отдаю единственную старшую в масти,
    // а атака мелкая и колода ещё есть — дешевле забрать.
    if (
      this.profile.holdTrumpsWhileTalon &&
      take &&
      !endgame &&
      !usesTrump &&
      best.card.rank >= HIGH_RANK &&
      table.length <= 2 &&
      hand.length >= 6
    ) {
      const control = suitControl(hand, best.card.suit, this.tracker);
      if (control.controlled && control.myBest && control.myBest.rank === best.card.rank) {
        return {
          action: take,
          reason: `Беру карты: единственная старшая карта масти ${best.card.suit} пригодится мне позже больше, чем сейчас.`,
        };
      }
    }

    return {
      action: best,
      reason: usesTrump
        ? `Бью ${cardToString(target)} козырем ${cardToString(best.card)} — некозырной подходящей карты нет.`
        : `Бью ${cardToString(target)} картой ${cardToString(best.card)} — это самый дешёвый способ отбиться.`,
    };
  }
}

/** Фабрика в стиле `createBotBrain` — удобно для реестра уровней. */
export function createSmartBot(options = {}) {
  return new SmartBot(options);
}

/** Разовое решение без сохранения памяти (для тестов и «одноразовых» вызовов). */
export function smartBotDecide(state, playerId, legalActions, options = {}) {
  const bot = new SmartBot(options);
  bot.observe(state, playerId);
  return bot.decide(state, playerId, legalActions);
}

export default SmartBot;
