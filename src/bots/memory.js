// Память умного бота: CardTracker.
//
// Этап 2 плана умного бота (issue #32, спецификация — раздел 4 SMART_BOT_PLAN.md).
// Трекер НИ НА ЧТО не влияет: он только наблюдает за последовательностью
// МАСКИРОВАННЫХ состояний `game.getState(meId)` и восстанавливает по ним картину мира.
//
// Главный принцип файла — честность:
//   * ТОЧНЫЕ факты (`discard`, `onTable`, `takenBy`, своя рука) записываются, только если
//     они следуют из наблюдений однозначно. Инвариант: каждое множество точных фактов —
//     подмножество реального положения дел, поэтому «пул неизвестного» (`unknownCards()`)
//     ВСЕГДА надмножество любой скрытой руки. Отсюда и работает эндшпиль в дуэли:
//     если пул совпал по размеру с рукой соперника — он равен ей в точности.
//   * ПРЕДПОЛОЖЕНИЯ (`voidSuits`, `assumedNoRanks`) лежат отдельно и никогда не вычитаются
//     из точных множеств. Их можно использовать для эвристик, но не для «я знаю».
//   * Когда наблюдений не хватает (пропущенные между ходами события, противоречия),
//     трекер говорит честное «не знаю»: сбрасывает спорный факт в неизвестность,
//     а не додумывает.
//
// Движок (`src/game.js`) и простой бот (`src/bots/simpleBot.js`) этим файлом не затрагиваются.

import { createDeck, SUITS, cardToString } from '../deck.js';

/** Ключ карты: `${rank}${suit}` (ранг — число, масть — не цифра, поэтому ключ однозначен). */
export function cardKey(card) {
  return `${card.rank}${card.suit}`;
}

function getSet(map, key) {
  if (!map.has(key)) map.set(key, new Set());
  return map.get(key);
}

export class CardTracker {
  /**
   * @param {number} deckSize   24 | 36 | 52
   * @param {string} trumpSuit  масть козыря
   * @param {object} trumpCard  карта под колодой {rank, suit} (уйдёт последнему добирающему)
   * @param {string} meId       чьими глазами смотрим
   * @param {string[]} playerIds  все игроки за столом (в порядке посадки)
   */
  constructor(deckSize = 24, trumpSuit = null, trumpCard = null, meId = null, playerIds = []) {
    this.deckSize = deckSize;
    this.trumpCard = trumpCard ? { rank: trumpCard.rank, suit: trumpCard.suit } : null;
    this.trumpSuit = trumpSuit || (this.trumpCard ? this.trumpCard.suit : null);
    this.meId = meId;
    this.playerIds = [...playerIds];

    this._byKey = new Map();
    for (const c of createDeck(deckSize)) this._byKey.set(cardKey(c), { rank: c.rank, suit: c.suit });

    // ---- точные факты ----
    this.all = new Set(this._byKey.keys());   // вся колода
    this.discard = new Set();                 // ушли в бито
    this.onTable = new Set();                 // лежат на столе прямо сейчас
    this.myHand = new Set();                  // моя рука (её я вижу целиком)
    this.takenBy = new Map();                 // playerId -> Set<cardKey>, точно в руке игрока
    this.seenPlayed = new Map();              // playerId -> Set<cardKey>, история выкладывания (best-effort)

    // ---- предположения (НЕ факты) ----
    this.voidSuits = new Map();               // playerId -> Set<suit>: «скорее всего, масти нет»
    this.assumedNoRanks = new Map();          // playerId -> Set<rank>: «спасовал → скорее всего нет ранга»

    // ---- служебное ----
    this.talonCount = null;
    this.discardCount = 0;
    this.unseenDiscardCount = 0;   // сколько карт ушло в бито «мимо глаз» (состав неизвестен)
    this.handCounts = new Map();   // playerId -> handCount из последнего state
    this.outPlayers = new Set();
    this.conflicts = 0;            // сколько раз наблюдение опровергло записанный факт (self-healing)
    this.observations = 0;
    this.prev = null;              // снимок предыдущего state

    for (const id of this.playerIds) this._ensurePlayer(id);
  }

