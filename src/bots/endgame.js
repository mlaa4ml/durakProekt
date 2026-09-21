// Точный решатель концовки (SMART_BOT_ROADMAP.md, этап 3, issue #48).
//
// Когда прикуп пуст, живых игроков двое и рука соперника восстановлена ТОЧНО
// (`CardTracker.isOpponentHandCertain`), партия — игра с полной информацией. Тогда «дурак»
// определяется не эвристикой, а перебором: какой ход ведёт к тому, что соперник останется
// с картами, а я — без. Это самый большой нетронутый резерв силы бота в дуэли.
//
// Как устроено:
//   * Правила НЕ дублируются. Каждый узел перебора — это сам `DurakGame` (тихая копия позиции,
//     см. `DurakGame.fromPosition` / `clone` / `applyLegalAction`), а ходы берутся из его
//     `getLegalActions`. Что можно подкинуть, разрешён ли перевод, лимит стола, кто вышел
//     из игры — решает движок, поэтому решатель не может разойтись с ним.
//   * Оценка — «глазами того, кто ходит в корне»: победа (соперник остался дураком), ничья
//     (обе руки опустели одновременно), поражение (дураком остался я). Считается только исход,
//     без «быстрее/медленнее»: так отсечений намного больше, а зацикливания нет — повтор
//     позиции на ветке считается ничьей, значит, выигрывающая стратегия не ходит по кругу.
//   * Перебор — alpha-beta с таблицей позиций (руки + стол + чей ход + счётчики лимита стола).
//     В корне два прохода узким окном: сначала «есть ли выигрыш?», и только если нет — «есть ли
//     ничья?». Результаты, зависящие от пути (повтор позиции выше по ветке), в таблицу не кладём.
//   * Бюджет узлов и времени обязателен (`maxNodes`, `maxMs`). Когда он кончился, решатель
//     возвращает `timedOut: true` без действия, а вызывающий откатывается на эвристику.
//     Решатель НИКОГДА не бросает исключений наружу и не подвешивает партию.
//
// Модуль чистый: ни трекера, ни состояния бота — на входе позиция (простые данные).
// Связку «состояние + трекер → позиция» делают `canSolve` и `positionFromState`.

import { SUITS } from '../deck.js';
import { DurakGame } from '../game.js';
import { cardPower } from './analysis.js';

/**
 * Бюджет по умолчанию — для живой игры: до 2 секунд на ход. Узлов при этом ≈ 400 000
 * (порядка 4–5 мкс на узел); что тяжелее — откат на эвристику. Для массовых прогонов
 * (`scripts/evalBots.js --solver-nodes= --solver-ms=`) бюджет уменьшают, чтобы прогон был быстрым:
 * всё, что решено при малом бюджете, при большом решается так же, а решённых — только больше.
 */
export const DEFAULT_SOLVER_OPTIONS = Object.freeze({ maxNodes: 400000, maxMs: 2000 });

// Оценка позиции глазами того, кто ходит в корне: 1 — победа, 0 — ничья, -1 — поражение.
// Считаем только исход, без «быстрее/медленнее»: так alpha-beta отсекает намного больше
// (достаточно найти ЛЮБОЙ выигрывающий ход), а зацикливания при этом нет — повтор позиции
// на ветке считается ничьей, значит, выигрывающая стратегия не ходит по кругу.
const SCORE_INF = 2;
const EXACT = 0;
const LOWER = 1;
const UPPER = 2;

const SUIT_INDEX = new Map(SUITS.map((s, i) => [s, i]));
const cardCode = (c) => SUIT_INDEX.get(c.suit) * 16 + c.rank;
const byNumber = (a, b) => a - b;

const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Одно и то же действие? (карты сравниваются по масти и рангу, переводы — как множества). */
export function sameEndgameAction(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const eq = (x, y) => x.suit === y.suit && x.rank === y.rank;
  if (a.type === 'attack' || a.type === 'defend') return eq(a.card, b.card);
  if (a.type === 'transfer') {
    if (a.cards.length !== b.cards.length) return false;
    const rest = b.cards.slice();
    for (const c of a.cards) {
      const i = rest.findIndex((x) => eq(x, c));
      if (i === -1) return false;
      rest.splice(i, 1);
    }
    return true;
  }
  return true; // pass / take
}

// Порядок перебора влияет только на скорость (и на то, какой из равных ходов будет назван
// лучшим): дешёвое — раньше, «взять» и «пас» — позже.
function moveWeight(a, trumpSuit) {
  switch (a.type) {
    case 'attack':
    case 'defend': return cardPower(a.card, trumpSuit);
    case 'transfer': return 200 + cardPower(a.cards[0], trumpSuit);
    case 'pass': return 300;
    default: return 400;
  }
}

