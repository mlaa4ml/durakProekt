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
  dumpPairs: false,              // ВЫКЛЮЧЕН перекалибровкой этапа 5 (issue #50). Историческое «+3.2 п.п.
                                 // без него» получено непарным прогоном; парная проверка (одна и та же
                                 // раздача играется с флагом и без, seed 777) показала обратное:
                                 // 2×24 — 20,4 % «дурака» БЕЗ флага против 25,5 % с ним (−5,1 п.п.),
                                 // 4×24 −2,2, 4×36 −0,2. Сырые логи: bench/stage5-ab-part1.txt.
  exactEndgameSolver: true,      // ПОЛНЫЙ перебор концовки дуэли, когда рука соперника известна точно
                                 // (src/bots/endgame.js, issue #48). Матрица A/B «с решателем против без»:
                                 // 2×24/36/52 — 36,9 / 38,9 / 40,4 % «дурака» у новой версии (по 900 партий,
                                 // ± 3,3 п.п.), остальные конфигурации ≤ 51 %. Бюджет — 2 с на ход.

  // --- issue #61: разбор «глупостей» бота, замеченных в реальных партиях ---
  keepTrumpWhenOpponentTakes: true, // защитник уже сказал «беру»: подкидываем ТОЛЬКО некозырными.
                                    // Козырь в этой ситуации не «нагружает» соперника, а дарит ему
                                    // оружие, при этом мелочь остаётся у меня на руке.
  useKnownHandAttack: true,         // рука соперника восстановлена памятью точно -> хожу картой,
                                    // которую он не побьёт (или которая дороже всего ему обойдётся),
                                    // а не «просто самой дешёвой по очереди».
  preferTransferWhenCheap: true,    // защита: перевод некозырной картой не дороже защиты -> перевожу,
                                    // весь стол уходит дальше вместо того, чтобы висеть на мне.

  // --- этап 4 (issue #49): вероятностные оценки из памяти, src/bots/estimate.js ---
  attackByPressure: false,       // ходить/подкидывать картой с наибольшим шансом, что соперник НЕ отобьётся
                                 // (`bestAttackByPressure`: давление минус нормированная цена карты),
                                 // вместо «просто самой дешёвой».
                                 // A/B (200 партий на конфигурацию, доля «дурака» у smart, меньше = лучше):
                                 // 24×2 — 45,1 % с флагом против 28,4 % без него; 36×2 — 58,7 % против 57,1 %.
                                 // Правило ВРЕДИТ, поэтому по умолчанию выключено (как holdHighCardsWhileTalon).
  probabilisticTake: false,      // «брать или отбиваться» по ожидаемой цене: сравниваем ожидаемую цену
                                 // защиты (карты, которые уйдут, с учётом `expectedThrowIn`) с ценой взятия,
                                 // а не по порогам. Раздел 1.5 roadmap: грубый порог давал чистый шум.
                                 // A/B: 24×2 — 45,1 % с флагом против 31,7 % без него; 36×2 — 58,7 % против 45,9 %.
                                 // Тоже ВРЕДИТ: модель цены защиты переоценивает выгоду риска -> выключено
                                 // до доработки (см. отчёт в issue #49).
                                 //
                                 // Проверялась гипотеза «включить оба флага только в дуэли, до которой партия
                                 // ДОШЛА с 3-4 игроков» (rules.numPlayers > 2 && живых осталось двое) — в
                                 // одиночном прогоне 36×4 на 200 партий (Math.random, без фиксации seed) это
                                 // якобы улучшало результат: 34,0 % «дурака» у smart с флагами против 41,7 %
                                 // без них. Повторная проверка с парными seed'ами (одна и та же партия
                                 // играется с флагами и без — так шум одной раздачи не портит сравнение) и
                                 // бо́льшей выборкой разницу НЕ подтвердила ни на одной конфигурации:
                                 //   24×2  (N=300, флаги и так выключены гейтом): 21,4 % / 21,4 %
                                 //   36×3  (N=300): 39,6 % / 39,7 %
                                 //   36×4  (N=300): 38,1 % / 39,2 %;  (N=600): 38,7 % / 38,9 %
                                 //   52×3  (N=300): 42,9 % / 43,1 %
                                 //   24×4  (N=300): 52,1 % / 51,7 %
                                 // Разница везде в пределах шума (±3 п.п. при N≈300). Исходные 34,0 / 41,7 %
                                 // были статистической случайностью одного непарного прогона на 200 партий.
                                 // Вывод: включать флаги по числу игроков за столом смысла не имеет — держим
                                 // оба флага выключенными во всех конфигурациях, пока модель не доработана.
};