  /** Удобный конструктор «из первого состояния». Сразу же выполняет observe(state). */
  static fromState(state, meId, deckSizeHint = null) {
    const ids = (state.players || []).map((p) => p.id);
    // Размер колоды: явная подсказка → правила из состояния (движок отдаёт state.rules) →
    // угадывание по картам. Последнее нужно для старых состояний и рукописных в тестах.
    const ruleDeckSize = state && state.rules ? state.rules.deckSize : null;
    const deckSize = deckSizeHint
      || ([24, 36, 52].includes(ruleDeckSize) ? ruleDeckSize : null)
      || CardTracker.guessDeckSize(state);
    const t = new CardTracker(deckSize, state.trumpSuit, state.trumpCard, meId, ids);
    t.observe(state);
    return t;
  }

  /**
   * Размер колоды по состоянию: карты в руках + стол + бито + прикуп.
   * Если сумма не совпала ни с одной поддерживаемой колодой — берём ближайшую сверху.
   */
  static guessDeckSize(state) {
    const inHands = (state.players || []).reduce((s, p) => s + (p.handCount || 0), 0);
    const onTable = (state.table || []).reduce((s, t) => s + 1 + (t.defense ? 1 : 0), 0);
    const total = inHands + onTable + (state.discardCount || 0) + (state.talonCount || 0);
    for (const size of [24, 36, 52]) if (total === size) return size;
    for (const size of [24, 36, 52]) if (total <= size) return size;
    return 52;
  }

  _ensurePlayer(id) {
    if (id === undefined || id === null) return;
    if (!this.playerIds.includes(id)) this.playerIds.push(id);
    getSet(this.takenBy, id);
    getSet(this.seenPlayed, id);
    getSet(this.voidSuits, id);
    getSet(this.assumedNoRanks, id);
  }

  /** Полный сброс памяти (новая партия). Если передан state — сразу наблюдаем его. */
  reset(state = null, meId = null) {
    if (meId) this.meId = meId;
    this.discard.clear();
    this.onTable.clear();
    this.myHand.clear();
    for (const s of this.takenBy.values()) s.clear();
    for (const s of this.seenPlayed.values()) s.clear();
    for (const s of this.voidSuits.values()) s.clear();
    for (const s of this.assumedNoRanks.values()) s.clear();
    this.talonCount = null;
    this.discardCount = 0;
    this.unseenDiscardCount = 0;
    this.handCounts.clear();
    this.outPlayers.clear();
    this.conflicts = 0;
    this.observations = 0;
    this.prev = null;
    if (state) this.observe(state);
    return this;
  }

  // ------------------------------------------------------------------
  //  Наблюдение
  // ------------------------------------------------------------------

  _snapshot(state) {
    const pairs = (state.table || []).map((t) => ({
      attackKey: t.attack ? cardKey(t.attack) : null,
      defenseKey: t.defense ? cardKey(t.defense) : null,
      attack: t.attack || null,
      defense: t.defense || null,
    }));
    const tableKeys = new Set();
    for (const p of pairs) {
      if (p.attackKey) tableKeys.add(p.attackKey);
      if (p.defenseKey) tableKeys.add(p.defenseKey);
    }
    const handCounts = new Map();
    const out = new Set();
    const order = [];
    for (const p of state.players || []) {
      order.push(p.id);
      handCounts.set(p.id, p.handCount || 0);
      if (p.out) out.add(p.id);
    }
    return {
      phase: state.phase,
      talonCount: state.talonCount || 0,
      discardCount: state.discardCount || 0,
      tableGoingToDefender: state.tableGoingToDefender === true,
      attacker: state.attacker,
      defender: state.defender,
      pairs,
      tableKeys,
      handCounts,
      out,
      order,
      finished: state.finished === true,
    };
  }