function orderMoves(actions, trumpSuit) {
  return actions
    .map((a) => ({ a, w: moveWeight(a, trumpSuit) }))
    .sort((x, y) => x.w - y.w)
    .map((x) => x.a);
}

/**
 * Ключ позиции для таблицы: всё, от чего зависит дальнейшая игра, и ничего лишнего.
 *  - порядок карт в руке не важен;
 *  - на столе отбитые пары — просто набор (порядок не важен), а неотбитые атаки — очередь:
 *    отбивается самая ранняя;
 *  - счётчики лимита стола нужны по отдельности, только пока возможен перевод (он пересчитывает
 *    «руку защитника на начало раунда»); иначе для будущего важно лишь, сколько ещё можно
 *    положить, — так позиции, пришедшие разными путями, склеиваются.
 */
function positionKey(g) {
  const [p0, p1] = g.players;
  const hand = (p) => p.hand.map(cardCode).sort(byNumber).join(',');
  const defended = [];
  const open = [];
  for (const t of g.table) {
    if (t.defense) defended.push(cardCode(t.attack) * 256 + cardCode(t.defense));
    else open.push(cardCode(t.attack));
  }
  defended.sort(byNumber);
  const rules = g.rules;
  const transferPossibleLater = rules.allowPerevod && !g.tookCards
    && !(rules.perevodOnlyOnFirstCard && defended.length > 0);
  const counters = transferPossibleLater
    ? `${g.attackCountThisRound}.${g._defenderHandAtStart}`
    : `r${g._attackRoomLeft()}`;
  return (
    `${g.phase === 'defender-to-act' ? 'd' : 'a'}${g.attackerIndex}` +
    `${g.tookCards ? 1 : 0}${g.allowAnyCardNow ? 1 : 0}` +
    `|${counters}|${hand(p0)}|${hand(p1)}|${defended.join(',')}|${open.join(',')}`
  );
}

/**
 * Решает позицию.
 *
 * @param {object} position  см. `DurakGame.fromPosition`; ходит тот, чей ход в позиции
 * @param {object} [options] { maxNodes = 400000, maxMs = 2000, table?: Map }
 * @returns {{
 *   win: boolean,        // ходящий выигрывает при правильной игре обеих сторон
 *   value: 1|0|-1,       // 1 победа, 0 ничья, -1 поражение (win === (value === 1))
 *   action: object|null, // лучшее действие из getLegalActions ходящего (null, если не решено)
 *   bestActions: object[], // действия с лучшим исходом (сейчас — одно, первое найденное)
 *   depth: number,       // глубина перебора: самая длинная просмотренная цепочка полуходов
 *   nodes: number,       // сколько позиций просмотрено
 *   ms: number,          // сколько времени ушло
 *   timedOut: boolean,   // бюджет кончился — результату верить нельзя, action === null
 *   solved: boolean,     // перебор завершён и результат достоверен
 *   player: string|null, // кто ходит в корне
 *   legal: object[],     // легальные действия ходящего в корне (для сверки с движком)
 * }}
 */
