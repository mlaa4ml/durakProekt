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
import { DEFAULT_RULES } from '../rules.js';
import { CardTracker } from './memory.js';
import { canSolve, solveFromState, sameEndgameAction, DEFAULT_SOLVER_OPTIONS } from './endgame.js';
import {
  beats,
  cardPower,
  handStrength,
  planDefense,
  unbeatableCards,
  suitControl,
  gamePhase,
} from './analysis.js';
import {
  pOpponentBeats,
  pDefenseSurvives,
  expectedThrowIn,
  bestAttackByPressure,
  voidSuitsOf,
  MAX_CARD_POWER,
} from './estimate.js';

/** Профиль эвристик. Каждый флаг — отдельное правило раздела 5.3, включается/выключается для A/B. */
// Значения флагов — НЕ вкусовщина, а результат A/B-прогонов (`scripts/abProfile.js`,
// 2000 партий smart против simple, колода 24 на 2). Флаг, который не улучшает метрику,
// по требованию issue #33 выключен; таблица цифр приложена к отчёту в issue.
export const SMART_PROFILE = {
  holdTrumpsWhileTalon: true,    // беречь козыри при подкидывании, пока идёт прикуп (+1.3 п.п. без него)
  holdHighCardsWhileTalon: false,// ВЫКЛЮЧЕН: придерживание Q+ стоило 12.6 п.п. — некозырную мелочь
                                 // выгоднее сбрасывать сразу, иначе рука к эндшпилю забита старьём
  avoidBurningBigTrump: true,    // лучше взять, чем спалить козырного K/A ради мелочи
  finishOffWeakOpponent: true,   // добивать соперника картой, которую он (по подсчётам) не бьёт
  takeWhenTableUnbeatable: true, // брать сразу, если весь стол не отбить
  exactEndgame: true,            // точный счёт, когда прикуп пуст
  dumpPairs: true,               // разгружаться парами/тройками одного ранга (+3.2 п.п. без него)
  exactEndgameSolver: true,      // ПОЛНЫЙ перебор концовки дуэли, когда рука соперника известна точно
                                 // (src/bots/endgame.js, issue #48). Матрица A/B «с решателем против без»:
                                 // 2×24/36/52 — 36,9 / 38,9 / 40,4 % «дурака» у новой версии (по 900 партий,
                                 // ± 3,3 п.п.), остальные конфигурации ≤ 51 %. Бюджет — 2 с на ход.

  // --- этап 4 (issue #49): вероятностные оценки из памяти, src/bots/estimate.js ---
  attackByPressure: false, // A/B: ВРЕДИТ (24x2: 45.1% дурака против 20.4% без него; 36x2: 58.7% против 21.5%) -> выключено, как holdHighCardsWhileTalon        // ходить/подкидывать картой с наибольшим шансом, что соперник НЕ отобьётся
                                 // (`bestAttackByPressure`: давление минус нормированная цена карты),
                                 // вместо «просто самой дешёвой». Цифры A/B — в отчёте issue #49.
  probabilisticTake: false, // A/B: ВРЕДИТ (24x2: 45.1% против 31.7% без него; 36x2: 58.7% против 45.9%) -> выключено до доработки модели цены защиты       // «брать или отбиваться» по ожидаемой цене: сравниваем ожидаемую цену
                                 // защиты (карты, которые уйдут, с учётом `expectedThrowIn`) с ценой взятия,
                                 // а не по порогам. Раздел 1.5 roadmap: грубый порог давал чистый шум.
};

// Вес цены отдаваемой карты в оценке атаки: 1 п.п. давления стоит примерно 1 % шкалы cardPower.
// Значение не «на глаз»: cost нормирован на козырного туза (MAX_CARD_POWER), поэтому 0.35 означает
// «отдать козырного туза вместо шестёрки оправдано, только если это даёт >35 п.п. давления».
const PRESSURE_COST_WEIGHT = 0.35;

// Порога «шанс отбиться ниже X — беру» здесь СОЗНАТЕЛЬНО нет (раздел 1.5 roadmap: такое правило
// дало чистый шум). Решение принимается только сравнением двух ожидаемых цен в шкале cardPower.

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

/**
 * Сколько игроков ещё в партии. Вероятностные правила этапа 4 (issue #49) включаются
 * только в дуэли: оценка `pOpponentBeats` считает ОДНОГО соперника, а за столом на 3–4
 * человека карту может побить любой другой игрок, и оценка систематически завышает
 * давление. На фаззинге (`test/botLegality.test.js`, 36×4 и 52×3) это выливалось в
 * бесконечно тянущиеся партии: боты перестают закрывать раунды и упираются в лимит шагов.
 */