// ---------------------------------------------------------------------------
//  Профили по варианту игры (этап 5, issue #50)
// ---------------------------------------------------------------------------
//
// Раздел 1.4 roadmap: эвристики выше подбирались на колоде 24 на 2 игрока, и на других
// столах те же флаги ведут себя иначе. Поэтому профиль теперь не один: бот САМ выбирает
// его по `state.rules` (этап 2, issue #47). Наружу (в интерфейс) профили не выводятся —
// уровней для пользователя по-прежнему два, «простой» и «умный».
//
//   duel  — 2 игрока     (историческая калибровка, колоды 24/36/52)
//   small — 3–4 игрока   (проблемные точки 4×24 и 4×36)
//   large — 5–6 игроков  (проблемная точка 6×52)
//
// Все профили строятся спредом от `SMART_PROFILE`, поэтому набор ключей у них ОДИНАКОВ
// (флаг нельзя потерять в одном из профилей — это проверяет test/profiles.test.js).
// Каждое отличие от базы сопровождается цифрой A/B-прогона (`scripts/abProfile.js`).
export const SMART_PROFILES = {
  // 2 игрока — исторический профиль: цифры см. в комментариях к SMART_PROFILE выше.
  duel: SMART_PROFILE,

  // 3–4 игрока. Перекалибровка этапа 5 — парные раздачи, seed 777, сырые логи в
  // `bench/stage5-ab-part1.txt`, `bench/stage5-ab-4x36-rest.txt`, сводка в `bench/stage5-ab.md`.
  small: {
    ...SMART_PROFILE,
    avoidBurningBigTrump: false, // A/B «с флагом» к базе профиля small: 4×24 (N=200) +0,0 п.п.;
                                 // 4×36 (N=200) −0,9; 4×36 «neighbors» (N=100) +2,1; 4×36
                                 // «attackerOnly» (N=100) −1,5. Разброс в пределах шума, выигрыша нет,
                                 // а раздел 1.4 roadmap фиксировал ≈ 2 п.п. в пользу ВЫКЛЮЧЕННОГО флага
                                 // -> держим выключенным: за столом 3–4 человек отбой чаще доигрывают
                                 // подкидыванием, и «поберечь козырного короля, взяв карты» оборачивается
                                 // лишним взятием.
    dumpPairs: false,            // ВЫКЛЮЧЕН по перекалибровке: без него результат не хуже НИ НА ОДНОЙ
                                 // точке этапа 5 — 4×24 (N=200) 45,5 % без флага против 47,7 % с ним
                                 // (−2,2 п.п.), 4×36 (N=200) −0,2, 4×36 (N=120, остальные флаги) −0,2,
                                 // «neighbors» −0,9, «attackerOnly» ±0,0. Исторические +3,2 п.п. в пользу
                                 // флага были получены только на 24×2 -> в дуэли он и остаётся (см. duel).
    finishOffWeakOpponent: true, // подтверждён: 4×36 БЕЗ флага 40,1 % против 36,5 % (+3,6 п.п. хуже).
    holdTrumpsWhileTalon: true,  // подтверждён и здесь: 4×36 без него 48,9 % против 36,5 % (+12,5 п.п.).
  },

  // 5–6 игроков (сырой лог `bench/stage5-ab-6x52.txt`, 6×52, парные раздачи).
  large: {
    ...SMART_PROFILE,
    avoidBurningBigTrump: false, // то же, что в `small`, только сильнее: чем больше подкидывающих,
                                 // тем дороже взятие и тем менее оправдана экономия крупного козыря.
    dumpPairs: false,            // как в `small`: выигрыша от разгрузки парами за большим столом нет
                                 // (4×24 −2,2 п.п. без флага, 4×36 −0,2), а цена ошибки выше —
                                 // отдельного замера на 6×52 не хватило бюджета, наследуем решение small.
    finishOffWeakOpponent: true, // за большим столом добить игрока с 1–2 картами по-прежнему выгодно:
                                 // он выбывает, и стол быстрее сводится к дуэли (4×36: +3,6 п.п. без флага).
    holdTrumpsWhileTalon: true,  // ключевой флаг именно здесь: 6×52 (N=60) без него 66,7 % против 50,0 %
                                 // базы (+16,7 п.п.) — беречь козыри при живом прикупе за большим столом
                                 // важнее всего.
  },
};