  _myHandFrom(state) {
    const me = (state.players || []).find((p) => p.id === this.meId);
    if (!me || !Array.isArray(me.hand)) return null;
    return new Set(me.hand.map(cardKey));
  }

  /** Карта точно находится на столе/в бито/у меня → убираем её из чужих «точных» множеств. */
  _dropFromEveryone(key, exceptId = null) {
    for (const [id, set] of this.takenBy) {
      if (id === exceptId) continue;
      if (set.delete(key)) this.conflicts++;
    }
  }

  /**
   * Главный метод: сравнить свежее состояние с предыдущим снимком и обновить память.
   * Вызывается перед каждым решением бота. Повторный вызов с тем же состоянием безопасен.
   */
  observe(state) {
    if (!state || !Array.isArray(state.players)) return this;

    for (const p of state.players) this._ensurePlayer(p.id);
    if (!this.trumpSuit && state.trumpSuit) this.trumpSuit = state.trumpSuit;
    if (!this.trumpCard && state.trumpCard) {
      this.trumpCard = { rank: state.trumpCard.rank, suit: state.trumpCard.suit };
    }

    const cur = this._snapshot(state);
    const prev = this.prev;
    const myHand = this._myHandFrom(state);

    // --- 0. моя рука: самый надёжный источник правды ---
    if (myHand) {
      this.myHand = myHand;
      for (const k of myHand) {
        if (this.discard.delete(k)) this.conflicts++;
        this._dropFromEveryone(k);
      }
    }

    if (!prev) {
      // Первое наблюдение: состав бито нам неизвестен, стол — известен.
      this.onTable = new Set(cur.tableKeys);
      for (const k of this.onTable) {
        if (this.discard.delete(k)) this.conflicts++;
        this._dropFromEveryone(k);
      }
      this.unseenDiscardCount = cur.discardCount;
      this._finishObserve(cur);
      return this;
    }

    const playedNow = new Map();   // id -> сколько карт игрок положил на стол (только уверенная атрибуция)
    const takenNow = new Map();    // id -> сколько карт игрок забрал со стола
    let allAttributed = true;

    // --- 1. стол закрылся: карты ушли в бито или к защитнику ---
    // Важно: между двумя моими наблюдениями я успеваю сделать СВОЙ ход, и карта,
    // которую я тогда положил (защита/атака/перевод), могла уйти со стола до того,
    // как я увидел следующее состояние. На столе я её не видел никогда, но точно знаю,
    // что она покинула мою руку → считаем её частью закрывшегося стола.
    const goneFromTable = [...prev.tableKeys].filter((k) => !cur.tableKeys.has(k));
    const myGone = [...(this.prevMyHand || [])].filter(
      (k) => !this.myHand.has(k) && !cur.tableKeys.has(k) && !prev.tableKeys.has(k)
    );
    const left = [...new Set([...goneFromTable, ...myGone])];
    if (left.length > 0) {
      const discardDelta = cur.discardCount - prev.discardCount;
      // Куда ушёл стол:
      //   discardDelta === 0            → бито не росло, значит всё забрал защитник;
      //   discardDelta === left.length  → ровно эти карты и ушли в отбой;
      //   иначе                          → между наблюдениями закрылось несколько столов
      //                                    (бывает при 3+ игроках) — честное «не знаю».
      let mode;
      if (discardDelta === 0) mode = 'defender';
      else if (!prev.tableGoingToDefender && discardDelta === left.length) mode = 'discard';
      else mode = 'unknown';

      if (mode === 'unknown') {
        for (const k of left) this.onTable.delete(k);
        this.unseenDiscardCount += discardDelta;
        // Ни одного нового «точного» факта: карты остаются в пуле неизвестного.
        for (const id of cur.order) this._forgetAssumptions(id);
      } else if (mode === 'defender') {
        const defId = prev.defender;
        this._ensurePlayer(defId);
        takenNow.set(defId, (takenNow.get(defId) || 0) + left.length);
        const takenSuits = new Set();
        for (const k of left) {
          this.onTable.delete(k);
          const card = this._byKey.get(k);
          if (card) takenSuits.add(card.suit);
          if (defId === this.meId) continue;            // свою руку я и так вижу
          if (this.myHand.has(k) || this.discard.has(k)) continue;
          this.takenBy.get(defId).add(k);
          this._dropFromEveryone(k, defId);
        }
        // Забрал карты → мастей из них у него точно уже нет смысла считать «отсутствующими».
        for (const s of takenSuits) this.voidSuits.get(defId)?.delete(s);
        // Предположение «нечем было бить»: на столе остались неотбитые атаки.
        this._assumeVoidsOnTake(prev, defId, cur.talonCount);
        // Ранги забранных карт у него теперь точно есть — снимаем предположение «спасовал».
        for (const k of left) {
          const card = this._byKey.get(k);
          if (card) this.assumedNoRanks.get(defId)?.delete(card.rank);
        }
      } else {
        for (const k of left) {
          this.onTable.delete(k);
          if (this.myHand.has(k)) { this.conflicts++; continue; }
          this.discard.add(k);
          this._dropFromEveryone(k);
        }
        this.unseenDiscardCount += Math.max(0, discardDelta - left.length);
      }
      // Заход завершился → те, кто мог подкидывать, не подкинули рангов со стола.
      this._assumePassedRanks(prev);
    }

    // --- 2. на столе появились новые карты ---
    const added = [...cur.tableKeys].filter((k) => !prev.tableKeys.has(k));
    for (const k of added) {
      this.onTable.add(k);
      if (this.discard.delete(k)) this.conflicts++;   // self-healing: карта не могла быть в бито
      const author = this._attributeAuthor(k, cur, prev);
      if (author) {
        this.seenPlayed.get(author).add(k);
        playedNow.set(author, (playedNow.get(author) || 0) + 1);
        const card = this._byKey.get(k);
        if (card) {
          // Он только что показал эту масть/ранг — предположения об их отсутствии неверны.
          this.voidSuits.get(author)?.delete(card.suit);
          this.assumedNoRanks.get(author)?.delete(card.rank);
        }
      } else {
        allAttributed = false;
      }
      this._dropFromEveryone(k);
      if (this.myHand.has(k)) this.myHand.delete(k);
    }

    // --- 3. добор из прикупа ---
    const talonDelta = prev.talonCount - cur.talonCount;
    if (talonDelta > 0) {
      this._handleDraws(prev, cur, playedNow, takenNow, allAttributed, talonDelta);
    }

    this._finishObserve(cur);
    return this;
  }