function alivePlayersCount(state) {
  return (state.players || []).filter((p) => !p.out).length;
}

/**
 * Правила партии глазами бота. Берёт `state.rules` (его отдаёт движок), а если его нет —
 * старое состояние, рукописное в тесте или пришедшее от устаревшего сетевого клиента —
 * подставляет безопасный фолбэк: значения по умолчанию, но число игроков и размер колоды
 * выводятся из самого состояния. Возвращает новый объект, состояние не меняется.
 * Производные величины (`maxAttacksNow`, `allowedThrowInRanks`, `throwInPlayers`) сюда
 * не входят: их бот читает прямо из состояния, когда они понадобятся в решениях.
 */
export function rulesOfState(state) {
  const given = state && typeof state.rules === 'object' && state.rules !== null ? state.rules : null;
  const players = state && Array.isArray(state.players) ? state.players : [];
  const fallback = { ...DEFAULT_RULES };
  if (players.length >= 2) fallback.numPlayers = players.length;
  if (state && !(given && given.deckSize)) {
    try { fallback.deckSize = CardTracker.guessDeckSize(state); } catch { /* остаётся значение по умолчанию */ }
  }
  return { ...fallback, ...(given || {}) };
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
    this.rules = { ...DEFAULT_RULES }; // правила партии; обновляются из state.rules при каждом наблюдении
    this._rulesSrc = null;             // объект state.rules, из которого получен this.rules
    // Бюджет решателя концовки (`exactEndgameSolver`) и счётчики его работы — чтобы стоимость
    // можно было измерить снаружи: сколько раз звали, сколько решил, сколько упёрлось в бюджет.
    this.solverOptions = { ...DEFAULT_SOLVER_OPTIONS, ...(options.solver || {}) };
    this.solverStats = { calls: 0, used: 0, wins: 0, draws: 0, losses: 0, timedOut: 0, unusable: 0, nodes: 0, ms: 0 };
  }

  reset(state = null, meId = null) {
    if (meId) this.meId = meId;
    this.tracker = null;
    this._rulesSrc = null;
    if (state) this.observe(state, this.meId);
    return this;
  }

  observe(state, meId = null) {
    if (meId) this.meId = meId;
    if (!state) return;
    this._syncRules(state);
    try {
      if (!this.tracker) this.tracker = CardTracker.fromState(state, this.meId);
      else this.tracker.observe(state);
    } catch {
      // Память — вспомогательный слой. Если она почему-то не смогла разобрать состояние,
      // бот продолжает играть «вслепую», но НИКОГДА не падает и не ходит нелегально.
      this.tracker = null;
    }
  }

  /** Обновляет this.rules по состоянию; тот же объект state.rules, что и в прошлый раз, не пересчитывается. */
  _syncRules(state) {
    const src = state && state.rules ? state.rules : null;
    if (src && src === this._rulesSrc) return;
    this.rules = rulesOfState(state);
    this._rulesSrc = src;
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
    this._syncRules(state); // decide() можно вызвать и без observe()

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
    // Концовка дуэли с известной рукой соперника — точный счёт вместо эвристик.
    const exact = this._tryExactSolver(state, playerId, legalActions);
    if (exact) return exact;

    const defends = legalActions.filter((a) => a.type === 'defend');
    const transfers = legalActions.filter((a) => a.type === 'transfer');
    const take = legalActions.find((a) => a.type === 'take');
    if (defends.length > 0 || transfers.length > 0 || take) {
      return this._decideDefense(state, playerId, legalActions, { defends, transfers, take });
    }
    return this._decideAttack(state, playerId, legalActions);
  }

  // ------------------------------------------------------------------
  //  Точный счёт концовки (src/bots/endgame.js)
  // ------------------------------------------------------------------

  /**
   * Если прикуп пуст, живых двое и рука соперника известна точно — просчитывает партию
   * до конца и возвращает ход, при котором выигрыш (или, если выигрыша нет, ничья) гарантирован.
   * Возвращает null — и тогда решает обычная политика — если: флаг выключен, решатель неприменим,
   * не уложился в бюджет, позиция проиграна (тут эвристики хотя бы могут рассчитывать на ошибку
   * соперника) или результат не сошёлся с движком по списку легальных ходов.
   */
  _tryExactSolver(state, playerId, legalActions) {
    if (!this.profile.exactEndgameSolver || !this.tracker) return null;
    if (!canSolve(state, this.tracker, playerId)) return null;

    const stats = this.solverStats;
    const res = solveFromState(state, this.tracker, playerId, this.solverOptions);
    if (!res) return null;
    stats.calls++;
    stats.nodes += res.nodes;
    stats.ms += res.ms;
    if (res.timedOut) { stats.timedOut++; return null; }
    if (!res.solved || !res.action) { stats.unusable++; return null; }

    // Страховка от расхождения с движком: копия позиции обязана дать те же легальные ходы.
    const sameSet = res.legal.length === legalActions.length
      && res.legal.every((r) => legalActions.some((a) => sameEndgameAction(a, r)));
    const chosen = legalActions.find((a) => sameEndgameAction(a, res.action));
    if (!sameSet || !chosen) { stats.unusable++; return null; }

    if (res.value < 0) { stats.losses++; return null; }
    if (res.value > 0) stats.wins++; else stats.draws++;
    stats.used++;
    return { action: chosen, reason: this._solverReason(chosen, res.value) };
  }

  _solverReason(action, value) {
    let head;
    switch (action.type) {
      case 'attack': head = `Хожу ${cardToString(action.card)}`; break;
      case 'defend': head = `Бью ${cardToString(action.against)} картой ${cardToString(action.card)}`; break;
      case 'transfer': head = `Перевожу картой ${list(action.cards)}`; break;
      case 'pass': head = 'Пропускаю подкидывание'; break;
      case 'take': head = 'Беру карты'; break;
      default: head = 'Делаю ход';
    }
    const why = 'прикуп пуст, рука соперника вычислена, партия просчитана до конца';
    return value > 0
      ? `${head}${action.type === 'attack' ? ' так, чтобы соперник остался с картами' : ''}: ${why} — при любой его игре выигрываю.`
      : `${head}: ${why} — выиграть не выходит, но этот ход не даёт проиграть (ничья).`;
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

    // 2. Сортировка кандидатов.
    //    Базовая (как раньше): дешевле — лучше; парные ранги идут вперёд (разгрузка).
    //    С флагом `attackByPressure` — по шансу, что соперник НЕ отобьётся, с поправкой
    //    на цену отдаваемой карты (этап 4, issue #49; оценки — src/bots/estimate.js).
    let choice;
    let pressurePick = null;
    //    Правило работает только в дуэли: при 3+ игроках карту может побить не только
    //    защитник (перевод/следующий круг), и оценка давления систематически завышена —
    //    на фаззинге 36×4 и 52×3 это приводило к нескончаемым партиям.
    if (this.profile.attackByPressure && this.tracker && !takingNow && defenderCards > 0
        && alivePlayersCount(state) === 2) {
      try {
        const ranked = bestAttackByPressure(attacks, this.tracker, state, {
          costWeight: PRESSURE_COST_WEIGHT,
          oppId: defenderId,
          trumpSuit,
        }).map((r) => {
          // Разгрузка парами остаётся отдельным правилом и здесь тоже учитывается:
          // пара по шкале давления стоит столько же, сколько 3 единицы cardPower раньше.
          const bonus = this.profile.dumpPairs && (rankCount.get(r.card.rank) || 0) >= 2
            ? (PRESSURE_COST_WEIGHT * 3) / MAX_CARD_POWER
            : 0;
          return { ...r, score: r.score + bonus };
        });
        ranked.sort((x, y) => y.score - x.score || x.cost - y.cost);
        if (ranked.length) pressurePick = ranked[0];
      } catch {
        pressurePick = null;    // оценки — вспомогательный слой, без них играем как раньше
      }
    }
    if (pressurePick) {
      choice = pressurePick.action;
    } else {
      const scored = attacks.map((a) => {
        let score = cardPower(a.card, trumpSuit);
        if (this.profile.dumpPairs && (rankCount.get(a.card.rank) || 0) >= 2) score -= 3;
        return { a, score };
      });
      scored.sort((x, y) => x.score - y.score || cardPower(x.a.card, trumpSuit) - cardPower(y.a.card, trumpSuit));
      choice = scored[0].a;
    }
    const card = choice.card;
    const isTrump = card.suit === trumpSuit;
    const isHigh = card.rank >= HIGH_RANK;

    // 2б. Если выбор сделан по давлению и шанс, что соперник отобьётся, реально мал —
    //     объясняем это словами, не раскрывая того, чего бот не знает.
    if (pressurePick && pressurePick.pBeat <= 0.25 && defenderCards > 0) {
      const voids = voidSuitsOf(this.tracker, defenderId);
      const why = voids.includes(card.suit)
        ? 'этой масти он ни разу не бил, скорее всего её у него нет'
        : (pressurePick.pBeat === 0
          ? 'побить такую карту ему, судя по всему, уже нечем'
          : 'шансов отбиться у него тут почти нет');
      return {
        action: choice,
        reason: `${mustAttack ? 'Захожу' : 'Подкидываю'} ${cardToString(card)} — ${why}.`,
      };
    }

    if (mustAttack) {
      return { action: choice, reason: `Захожу ${cardToString(card)} — это самая дешёвая карта, с которой не жалко начать.` };
    }

    // 3–5. Придерживание. Козырь бережём, пока это имеет смысл; крупную карту —
    // только пока идёт прикуп. В эндшпиле и при «соперник уже забирает» придерживание слабеет.
    let shouldHold = false;
    if (isTrump) {
      // Козырь: придерживаем, пока идёт прикуп. Когда колода пуста, козырь — лучшая
      // нагрузка для соперника, и держать его «на всякий случай» уже поздно.
      shouldHold = this.profile.holdTrumpsWhileTalon
        ? !endgame && !this._nobodyCanBeat(card, hand, trumpSuit)
        : false;
    } else if (isHigh && this.profile.holdHighCardsWhileTalon) {
      // Крупную некозырную придерживаем, пока есть прикуп и соперник не забирает стол.
      shouldHold = !endgame && !takingNow;
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
      return {
        action: choice,
        reason: isHigh
          ? `Подкидываю ${cardToString(card)} — держать крупную карту про запас невыгодно, лучше разгрузить руку сейчас.`
          : `Подкидываю ${cardToString(card)} — недорогая карта, её не жалко.`,
      };
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

    // 3.5. Вероятностный выбор «брать или отбиваться» (этап 4, issue #49).
    //      Никаких порогов «на глаз»: сравниваем ДВЕ ожидаемые цены в одной и той же шкале
    //      ценности карт (`cardPower`).
    //        цена взятия  = всё, что лежит на столе, плюс то, что ещё подкинут;
    //        цена защиты  = карты, которые уйдут с руки на отбой, плюс риск,
    //                       что отбиться всё равно не выйдет и стол придётся забрать.
    //      Работает, только пока идёт прикуп: при пустой колоде решает точный счёт
    //      (`exactEndgame` / `exactEndgameSolver`), там взятие оценивается иначе.
    if (this.profile.probabilisticTake && take && !endgame && this.tracker
        && alivePlayersCount(state) === 2) {
      try {
        const pSurv = pDefenseSurvives(table, hand, this.tracker, state);
        const extra = expectedThrowIn(state, this.tracker, playerId);
        const tableCost = table.reduce(
          (s, t) => s + (t.attack ? cardPower(t.attack, trumpSuit) : 0) + (t.defense ? cardPower(t.defense, trumpSuit) : 0),
          0,
        );
        const tableCards = table.reduce((s, t) => s + 1 + (t.defense ? 1 : 0), 0);
        const avgCard = tableCards ? tableCost / tableCards : 0;
        // Цена взятия: вся ценность, которая переедет со стола мне в руку (плюс то, что подкинут).
        const costTake = tableCost + extra * avgCard;
        // Цена защиты — НЕ вся потраченная карта: успешная защита уносит в бито и мою карту,
        // и атаку соперника, то есть руку она разгружает. Реально теряю только «переплату»:
        // насколько отдаваемая карта дороже той, которую она убирает со стола
        // (бить семёрку козырным королём — переплата почти в целый козырь, своей восьмёркой — в единицу).
        const overpay = plan.canDefendAll
          ? plan.assignment.reduce(
            (s, x) => s + Math.max(0, cardPower(x.card, trumpSuit) - cardPower(x.attack, trumpSuit)),
            0,
          )
          : Infinity;
        // Не отбился — всё равно забираю стол, да ещё и потратив карты на отбой.
        const costDefend = overpay + (1 - pSurv) * (costTake + overpay);
        if (costTake < costDefend) {
          if (cheapTransfer) {
            return {
              action: cheapTransfer,
              reason: `Перевожу ${list(cheapTransfer.cards)} — отбиться до конца я вряд ли успею, а так стол уйдёт дальше.`,
            };
          }
          const voids = voidSuitsOf(this.tracker, attackerId);
          const why = voids.length
            ? 'подкидывать ему есть чем, а я на этом потеряю больше, чем заберу'
            : 'мне ещё подкинут, и защита обойдётся дороже, чем взятые карты';
          return { action: take, reason: `Беру карты: ${why}.` };
        }
      } catch {
        // Оценки — вспомогательный слой: если что-то пошло не так, решают обычные правила.
      }
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
      this.profile.avoidBurningBigTrump &&
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
      this.profile.holdHighCardsWhileTalon &&
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