/** Имя профиля по правилам партии. Неизвестное/отсутствующее `rules` -> безопасный дефолт `duel`. */
export function pickProfileName(rules) {
  const n = rules && typeof rules === 'object' ? Number(rules.numPlayers) : NaN;
  if (!Number.isFinite(n) || n <= 2) return 'duel';
  if (n <= 4) return 'small';
  return 'large';
}

/**
 * Профиль эвристик по правилам партии (`state.rules` или его фолбэк из `rulesOfState`).
 * Никогда не бросает и всегда возвращает существующий объект профиля.
 */
export function pickProfile(rules) {
  return SMART_PROFILES[pickProfileName(rules)] || SMART_PROFILES.duel;
}

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
    // Явно переданный профиль (A/B-прогоны, тесты) ПЕРЕКРЫВАЕТ автоподбор: то, что попросили
    // снаружи, важнее. Если его нет — профиль выбирается по правилам партии (`pickProfile`)
    // и фиксируется на партию, как и уровень бота.
    this.profileOverride = options.profile ? { ...options.profile } : null;
    this.profileName = this.profileOverride ? 'custom' : 'duel';
    this.profile = { ...SMART_PROFILE, ...(this.profileOverride || {}) };
    this._profileFixed = this.profileOverride !== null; // профиль на эту партию уже определён
        this.explain = options.explain === true;
    // Trace is opt-in independently of prose; neither switch participates in policy.
    this.trace = options.trace === true;
    this._decisionTrace = null;
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
    // Новая партия — профиль подбирается заново (если его не задали снаружи).
    this._profileFixed = this.profileOverride !== null;
    if (state) this.observe(state, this.meId);
    return this;
  }

  observe(state, meId = null, event = null) {
    if (meId) this.meId = meId;
    if (!state) return;
    this._syncRules(state);
    try {
      if (!this.tracker) this.tracker = CardTracker.fromState(state, this.meId);
      if (event) this.tracker.observeTransition(state, event);
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
    if (src && src === this._rulesSrc) { this._applyProfile(); return; }
    this.rules = rulesOfState(state);
    this._rulesSrc = src;
    this._applyProfile();
  }

  /**
   * Профиль по варианту игры (этап 5, issue #50). Выбирается АВТОМАТИЧЕСКИ по this.rules
   * и фиксируется до следующего reset(): менять эвристики посреди партии (например, когда
   * за столом на 4 человек осталось двое) — значит играть двумя разными ботами в одной
   * раздаче; проверка такой смены в issue #49 улучшения не дала.
   */
  _applyProfile() {
    if (this._profileFixed) return;
    this.profileName = pickProfileName(this.rules);
    this.profile = { ...pickProfile(this.rules) };
    this._profileFixed = true;
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
    this._decisionTrace = null;
    if (!legalActions || legalActions.length === 0) return { action: null };
    if (playerId) this.meId = playerId;
    this._syncRules(state); // decide() можно вызвать и без observe()
    const oppId = playerId === state.defender ? state.attacker : state.defender;
    const known = this._opponentKnownHand(oppId);
    // Only metadata: no hands, inferred cards, snapshots or exception messages.
    const trace = this._decisionTrace = {
      version: 1, actionId: null, selectedRule: null, emergencyFallback: false,
      handKnowledge: known !== null ? 'exact' : 'unknown',
      profile: { name: this.profileName, version: 1, flags: { ...this.profile } },
      solver: {
        enabled: !!this.profile.exactEndgameSolver, applicable: false,
        status: 'not-attempted', solved: false, timedOut: false,
        value: null, nodes: 0, ms: 0,
      },
    };
    let picked;
    try {
      picked = this._choose(state, playerId, legalActions);
    } catch {
      picked = null;
      trace.solver.status = 'exception';
    }
    // Страховка: что бы ни случилось внутри эвристик, наружу уходит действие ИЗ СПИСКА легальных.
    if (!picked || !legalActions.includes(picked.action)) {
      trace.emergencyFallback = true;
      picked = { action: legalActions[0], rule: 'emergency-first-legal', reason: 'Аварийный выбор: играю первым доступным ходом.' };
    }
    trace.selectedRule = picked.rule;
    const result = { action: picked.action };
    if (this.trace) result.decisionTrace = trace;
    if (this.explain) {
      result.reason = this._decisionReason(picked, trace);
      try {
        result.analysis = this._analysisText(state, myHandOf(state, playerId), state.trumpSuit, oppId);
      } catch {
        result.analysis = null;
      }
    }
    return result;
  }

  _decisionReason(picked, trace) {
    if (trace.selectedRule === 'exact-solver') {
      return this._solverReason(picked.action, trace.solver.value);
    }
    const labels = {
      disabled: 'Точный решатель выключен.',
      'unknown-hand': 'Точная рука соперника неизвестна.',
      'not-applicable': 'Точный решатель неприменим к этой позиции.',
      budget: 'Бюджет поиска исчерпан; полного решения нет.',
      'legal-mismatch': 'Результат поиска отклонён: легальные действия не совпали.',
      unusable: 'Результат поиска непригоден; полного решения нет.',
      'proven-loss': 'Полный поиск доказал проигрыш при точной игре соперника.',
      exception: 'Ошибка выбора хода.',
      'not-attempted': 'Поиск не запускался.',
    };
    return `${labels[trace.solver.status] || ''} ${trace.emergencyFallback ? '' : 'Эвристика: '}${picked.reason}`.trim();
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
    const trace = this._decisionTrace?.solver;
    const reject = (status) => { if (trace) trace.status = status; return null; };
    const applicable = canSolve(state, this.tracker, playerId);
    if (trace) trace.applicable = applicable;
    if (!this.profile.exactEndgameSolver) return reject('disabled');
    if (!applicable) {
      return reject(this._decisionTrace?.handKnowledge === 'unknown' ? 'unknown-hand' : 'not-applicable');
    }

    const stats = this.solverStats;
    const res = this._solveExact(state, playerId);
    if (!res) return reject('unusable');
    if (trace) Object.assign(trace, {
      solved: res.solved === true, timedOut: res.timedOut === true,
      value: res.value ?? null, nodes: res.nodes ?? 0, ms: res.ms ?? 0,
    });
    stats.calls++;
    stats.nodes += res.nodes;
    stats.ms += res.ms;
    if (res.timedOut) { stats.timedOut++; return reject('budget'); }
    if (res.mismatch) { stats.unusable++; return reject('legal-mismatch'); }
    if (!res.solved || !res.action) { stats.unusable++; return reject('unusable'); }

    // Страховка от расхождения с движком: копия позиции обязана дать те же легальные ходы.
    const sameSet = Array.isArray(res.legal) && res.legal.length === legalActions.length
      && res.legal.every((r) => legalActions.some((a) => sameEndgameAction(a, r)));
    const chosen = legalActions.find((a) => sameEndgameAction(a, res.action));
    if (!sameSet || !chosen) { stats.unusable++; return reject('legal-mismatch'); }

    if (res.value < 0) { stats.losses++; return reject('proven-loss'); }
    if (res.value > 0) stats.wins++; else stats.draws++;
    stats.used++;
    if (trace) trace.status = 'used';
    return { action: chosen, rule: 'exact-solver', reason: this._solverReason(chosen, res.value) };
  }

  _solveExact(state, playerId) {
    return solveFromState(state, this.tracker, playerId, this.solverOptions);
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
      return { rule: 'pass-no-attack', action: pass || legalActions[0], reason: 'Подкинуть нечего — пропускаю ход.' };
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
    if (this.profile.finishOffWeakOpponent && !takingNow && defenderCards > 0 && defenderCards <= 2) {
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
          rule: 'finish-weak-opponent',
          action: killers[0],
          reason: known
            ? `Хожу ${cardToString(killers[0].card)} — соперник этой картой не отобьётся, а карт у него всего ${defenderCards}.`
            : `Хожу ${cardToString(killers[0].card)} — такой карты, чтобы её побить, уже ни у кого не осталось.`,
        };
      }
    }

    // 1б. Не дарим козырь сопернику, который уже берёт (issue #61).
    let pool = attacks;
    if (this.profile.keepTrumpWhenOpponentTakes && takingNow) {
      const nonTrump = attacks.filter((a) => a.card.suit !== trumpSuit);
      if (nonTrump.length > 0) pool = nonTrump;
    }

    // 1в. Точная известная рука: неотбиваемая карта или дорогой отбой (issue #61).
    if (this.profile.useKnownHandAttack && !takingNow && defenderCards > 0) {
      const known = this._opponentKnownHand(defenderId);
      if (known && known.length) {
        const unbeatable = pool.filter((a) => !known.some((c) => beats(c, a.card, trumpSuit)));
        if (unbeatable.length > 0) {
          unbeatable.sort((a, b) => cardPower(a.card, trumpSuit) - cardPower(b.card, trumpSuit));
          return {
            rule: 'known-hand-unbeatable',
            action: unbeatable[0],
            reason: `${mustAttack ? 'Захожу' : 'Подкидываю'} ${cardToString(unbeatable[0].card)} — я знаю руку соперника, этой картой ему не отбиться.`,
          };
        }
        const ranked = pool.map((a) => {
          const beaters = known.filter((c) => beats(c, a.card, trumpSuit));
          const cheapestBeat = Math.min(...beaters.map((c) => cardPower(c, trumpSuit)));
          const my = cardPower(a.card, trumpSuit);
          return { a, my, gain: cheapestBeat - PRESSURE_COST_WEIGHT * my };
        });
        ranked.sort((x, y) => y.gain - x.gain || x.my - y.my);
        const top = ranked[0];
        if (top && top.gain > 0) {
          const bestCard = top.a.card;
          const isT = bestCard.suit === trumpSuit;
          // Козырь ради «дорогого отбоя» не отдаём, пока идёт прикуп.
          if (!(isT && !endgame && this.profile.holdTrumpsWhileTalon) || !pass) {
            return {
              rule: 'known-hand-expensive-defense',
              action: top.a,
              reason: `${mustAttack ? 'Захожу' : 'Подкидываю'} ${cardToString(bestCard)} — я знаю руку соперника: отбиться он сможет только дорогой картой.`,
            };
          }
        }
      }
    }

    // 2. Цена карты с бонусом пары либо вероятностное давление (только в дуэли).
    let choice;
    let pressurePick = null;
    if (this.profile.attackByPressure && this.tracker && !takingNow && defenderCards > 0
        && alivePlayersCount(state) === 2) {
      try {
        const ranked = bestAttackByPressure(pool, this.tracker, state, {
          costWeight: PRESSURE_COST_WEIGHT,
          oppId: defenderId,
          trumpSuit,
        }).map((r) => {
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
      const scored = pool.map((a) => {
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
    const rankingRule = pressurePick ? 'pressure' : this.profile.dumpPairs ? 'cost-with-pairs' : 'cheapest';
    if (this._decisionTrace) {
      this._decisionTrace.attackRanking = rankingRule;
      this._decisionTrace.keptTrumpsWhenTaking = pool !== attacks;
    }

    if (pressurePick && pressurePick.pBeat <= 0.25 && defenderCards > 0) {
      const voids = voidSuitsOf(this.tracker, defenderId);
      const why = voids.includes(card.suit)
        ? 'этой масти он ни разу не бил, скорее всего её у него нет'
        : (pressurePick.pBeat === 0
          ? 'побить такую карту ему, судя по всему, уже нечем'
          : 'шансов отбиться у него тут почти нет');
      return {
        rule: 'attack-pressure',
        action: choice,
        reason: `${mustAttack ? 'Захожу' : 'Подкидываю'} ${cardToString(card)} — ${why}.`,
      };
    }

    if (mustAttack) {
      const why = pressurePick ? 'выбираю по оценке давления с учётом цены карты'
        : this.profile.dumpPairs ? 'выбираю по цене карты с учётом разгрузки пар'
        : 'это самая дешёвая карта, с которой не жалко начать';
      return { rule: `attack-${rankingRule}`, action: choice, reason: `Захожу ${cardToString(card)} — ${why}.` };
    }

    // 3–5. Придерживание козыря/крупной карты при живом прикупе.
    let shouldHold = false;
    if (isTrump) {
      shouldHold = this.profile.holdTrumpsWhileTalon
        ? !endgame && !this._nobodyCanBeat(card, hand, trumpSuit)
        : false;
    } else if (isHigh && this.profile.holdHighCardsWhileTalon) {
      shouldHold = !endgame && !takingNow;
    }

    if (takingNow && !isTrump) shouldHold = false;
    if (defenderCards === 0) shouldHold = false;

    if (!shouldHold) {
      if (takingNow) {
        return { rule: 'throw-when-taking', action: choice, reason: `Подкидываю ${cardToString(card)} — соперник всё равно забирает стол, пусть берёт больше.` };
      }
      if (endgame) {
        return { rule: 'throw-endgame', action: choice, reason: `Подкидываю ${cardToString(card)} — колода пуста, сейчас главное избавляться от карт.` };
      }
      return {
        rule: `throw-${rankingRule}`,
        action: choice,
        reason: pressurePick
          ? `Подкидываю ${cardToString(card)} — выбираю по оценке давления с учётом цены карты.`
          : this.profile.dumpPairs
            ? `Подкидываю ${cardToString(card)} — выбираю по цене карты с учётом разгрузки пар.`
            : isHigh
              ? `Подкидываю ${cardToString(card)} — держать крупную карту про запас невыгодно, лучше разгрузить руку сейчас.`
              : `Подкидываю ${cardToString(card)} — недорогая карта, её не жалко.`,
      };
    }

    return {
      rule: isTrump ? 'hold-trump' : 'hold-high-card',
      action: pass,
      reason: isTrump
        ? 'Пропускаю: выбранный подкид — козырь, а его лучше приберечь.'
        : 'Пропускаю: выбранный подкид — крупная карта, пока её отдавать рано.',
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
        return { rule: 'transfer-unbeatable-table', action: cheapTransfer, reason: `Перевожу ${list(cheapTransfer.cards)} — весь стол мне не отбить, пусть отбивается следующий.` };
      }
      return { rule: 'take-unbeatable-table', action: take, reason: 'Беру карты: весь стол мне всё равно не отбить, нет смысла тратить карты впустую.' };
    }

    if (defends.length === 0) {
      if (cheapTransfer) {
        return { rule: 'transfer-no-defense', action: cheapTransfer, reason: `Перевожу ${list(cheapTransfer.cards)} — отбиться нечем, зато ход уходит дальше.` };
      }
      if (transfer) {
        return { rule: 'transfer-no-defense', action: transfer, reason: `Перевожу ${list(transfer.cards)} — отбиться нечем.` };
      }
      return { rule: 'take-no-defense', action: take, reason: 'Беру карты: отбиться нечем.' };
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
      return { rule: 'transfer-save-trump', action: cheapTransfer, reason: `Перевожу ${list(cheapTransfer.cards)} — иначе пришлось бы тратить козырь.` };
    }

    // 3б. Некозырной перевод не дороже полной защиты (issue #61).
    if (this.profile.preferTransferWhenCheap && cheapTransfer && table.length > 0
        && undefended.length === table.length) {
      const transferCost = cheapTransfer.cards.reduce((s, c) => s + cardPower(c, trumpSuit), 0);
      const defendCost = plan.canDefendAll
        ? plan.assignment.reduce((s, x) => s + cardPower(x.card, trumpSuit), 0)
        : Infinity;
      if (transferCost <= defendCost) {
        return {
          rule: 'transfer-cheap',
          action: cheapTransfer,
          reason: `Перевожу ${list(cheapTransfer.cards)} — отбиваться не дешевле, а так стол целиком уходит дальше и защищаться буду не я.`,
        };
      }
    }

    // 3.5. Сравнение ожидаемых цен взятия и защиты (issue #49), только при живом прикупе.
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
        const costTake = tableCost + extra * avgCard;
        // Цена успешной защиты — переплата за отбой; при неудаче забираем и свои карты.
        const overpay = plan.canDefendAll
          ? plan.assignment.reduce(
            (s, x) => s + Math.max(0, cardPower(x.card, trumpSuit) - cardPower(x.attack, trumpSuit)),
            0,
          )
          : Infinity;
        const costDefend = overpay + (1 - pSurv) * (costTake + overpay);
        if (costTake < costDefend) {
          if (cheapTransfer) {
            return {
              rule: 'transfer-probabilistic',
              action: cheapTransfer,
              reason: `Перевожу ${list(cheapTransfer.cards)} — отбиться до конца я вряд ли успею, а так стол уйдёт дальше.`,
            };
          }
          const voids = voidSuitsOf(this.tracker, attackerId);
          const why = voids.length
            ? 'подкидывать ему есть чем, а я на этом потеряю больше, чем заберу'
            : 'мне ещё подкинут, и защита обойдётся дороже, чем взятые карты';
          return { rule: 'take-probabilistic', action: take, reason: `Беру карты: ${why}.` };
        }
      } catch {
        // Оценки — вспомогательный слой: если что-то пошло не так, решают обычные правила.
      }
    }

    // 5. Дешёвая эвристика эндшпиля, НЕ полный поиск партии.
    if (this.profile.exactEndgame && endgame) {
      const known = this._opponentKnownHand(attackerId);
      if (plan.canDefendAll) {
        return {
          rule: 'defend-endgame-table',
          action: best,
          reason: known
            ? `Бью ${cardToString(target)} картой ${cardToString(best.card)} — колода пуста, рука соперника известна, текущий стол можно отбить.`
            : `Бью ${cardToString(target)} картой ${cardToString(best.card)} — колода пуста, предпочитаю отбиваться, а не увеличивать руку.`,
        };
      }
      if (take) {
        return { rule: 'take-endgame-table', action: take, reason: 'Беру карты: колода пуста, а отбить весь стол уже не получится.' };
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
        rule: 'take-save-big-trump',
        action: take,
        reason: `Беру карты: отбиться можно было бы только крупным козырем, а он дороже, чем ${cardToString(target)}.`,
      };
    }

    // Сохраняем единственную старшую в масти при живом прикупе.
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
          rule: 'take-save-suit-control',
          action: take,
          reason: `Беру карты: единственная старшая карта масти ${best.card.suit} пригодится мне позже больше, чем сейчас.`,
        };
      }
    }

    return {
      rule: 'defend-cheapest',
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