export function solveEndgame(position, options = {}) {
  const maxNodes = Number.isFinite(options.maxNodes) ? options.maxNodes : DEFAULT_SOLVER_OPTIONS.maxNodes;
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : DEFAULT_SOLVER_OPTIONS.maxMs;
  const startedAt = nowMs();

  let nodes = 0;
  let maxDepth = 0;
  let aborted = false;
  let cycleTarget = Infinity; // на какой глубине пути лежит самая «верхняя» позиция, повторённая в поддереве
  // Таблицу можно передать снаружи и переиспользовать между вызовами: ключ позиции описывает
  // её полностью, поэтому найденное для одной позиции верно и в следующем ходе той же партии
  // (и в другой партии с теми же правилами и козырем — вызывающий сам следит за этим).
  const table = options.table instanceof Map ? options.table : new Map();
  const path = new Map(); // ключ позиции на текущей ветке → её глубина

  const result = (over) => ({
    win: false, value: 0, action: null, bestActions: [], depth: maxDepth,
    nodes, ms: nowMs() - startedAt, timedOut: aborted, solved: false, player: null, legal: [],
    ...over,
  });

  try {
    const root = DurakGame.fromPosition(position);
    const me = root.currentActorId();
    if (me === null) return result({});
    const opponent = root.players.find((p) => p.id !== me).id;
    const trumpSuit = root.trumpSuit;

    const terminalScore = (g) => (g.durak === opponent ? 1 : g.durak === me ? -1 : 0);

    // Возвращает оценку позиции для `me` (в окне alpha-beta) или undefined, если бюджет кончился.
    function search(g, alpha, beta, ply) {
      nodes++;
      if (ply > maxDepth) maxDepth = ply;
      if (nodes > maxNodes || ((nodes & 31) === 0 && nowMs() - startedAt > maxMs)) {
        aborted = true;
        return undefined;
      }
      if (g.phase === 'finished') return terminalScore(g);

      const key = positionKey(g);
      const hit = table.get(key);
      const alphaOrig = alpha;
      if (hit) {
        if (hit.flag === EXACT) return hit.score;
        if (hit.flag === LOWER) alpha = Math.max(alpha, hit.score);
        else beta = Math.min(beta, hit.score);
        if (alpha >= beta) return hit.score;
      }
      const seenAt = path.get(key);
      if (seenAt !== undefined) { // повтор позиции на этой ветке — ничья
        if (seenAt < cycleTarget) cycleTarget = seenAt;
        return 0;
      }
      path.set(key, ply);
      const outerTarget = cycleTarget;
      cycleTarget = Infinity;

      const actor = g.currentActorId();
      const legal = actor === null ? [] : g.getLegalActions(actor);
      let best;
      if (legal.length === 0) {
        best = 0; // в живой партии такого не бывает; безопасно считаем ничьёй
      } else {
        const maximizing = actor === me;
        best = maximizing ? -SCORE_INF : SCORE_INF;
        let a = alpha;
        let b = beta;
        for (const move of orderMoves(legal, trumpSuit)) {
          const child = g.clone();
          child.applyLegalAction(actor, move);
          const s = search(child, a, b, ply + 1);
          if (s === undefined) { path.delete(key); return undefined; }
          if (maximizing) {
            if (s > best) best = s;
            if (best > a) a = best;
          } else {
            if (s < best) best = s;
            if (best < b) b = best;
          }
          if (a >= b) break;
        }
      }
      path.delete(key);

      // Результат можно запомнить, если он не зависит от того, КАК мы сюда пришли: повторы
      // позиций внутри поддерева (в том числе самой этой позиции) — не в счёт, а повтор позиции
      // выше по ветке делает оценку зависимой от ветки, и такую в таблицу не кладём.
      if (cycleTarget >= ply) {
        const flag = best <= alphaOrig ? UPPER : best >= beta ? LOWER : EXACT;
        table.set(key, { score: best, flag });
      }
      cycleTarget = Math.min(outerTarget, cycleTarget);
      return best;
    }

    // Корень: перебираем ходы сами, чтобы знать, КАКОЙ ход лучший. Два прохода узким окном
    // вместо одного полного: сначала «есть ли выигрыш?» (ничья и поражение для этого одно и то
    // же — отсечений намного больше), и только если выигрыша нет — «есть ли ничья?».
    const legal = root.getLegalActions(me);
    if (legal.length === 0) return result({ player: me });
    const ordered = orderMoves(legal, trumpSuit);

    const probe = (move, alpha, beta) => {
      const child = root.clone();
      child.applyLegalAction(me, move);
      return search(child, alpha, beta, 1);
    };

    let value = -1;
    let action = ordered[0];
    let found = false;
    for (const move of ordered) {
      const s = probe(move, 0, 1);
      if (s === undefined) return result({ player: me, legal, timedOut: true });
      if (s >= 1) { value = 1; action = move; found = true; break; }
    }
    if (!found) {
      for (const move of ordered) {
        const s = probe(move, -1, 0);
        if (s === undefined) return result({ player: me, legal, timedOut: true });
        if (s >= 0) { value = 0; action = move; break; }
      }
    }

    return result({
      win: value === 1,
      value,
      action,
      bestActions: [action],
      timedOut: false,
      solved: true,
      player: me,
      legal,
    });
  } catch {
    // Решатель — вспомогательный слой: что бы ни случилось, наружу уходит «не решено».
    return result({ failed: true });
  }
}

// ---------------------------------------------------------------------------
// Связка с состоянием партии и трекером
// ---------------------------------------------------------------------------

/**
 * Применим ли решатель прямо сейчас.
 * Только когда: прикуп пуст, живых игроков двое (сначала дуэль), правила партии переданы
 * (`state.rules`), и рука соперника восстановлена ТОЧНО — не догадками, а полностью.
 */
