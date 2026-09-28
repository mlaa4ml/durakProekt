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

import { searchRound, DEFAULT_ROUND_OPTIONS } from './roundSearch.js';
import { DEFAULT_RULES } from '../rules.js';
import { CardTracker } from './memory.js';
import { canSolve, solveFromState, sameEndgameAction, DEFAULT_SOLVER_OPTIONS } from './endgame.js';
import { beats, unbeatableCards } from './analysis.js';
import { myHandOf } from './policyContext.js';
import { decideAttackPolicy } from './attackPolicy.js';
import { decideDefensePolicy } from './defensePolicy.js';
import { analysisText, decisionReason, solverReason } from './explanations.js';
import { SMART_PROFILE, SMART_PROFILES, pickProfile, pickProfileName } from './profiles.js';
export { SMART_PROFILE, SMART_PROFILES, pickProfile, pickProfileName };

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
    this.roundOptions = { ...DEFAULT_ROUND_OPTIONS, ...(options.roundSearch || {}) };
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
    return this._memoDecision(`known:${oppId}`, () => {
      if (!this.tracker || !oppId) return null;
      try {
        if (!this.tracker.isOpponentHandCertain(oppId)) return null;
        return this.tracker.toCards(this.tracker.opponentKnownCards(oppId));
      } catch {
        return null;
      }
    });
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
      // All calls in a decision use the same own hand, trump and tracker.
      // This also avoids rebuilding outsideCards for every attack candidate.
      return this._memoDecision('unbeatable', () =>
        unbeatableCards(hand, trumpSuit, this.tracker)).some(
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
    return analysisText.call(this, state, hand, trumpSuit, oppId);
  }

  // ------------------------------------------------------------------
  //  Точка входа
  // ------------------------------------------------------------------

  decide(state, playerId, legalActions) {
    // The cache belongs to this synchronous decision only, including explanations.
    // Never retain inferred hands across observe/reset or after a failed decision.
    this._decisionCache = new Map();
    try {
      return this._decide(state, playerId, legalActions);
    } finally {
      this._decisionCache = null;
    }
  }

  _memoDecision(key, compute) {
    const cache = this._decisionCache;
    if (!cache) return compute();
    if (!cache.has(key)) cache.set(key, compute());
    return cache.get(key);
  }

  _decide(state, playerId, legalActions) {
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
    return decisionReason.call(this, picked, trace);
  }

  _choose(state, playerId, legalActions) {
    // Концовка дуэли с известной рукой соперника — точный счёт вместо эвристик.
    const exact = this._tryExactSolver(state, playerId, legalActions);
    if (exact) return exact;

    // Keep the old policy intact unless the experimental flag is enabled AND
    // the full solver exhausted its budget. Completed solver results come first.
    if (this.profile.safeRoundAttack) {
      const status = this._decisionTrace?.solver.status;
      const local = status === 'budget'
        ? searchRound(state, this.tracker, playerId, legalActions, this.roundOptions)
        : { status: status === 'unknown-hand' ? 'unknown-hand' : 'not-attempted',
            scope: 'current-round', complete: false, nodes: 0, ms: 0, action: null };
      if (this._decisionTrace) this._decisionTrace.roundSearch = local;
      if (local.action) {
        const certificate = local.candidates.find((c) => sameEndgameAction(c.action, local.action));
        return {
          action: local.action, rule: 'safe-round-attack',
          reason: certificate?.forcedTake
            ? 'Просмотр текущего раунда доказывает вынужденное взятие; это не доказательство победы в партии.'
            : 'Выбираю по ограниченному просмотру текущего раунда с учётом перевода и паса; исход партии не доказан.',
        };
      }
    }

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
    return solverReason.call(this, action, value);
  }

  // ------------------------------------------------------------------
  //  Ход и подкидывание
  // ------------------------------------------------------------------

  _decideAttack(state, playerId, legalActions) {
    return decideAttackPolicy.call(this, state, playerId, legalActions);
  }

  // ------------------------------------------------------------------
  //  Защита: отбиться / перевести / взять
  // ------------------------------------------------------------------

  _decideDefense(state, playerId, legalActions, { defends, transfers, take }) {
    return decideDefensePolicy.call(this, state, playerId, legalActions, { defends, transfers, take });
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