  /**
   * Кто положил карту на стол.
   * Возвращает id только когда автор определяется ОДНОЗНАЧНО, иначе null
   * («не знаю» вместо выдуманного факта).
   */
  _attributeAuthor(key, cur, prev) {
    // 1) карта была у кого-то в «точно известных» — значит, сыграл именно он.
    for (const [id, set] of this.takenBy) {
      if (set.has(key)) return id;
    }
    // 2) карта была в моей руке в прошлом снимке — сыграл я.
    if (this.prevMyHand && this.prevMyHand.has(key) && !this.myHand.has(key)) return this.meId;
    // 3) карта-защита: её кладёт защищающийся.
    const pair = cur.pairs.find((p) => p.defenseKey === key);
    if (pair) return cur.defender;
    // 4) карта-атака: автор однозначен, только если подкинуть мог ровно один игрок.
    const candidates = cur.order.filter((id) => id !== cur.defender && !cur.out.has(id));
    if (candidates.length === 1) return candidates[0];
    return null;
  }

  /**
   * Предположение «взял → нечем было бить»: для каждой НЕОТБИТОЙ атаки на столе
   * считаем, что масти у защитника нет. Про козырь такой вывод делаем только
   * в эндшпиле: пока идёт прикуп, козырь часто просто берегут (поправка из раздела 4.3).
   */
  _assumeVoidsOnTake(prev, defId, talonCount) {
    const voids = getSet(this.voidSuits, defId);
    const undefended = prev.pairs.filter((p) => !p.defenseKey && p.attack);
    if (undefended.length === 0) return;
    for (const p of undefended) {
      voids.add(p.attack.suit);
      // Некозырную карту можно было побить козырем — если он не хотел его тратить,
      // это ещё не значит, что козыря нет. Считаем «козырей нет» только без прикупа.
      if (talonCount === 0 && this.trumpSuit && p.attack.suit !== this.trumpSuit) {
        voids.add(this.trumpSuit);
      }
    }
    // Карты, которые он всё же отбил, доказывают наличие масти — снимаем ложные предположения.
    for (const p of prev.pairs) if (p.defense) voids.delete(p.defense.suit);
  }