export function canSolve(state, tracker, meId) {
  try {
    if (!state || !tracker || !meId) return false;
    if (state.talonCount !== 0) return false;
    if (state.phase !== 'need-attack' && state.phase !== 'defender-to-act') return false;
    const rules = state.rules;
    if (!rules || typeof rules !== 'object') return false;
    if (!Number.isInteger(state.maxAttacksNow)) return false;

    const alive = (state.players || []).filter((p) => !p.out);
    if (alive.length !== 2) return false;
    const me = alive.find((p) => p.id === meId);
    const opp = alive.find((p) => p.id !== meId);
    if (!me || !opp || !Array.isArray(me.hand)) return false;
    if (![state.attacker, state.defender].includes(me.id) || ![state.attacker, state.defender].includes(opp.id)) return false;
    if (state.attacker === state.defender) return false;

    if (!tracker.isOpponentHandCertain(opp.id)) return false;
    // «Certain» обязано означать: вся рука соперника названа поимённо.
    if (tracker.opponentKnownCards(opp.id).size !== opp.handCount) return false;

    // Счётчики лимита стола выводятся из публичных данных точно, кроме одного редкого варианта:
    // перевод после частичной защиты при лимите «по руке защитника» — там размер руки на начало
    // раунда неизвестен. В нём решатель не включаем: лучше эвристика, чем неверный лимит.
    const defendedPairs = (state.table || []).filter((t) => t.defense).length;
    if (defendedPairs > 0 && rules.allowPerevod && !rules.perevodOnlyOnFirstCard && rules.attackLimitByDefenderHand) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Позиция для решателя из публичного состояния и известной руки соперника.
 * Счётчики лимита стола (`attackCountThisRound`, `defenderHandAtStart`) восстанавливаются
 * так, чтобы `maxAttacksNow` движка совпал с тем, что отдало `getState()`.
 */
export function positionFromState(state, meId, opponentHand) {
  const alive = state.players.filter((p) => !p.out);
  const copyCards = (cards) => cards.map((c) => ({ suit: c.suit, rank: c.rank }));
  const handOf = (p) => copyCards(p.id === meId ? p.hand : opponentHand);
  const rules = state.rules;

  const table = state.table.map((t) => ({ attack: t.attack, defense: t.defense || null }));
  const defender = alive.find((p) => p.id === state.defender);
  const defendedPairs = table.filter((t) => t.defense).length;
  // Защитник тратил на защиту карты из руки, поэтому в начале раунда у него было на столько больше.
  const defenderHandAtStart = defender.handCount + defendedPairs;
  const limit = Math.min(rules.maxTableAttacks, rules.attackLimitByDefenderHand ? defenderHandAtStart : Infinity);

  return {
    rules,
    trumpSuit: state.trumpSuit,
    trumpCard: state.trumpCard || null,
    players: alive.map((p) => ({ id: p.id, hand: handOf(p) })),
    attacker: state.attacker,
    defender: state.defender,
    phase: state.phase,
    table,
    tookCards: state.tableGoingToDefender === true,
    allowAnyCardNow: state.allowedThrowInRanks === null,
    defenderHandAtStart,
    attackCountThisRound: Math.max(limit - state.maxAttacksNow, 0),
    discardCount: state.discardCount || 0,
  };
}

/**
 * Всё вместе: проверяет `canSolve`, собирает позицию из состояния и известной руки соперника,
 * решает. Возвращает результат `solveEndgame` либо `null`, если решатель неприменим.
 * Дополнительно сверяет корень с движком: `maxAttacksNow` копии должен совпасть с состоянием,
 * иначе позиция восстановлена неверно и результату верить нельзя (`solved: false`).
 */
export function solveFromState(state, tracker, meId, options = {}) {
  if (!canSolve(state, tracker, meId)) return null;
  try {
    const opp = state.players.find((p) => !p.out && p.id !== meId);
    const oppHand = tracker.toCards(tracker.opponentKnownCards(opp.id));
    const position = positionFromState(state, meId, oppHand);
    const probe = DurakGame.fromPosition(position);
    if (probe.getState().maxAttacksNow !== state.maxAttacksNow) {
      return { win: false, value: 0, action: null, depth: 0, nodes: 0, ms: 0, timedOut: false, solved: false, player: meId, legal: [], mismatch: true };
    }
    return solveEndgame(position, options);
  } catch {
    return { win: false, value: 0, action: null, depth: 0, nodes: 0, ms: 0, timedOut: false, solved: false, player: meId, legal: [], failed: true };
  }
}