  /**
   * Предположение «спасовал → нет карт таких рангов». Записываем только тому,
   * кто ТОЧНО имел право подкидывать при любых настройках throwInPolicy, — атакующему.
   */
  _assumePassedRanks(prev) {
    const id = prev.attacker;
    if (!id || id === prev.defender) return;
    if (prev.out.has(id)) return;
    if ((prev.handCounts.get(id) || 0) === 0) return;
    if (id === this.meId) return;
    const ranks = getSet(this.assumedNoRanks, id);
    for (const p of prev.pairs) {
      if (p.attack) ranks.add(p.attack.rank);
      if (p.defense) ranks.add(p.defense.rank);
    }
  }

  /**
   * Добор. Сам состав добранных карт неизвестен (это честное «не знаю» — карты
   * возвращаются/остаются в пуле неизвестного), но есть два следствия:
   *   * предположения о добравшем игроке обнуляются (у него появились новые карты);
   *   * если прикуп опустел, последняя выданная карта — это `trumpCard`, и её владелец
   *     известен, если порядок добора восстанавливается однозначно.
   */
  _handleDraws(prev, cur, playedNow, takenNow, allAttributed, talonDelta) {
    const draws = new Map();
    let sum = 0;
    let consistent = allAttributed;
    for (const id of cur.order) {
      const before = prev.handCounts.get(id) || 0;
      const after = cur.handCounts.get(id) || 0;
      const d = after - before + (playedNow.get(id) || 0) - (takenNow.get(id) || 0);
      if (d < 0) consistent = false;
      draws.set(id, d);
      sum += d;
    }
    if (sum !== talonDelta) consistent = false;

    if (consistent) {
      for (const [id, d] of draws) {
        if (d > 0) this._forgetAssumptions(id);
      }
    } else {
      // Не смогли разложить добор по игрокам — честно снимаем ВСЕ предположения
      // (точные факты при этом не трогаем: они остаются верными).
      for (const id of cur.order) this._forgetAssumptions(id);
    }

    if (cur.talonCount !== 0 || !this.trumpCard) return;
    const key = cardKey(this.trumpCard);
    if (this.myHand.has(key) || this.discard.has(key) || this.onTable.has(key)) return;
    for (const set of this.takenBy.values()) if (set.has(key)) return;
    if (!consistent) return;

    const last = this._lastDrawer(prev, draws);
    if (!last || last === this.meId) return;
    this.takenBy.get(last).add(key);
  }

  /**
   * Порядок добора в движке (`_refillHands`): атакующий и все подкидывавшие по кругу,
   * защищающийся — последним. Значит, козырь под колодой достаётся последнему в этом
   * порядке, кто реально добирал.
   */
  _lastDrawer(prev, draws) {
    const order = [];
    const n = prev.order.length;
    const attIdx = Math.max(0, prev.order.indexOf(prev.attacker));
    for (let i = 0; i < n; i++) {
      const id = prev.order[(attIdx + i) % n];
      if (id === prev.defender || prev.out.has(id)) continue;
      order.push(id);
    }
    if (prev.defender && !prev.out.has(prev.defender)) order.push(prev.defender);
    let last = null;
    for (const id of order) if ((draws.get(id) || 0) > 0) last = id;
    return last;
  }

  _forgetAssumptions(id) {
    this.voidSuits.get(id)?.clear();
    this.assumedNoRanks.get(id)?.clear();
  }

  /** Финальная сверка: снимаем противоречия и записываем снимок. */
  _finishObserve(cur) {
    this.talonCount = cur.talonCount;
    this.discardCount = cur.discardCount;
    this.handCounts = cur.handCounts;
    this.outPlayers = cur.out;

    for (const [id, set] of this.takenBy) {
      if (id === this.meId) { set.clear(); continue; }   // свою руку читаем напрямую
      for (const k of [...set]) {
        if (this.discard.has(k) || this.onTable.has(k) || this.myHand.has(k)) {
          set.delete(k);
          this.conflicts++;
        }
      }
      const hc = cur.handCounts.get(id);
      // Больше «известных» карт, чем карт в руке — где-то мы не увидели ход.
      // Честно забываем весь набор: пусть карты вернутся в пул неизвестного.
      if (hc !== undefined && set.size > hc) {
        set.clear();
        this.conflicts++;
      }
      if (hc === 0) set.clear();
    }

    this.prevMyHand = new Set(this.myHand);
    this.prev = cur;
    this.observations++;
  }

  // ------------------------------------------------------------------
  //  API (раздел 4.4 плана)
  // ------------------------------------------------------------------

  /** Карты, которые могут быть у соперников или в прикупе (надмножество любой скрытой руки). */
  unknownCards() {
    const res = new Set(this.all);
    for (const k of this.myHand) res.delete(k);
    for (const k of this.discard) res.delete(k);
    for (const k of this.onTable) res.delete(k);
    for (const set of this.takenBy.values()) for (const k of set) res.delete(k);
    return res;
  }

  /**
   * Карты-кандидаты в руке соперника: точно известные + весь пул неизвестного.
   * `useAssumptions: true` дополнительно отсеивает масти/ранги по предположениям
   * (только для эвристик — это уже НЕ «знаю»).
   */
  opponentPossibleCards(oppId, { useAssumptions = false } = {}) {
    if (oppId === this.meId) return new Set(this.myHand);
    const hc = this.handCounts.get(oppId);
    if (hc === 0 || this.outPlayers.has(oppId)) return new Set();
    const known = new Set(this.takenBy.get(oppId) || []);
    if (hc !== undefined && known.size >= hc) return known;
    const res = new Set(known);
    for (const k of this.unknownCards()) {
      if (useAssumptions && !known.has(k)) {
        const card = this._byKey.get(k);
        if (card && this.voidSuits.get(oppId)?.has(card.suit)) continue;
        if (card && this.assumedNoRanks.get(oppId)?.has(card.rank)) continue;
      }
      res.add(k);
    }
    return res;
  }

  /**
   * Карты, которые соперник ТОЧНО держит.
   * Обычно это то, что он забрал со стола и ещё не сыграл; в просчитанном эндшпиле —
   * вся его рука (пул неизвестного схлопнулся ровно до её размера).
   */
  opponentKnownCards(oppId) {
    if (oppId === this.meId) return new Set(this.myHand);
    const known = new Set(this.takenBy.get(oppId) || []);
    const hc = this.handCounts.get(oppId);
    if (hc === 0 || this.outPlayers.has(oppId)) return new Set();
    if (hc !== undefined && known.size === hc) return known;
    const possible = this.opponentPossibleCards(oppId);
    if (hc !== undefined && possible.size === hc) return possible;
    return known;
  }

  /** true, если рука соперника восстановлена полностью (без догадок). */
  isOpponentHandCertain(oppId) {
    if (oppId === this.meId) return true;
    const hc = this.handCounts.get(oppId);
    if (hc === undefined) return false;
    if (hc === 0 || this.outPlayers.has(oppId)) return true;
    const known = this.takenBy.get(oppId) || new Set();
    if (known.size === hc) return true;
    return this.opponentPossibleCards(oppId).size === hc;
  }

  /**
   * Грубая оценка вероятности того, что карта у соперника.
   * Поддерживает две формы вызова:
   *   probabilityOpponentHas(oppId, card) — для конкретного игрока;
   *   probabilityOpponentHas(card)        — «хоть у кого-то из соперников».
   */
  probabilityOpponentHas(a, b = undefined) {
    if (b === undefined) {
      const card = a;
      let p = 0;
      for (const id of this.playerIds) {
        if (id === this.meId) continue;
        p += this.probabilityOpponentHas(id, card);
      }
      return Math.min(1, p);
    }
    const oppId = a;
    const card = b;
    if (!card) return 0;
    const key = cardKey(card);
    if (!this.all.has(key)) return 0;
    if (oppId === this.meId) return this.myHand.has(key) ? 1 : 0;
    if (this.outPlayers.has(oppId)) return 0;
    const known = this.takenBy.get(oppId) || new Set();
    if (known.has(key)) return 1;
    if (this.myHand.has(key) || this.discard.has(key) || this.onTable.has(key)) return 0;
    for (const [id, set] of this.takenBy) if (id !== oppId && set.has(key)) return 0;
    const hc = this.handCounts.get(oppId) || 0;
    const rest = hc - known.size;
    if (rest <= 0) return 0;
    const pool = this.unknownCards();
    if (!pool.has(key) || pool.size === 0) return 0;
    return Math.min(1, rest / pool.size);
  }

  /**
   * Самая старшая карта масти, которая ещё может «выстрелить» против меня:
   * не в бито, не на столе и не у меня в руке.
   * @returns {{rank:number, suit:string}|null}
   */
  highestRemaining(suit, { includeMine = false, includeTable = false } = {}) {
    let best = null;
    for (const [key, card] of this._byKey) {
      if (card.suit !== suit) continue;
      if (this.discard.has(key)) continue;
      if (!includeTable && this.onTable.has(key)) continue;
      if (!includeMine && this.myHand.has(key)) continue;
      if (!best || card.rank > best.rank) best = card;
    }
    return best ? { ...best } : null;
  }

  /** Сколько козырей ещё не у меня и не в бито (раздел 4.4). */
  trumpsLeftOutside(myHand = null) {
    if (!this.trumpSuit) return 0;
    const mine = myHand
      ? new Set((Array.isArray(myHand) ? myHand : [...myHand]).map((c) => (typeof c === 'string' ? c : cardKey(c))))
      : this.myHand;
    let n = 0;
    for (const [key, card] of this._byKey) {
      if (card.suit !== this.trumpSuit) continue;
      if (mine.has(key) || this.discard.has(key)) continue;
      n++;
    }
    return n;
  }

  // ------------------------------------------------------------------
  //  Вспомогательное (для объяснений и тестов)
  // ------------------------------------------------------------------

  /** Set<cardKey> -> массив карт {rank, suit}. */
  toCards(keys) {
    const res = [];
    for (const k of keys) {
      const c = this._byKey.get(k);
      if (c) res.push({ ...c });
    }
    return res;
  }

  /** Человекочитаемая строчка — пригодится умному боту для `analysis`. */
  describe(oppId = null) {
    const parts = [`бито: ${this.discard.size}${this.unseenDiscardCount ? ` (+${this.unseenDiscardCount} невидимых)` : ''}`,
      `на столе: ${this.onTable.size}`,
      `неизвестно: ${this.unknownCards().size}`,
      `козырей вне моей руки: ${this.trumpsLeftOutside()}`];
    if (oppId) {
      const known = this.opponentKnownCards(oppId);
      parts.push(this.isOpponentHandCertain(oppId)
        ? `рука ${oppId} известна: ${this.toCards(known).map(cardToString).join(', ') || 'пусто'}`
        : `у ${oppId} точно есть: ${this.toCards(known).map(cardToString).join(', ') || '—'}`);
      const voids = [...(this.voidSuits.get(oppId) || [])];
      if (voids.length) parts.push(`скорее всего нет мастей: ${voids.join('')}`);
    }
    return parts.join('; ');
  }
}

export { SUITS };
export default CardTracker;
