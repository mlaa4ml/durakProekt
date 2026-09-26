import { createDeck, shuffle, cardToString, rankName } from './deck.js';
import { resolveRules } from './rules.js';

function canBeat(attackCard, defendCard, trumpSuit) {
  if (defendCard.suit === attackCard.suit) return defendCard.rank > attackCard.rank;
  if (defendCard.suit === trumpSuit && attackCard.suit !== trumpSuit) return true;
  return false;
}

function cardIndexInHand(hand, card) {
  return hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
}

// Правила, которые видны игрокам и уходят в getState().rules (только простые значения — JSON).
function publicRulesOf(rules) {
  return Object.freeze({
    deckSize: rules.deckSize,
    numPlayers: rules.numPlayers,
    handSize: rules.handSize,
    throwInPolicy: rules.throwInPolicy,
    throwInAfterTake: rules.throwInAfterTake,
    maxTableAttacks: rules.maxTableAttacks,
    attackLimitByDefenderHand: rules.attackLimitByDefenderHand,
    allowPerevod: rules.allowPerevod,
    perevodOnlyOnFirstCard: rules.perevodOnlyOnFirstCard,
    perevodRequiresEnoughCards: rules.perevodRequiresEnoughCards,
    stallLimit: rules.stallLimit,
    stallWarning: rules.stallWarning,
  });
}

// Русское склонение «ход/хода/ходов» для сообщений о ничьей и предупреждений о ней.
function pluralMoves(n) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'ход';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'хода';
  return 'ходов';
}

/**
 * DurakGame — движок партии "переводной дурак".
 * Работает через явные действия (attack/transfer/defend/take/pass),
 * которые может вызывать как бот, так и (в будущем) сетевой игрок через сервер.
 * Никакой сети/UI здесь нет — чистая логика + лог событий.
 */
export class DurakGame {
    // initialDeck is privileged diagnostic input, never part of getState().
  constructor(playerDefs, ruleOverrides = {}, rng = Math.random, initialDeck = null) {
    this.rules = resolveRules({ ...ruleOverrides, numPlayers: playerDefs.length });
    // Публичная копия правил для getState(): правила за партию не меняются, поэтому строим её
    // один раз и замораживаем — её нельзя испортить снаружи, а боту дёшево проверить «правила те же».
    this._publicRules = publicRulesOf(this.rules);
    this.rng = rng;
    this.log = [];
    this.silent = false; // true = не вести лог и не собирать состояние (перебор позиций в src/bots/endgame.js)

    this.players = playerDefs.map((p) => ({
      id: p.id,
      name: p.name || p.id,
      hand: [],
      out: false,      // вышел из игры (закончились карты и добор)
      finishRank: null, // место, на котором вышел (1 = первый освободился)
    }));

    this._deal(initialDeck);

    this.table = []; // [{attack, defense|null}]
    this.discardCount = 0;
    this.finishedOrder = [];
    this.durak = null;
    this.drawReason = null; // null | 'stall' (ничья по застою) | 'simultaneous' (несколько вышли одновременно)
    this.stallActions = 0;  // сколько ДЕЙСТВИЙ подряд прошло без прогресса — см. rules.stallLimit
    this._stallWarned = false;
    this.phase = 'need-attack'; // need-attack | defender-to-act | finished
    this.perevodUsedThisRound = false;

    this.attackerIndex = this._pickFirstAttacker();
    this._setDefender(this._nextActiveIndex(this.attackerIndex));
    this.allowAnyCardNow = true;  // разрешено класть любую карту (только на пустой стол в начале раунда)
    this.tookCards = false;       // true = защищающийся решил забрать; карты со стола пока НЕ убраны — лежат "на взятие"
    this.postTakeMode = false;    // true = защищающийся уже решил забрать карты в этом раунде; сам он больше не отбивается
    this.attackCountThisRound = 0; // счётчик всех подкинутых карт за раунд (включая подкинутые после взятия) — для лимита attackLimitByDefenderHand
    this._resetThrowInQueue();

    this._log(() => `Игра началась. Козырь: ${this.trumpCard ? cardToString(this.trumpCard) : '?'} (масть ${this.trumpSuit})`);
    this._log(() => `Первый ход: ${this.players[this.attackerIndex].name}, защищается: ${this.players[this.defenderIndex].name}`);
  }

  // Сообщение можно передать строкой или функцией, возвращающей строку: в «тихом» режиме
  // (перебор позиций, см. fromPosition) функция не вызывается вовсе, и строки не собираются зря.
  _log(msg) {
    if (this.silent) return;
    this.log.push(typeof msg === 'function' ? msg() : msg);
  }

  // Что возвращают действия: полное состояние, а в тихом режиме — ничего (его никто не читает).
  _result() {
    return this.silent ? null : this.getState();
  }

  _deal(initialDeck = null) {
    const standardDeck = createDeck(this.rules.deckSize);
    if (initialDeck !== null) {
      const key = (c) => c && `${c.suit}:${c.rank}`;
      const expected = new Set(standardDeck.map(key));
      if (!Array.isArray(initialDeck) || initialDeck.length !== standardDeck.length ||
          new Set(initialDeck.map(key)).size !== expected.size ||
          initialDeck.some((c) => !expected.has(key(c)))) {
        throw new Error('Некорректная начальная колода для replay');
      }
    }
    let deck = initialDeck === null
      ? shuffle(standardDeck, this.rng)
      : initialDeck.map((c) => ({ suit: c.suit, rank: c.rank }));
    // Козырь — нижняя карта колоды (по классике кладётся под низ, но нам важна лишь её масть)
    this.trumpCard = deck[deck.length - 1];
    this.trumpSuit = this.trumpCard.suit;

    for (const player of this.players) {
      player.hand = deck.splice(0, this.rules.handSize);
    }
    this.talon = deck; // оставшиеся карты — прикуп
  }

  _pickFirstAttacker() {
    // Ходит первым тот, у кого наименьший козырь на руках.
    let bestIdx = 0;
    let bestRank = Infinity;
    let found = false;
    this.players.forEach((p, idx) => {
      for (const c of p.hand) {
        if (c.suit === this.trumpSuit && c.rank < bestRank) {
          bestRank = c.rank;
          bestIdx = idx;
          found = true;
        }
      }
    });
    return found ? bestIdx : 0;
  }

  _activeIndices() {
    const res = [];
    this.players.forEach((p, idx) => { if (!p.out) res.push(idx); });
    return res;
  }

  _nextActiveIndex(fromIdx) {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (fromIdx + step) % n;
      if (!this.players[idx].out) return idx;
    }
    return fromIdx;
  }

  _resetThrowInQueue() {
    // Полный круг всех, кто в принципе мог бы подкинуть карту (кроме защищающегося),
    // начиная с атакующего и дальше по кругу. Порядок внутри круга сам по себе уже
    // соответствует желаемому: атакующий → сосед защищающегося → остальные по кругу.
    const fullCircle = [];
    let idx = this.attackerIndex;
    for (let i = 0; i < this.players.length; i++) {
      if (idx !== this.defenderIndex && !this.players[idx].out) fullCircle.push(idx);
      idx = (idx + 1) % this.players.length;
    }

    let queue;
    switch (this.rules.throwInPolicy) {
      case 'attackerOnly':
        // Только текущий атакующий.
        queue = fullCircle.length > 0 ? [this.attackerIndex] : [];
        break;
      case 'neighbors': {
        // Атакующий (он же — предыдущий активный игрок перед защищающимся)
        // и игрок, сидящий по другую сторону от защищающегося (следующий активный после него).
        queue = [this.attackerIndex];
        const afterDefender = this._nextActiveIndex(this.defenderIndex);
        if (afterDefender !== this.attackerIndex && !this.players[afterDefender].out) {
          queue.push(afterDefender);
        }
        break;
      }
      case 'all':
      default:
        // Все игроки, кроме защищающегося, по кругу начиная с атакующего.
        queue = fullCircle;
        break;
    }

    this.throwInQueue = queue;
    this.throwInQueuePos = 0;
    this.passedPlayers = new Set();
  }

  _undefendedAttacks() {
    return this.table.filter((t) => t.defense === null);
  }

  // Фиксирует нового защищающегося и СРАЗУ ЖЕ запоминает размер его руки —
  // именно "на начало раунда", т.е. до того как он успеет отбиться
  // (или перевести) хотя бы одной картой. Раньше _defenderHandAtStart
  // просто сбрасывался в undefined и пересчитывался лениво при первом
  // обращении, которое могло произойти уже ПОСЛЕ того, как защитник
  // отыграл несколько карт защиты — из-за этого лимит подкидывания
  // занижался (напр. 4 вместо 6 у игрока с 6 картами в начале хода).
  _setDefender(idx) {
    this.defenderIndex = idx;
    this._defenderHandAtStart = this.players[idx].hand.length;
  }

  _defenderHandSizeAtRoundStart() {
    if (this._defenderHandAtStart === undefined) {
      // Подстраховка на случай, если метод вызвали до _setDefender.
      this._defenderHandAtStart = this.players[this.defenderIndex].hand.length;
    }
    return this._defenderHandAtStart;
  }

  // ---------- Публичное API ----------

  getState(forPlayerId = null) {
    return {
      phase: this.phase,
      trumpSuit: this.trumpSuit,
      trumpCard: this.trumpCard,
      talonCount: this.talon.length,
      discardCount: this.discardCount,
      table: this.table.map((t) => ({ attack: t.attack, defense: t.defense })),
      // true = защитник уже решил забрать — карты на столе ещё физически лежат там,
      // но визуально их можно показывать как "уходящие" ему в руку.
      tableGoingToDefender: this.tookCards === true,
      attacker: this.players[this.attackerIndex]?.id,
      defender: this.players[this.defenderIndex]?.id,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        out: p.out,
        finishRank: p.finishRank,
        hand: forPlayerId === null || forPlayerId === p.id ? p.hand : undefined,
      })),
      durak: this.durak,
      finished: this.phase === 'finished',
      // Партия окончена без дурака: либо по застою (drawReason: 'stall'), либо несколько
      // игроков вышли в один и тот же момент, когда колода уже опустела ('simultaneous').
      draw: this.phase === 'finished' && this.durak === null,
      drawReason: this.drawReason,
      // Обратный отсчёт до ничьей «по застою» (см. rules.stallLimit); remaining === null,
      // если правило выключено (stallLimit: 0).
      stall: this.getStallInfo(),

      // Правила партии — боту и сетевому клиенту (раздел 2 SMART_BOT_ROADMAP.md).
      // Одинаковы для всех игроков и ничего не раскрывают: это настройки партии,
      // которые каждый видит и так. Простые значения — состояние уходит по сети как JSON.
      // Объект общий и замороженный (см. конструктор): править его нельзя, копию можно взять
      // через structuredClone / JSON.
      rules: this._publicRules,
      // Производные величины — считаем в движке, чтобы бот не пересчитывал их сам
      // и не мог разойтись с реальными ограничениями. Все выводятся из публичных данных
      // (стол, размер руки защитника на начало раунда, места за столом) и одинаковы
      // для любого игрока, поэтому от forPlayerId не зависят.
      ...this._throwInInfo(),
    };
  }

  // maxAttacksNow      — сколько ещё карт вообще можно положить на стол в этом раунде
  //                      (0 — подкидывать больше нельзя, что бы ни лежало в руках);
  // allowedThrowInRanks — какие ранги разрешено подкидывать сейчас: массив по возрастанию
  //                      (Set в JSON не превращается) или null = разрешена любая карта (начало раунда);
  // throwInPlayers     — id игроков, у которых по политике throwInPolicy есть право
  //                      подкидывать в этом заходе, в порядке очереди (атакующий — первым).
  //                      Это право, а не «чей ход прямо сейчас»: спасовавшие остаются в списке.
  _throwInInfo() {
    if (this.phase === 'finished') {
      return { maxAttacksNow: 0, allowedThrowInRanks: [], throwInPlayers: [] };
    }
    const ranks = this._currentAllowedThrowInRanks();
    return {
      maxAttacksNow: this._attackRoomLeft(),
      allowedThrowInRanks: ranks === null ? null : [...ranks].sort((a, b) => a - b),
      throwInPlayers: this.throwInQueue.map((idx) => this.players[idx].id),
    };
  }

  /**
   * Состояние отсчёта до ничьей «по застою»:
   *   actions   — сколько ДЕЙСТВИЙ подряд без прогресса уже прошло;
   *   limit     — на каком количестве действий наступит ничья (0 = правило выключено);
   *   remaining — сколько действий осталось до ничьей (null, если правило выключено);
   *   warning   — true, когда до ничьи осталось не больше rules.stallWarning действий
   *               (пора показывать предупреждение в интерфейсе).
   */
  getStallInfo() {
    const limit = this._stallLimit();
    if (limit <= 0) return { actions: 0, limit: 0, remaining: null, warning: false };
    const remaining = Math.max(limit - this.stallActions, 0);
    return {
      actions: this.stallActions,
      limit,
      remaining,
      warning: this.phase !== 'finished' && this.stallActions > 0 && remaining <= this.rules.stallWarning,
    };
  }

  // «Тихие» партии (перебор позиций решателя, src/bots/endgame.js) правило застоя не применяют:
  // там своя защита от зацикливания — повтор позиции на ветке перебора считается ничьей.
  _stallLimit() {
    return this.silent ? 0 : this.rules.stallLimit;
  }

  getLegalActions(playerId) {
    if (this.phase === 'finished') return [];
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1 || this.players[idx].out) return [];

    if (this.phase === 'defender-to-act') {
      if (idx !== this.defenderIndex) return [];
      return this._legalDefenderActions();
    }

    if (this.phase === 'need-attack') {
      const isNextThrower = this.throwInQueue[this.throwInQueuePos] === idx;
      if (!isNextThrower) return [];
      return this._legalThrowInActions(idx);
    }

    return [];
  }

  // Какие ранги сейчас разрешено подкидывать (или null = разрешено всё).
  // Единая точка правды: и _legalThrowInActions, и лог после отбоя/взятия берут ранги отсюда,
  // чтобы никогда не разойтись между собой.
  // Стол теперь не очищается сразу при взятии (карты остаются лежать "на взятие" до конца
  // захода — см. _doTake/_resolveTableClosed), поэтому пока идёт постТейк-подкидывание,
  // this.table всегда непуст и ранги естественным образом берутся из него же.
  _currentAllowedThrowInRanks() {
    const tableEmpty = this.table.length === 0;
    if (!tableEmpty) {
      return new Set(this.table.map((t) => t.attack.rank).concat(
        this.table.filter((t) => t.defense).map((t) => t.defense.rank)
      ));
    }
    if (this.allowAnyCardNow) return null;
    return new Set();
  }

  // Единый текст статуса лимита подкидывания — используется и после успешной защиты,
  // и после решения защитника забрать карты, чтобы в логе всегда было видно,
  // сколько ещё карт можно подкинуть и какие ранги разрешены.
  _throwInStatusText() {
    const allowedRanks = this._currentAllowedThrowInRanks();
    const ranksLabel = allowedRanks === null
      ? 'любые (новый раунд)'
      : (allowedRanks.size > 0 ? [...allowedRanks].map(rankName).join(', ') : 'нет (подкидывать нечем)');
    const limit = this._attackLimit();
    return `Можно подкидывать ранги: ${ranksLabel}. Лимит атак за раунд: ${this.attackCountThisRound}/${limit} (осталось ${this._attackRoomLeft()}).`;
  }

  // Лимит карт, которые можно положить на стол за весь раунд (с учётом maxTableAttacks
  // и, если включено, размера руки защищающегося на начало раунда).
  _attackLimit() {
    return Math.min(
      this.rules.maxTableAttacks,
      this.rules.attackLimitByDefenderHand ? this._defenderHandSizeAtRoundStart() : Infinity
    );
  }

  // Сколько карт ещё можно положить на стол в этом раунде. Считаем ВСЕ подкинутые за раунд
  // карты, включая те, что ушли в руку защитника после взятия (this.table в этот момент
  // уже пуст и не отражает их). Единая точка правды для _legalThrowInActions и getState().
  _attackRoomLeft() {
    return Math.max(this._attackLimit() - this.attackCountThisRound, 0);
  }

  _legalThrowInActions(idx) {
    const actions = [];
    const hand = this.players[idx].hand;
    const tableEmpty = this.table.length === 0;
    const allowedRanks = this._currentAllowedThrowInRanks();

    if (this._attackRoomLeft() > 0) {
      for (const c of hand) {
        if (allowedRanks === null || allowedRanks.has(c.rank)) {
          actions.push({ type: 'attack', card: c });
        }
      }
    }
    // Пасовать нельзя только самому первому игроку на пустом столе в начале раунда — иначе игра не начнётся.
    if (!(tableEmpty && this.allowAnyCardNow && idx === this.attackerIndex)) {
      actions.push({ type: 'pass' });
    }
    return actions;
  }

  _legalDefenderActions() {
    const actions = [];
    const defender = this.players[this.defenderIndex];
    const undefended = this._undefendedAttacks();

    // Отбить самую раннюю неотбитую атаку
    if (undefended.length > 0) {
      const target = undefended[0];
      for (const c of defender.hand) {
        if (canBeat(target.attack, c, this.trumpSuit)) {
          actions.push({ type: 'defend', card: c, against: target.attack });
        }
      }
    }

    // Перевод. Игрок сам решает, каким количеством карт того же ранга переводить:
    // можно перевести только одной (например, некозырной), а вторую такого же
    // ранга при желании подкинуть позже обычным подкидыванием.
    if (this._canConsiderPerevod()) {
      const rank = undefended[0].attack.rank;
      const matching = defender.hand.filter((c) => c.rank === rank);
      if (matching.length > 0) {
        const nextIdx = this._nextActiveIndex(this.defenderIndex);
        const nextPlayerHandSize = this.players[nextIdx].hand.length;
        const okByHandSize = (n) => !this.rules.perevodRequiresEnoughCards ||
          nextPlayerHandSize >= undefended.length + n;

        if (nextIdx !== this.defenderIndex) {
          // Перевод одной конкретной картой — по варианту на каждую подходящую карту в руке.
          for (const c of matching) {
            if (okByHandSize(1)) actions.push({ type: 'transfer', cards: [c] });
          }
          // Плюс перевод сразу всеми картами этого ранга одним ходом, если их больше одной.
          if (matching.length > 1 && okByHandSize(matching.length)) {
            actions.push({ type: 'transfer', cards: matching });
          }
        }
      }
    }

    actions.push({ type: 'take' });
    return actions;
  }

  _canConsiderPerevod() {
    if (!this.rules.allowPerevod) return false;
    if (this.rules.perevodOnlyOnFirstCard) {
      const anyDefended = this.table.some((t) => t.defense !== null);
      if (anyDefended) return false;
      // допустимо переводить, только пока на столе карты одного ранга (иначе непонятно, что переводим)
      const ranks = new Set(this.table.map((t) => t.attack.rank));
      if (ranks.size !== 1) return false;
    }
    return true;
  }

  applyAction(playerId, action) {
    const legal = this.getLegalActions(playerId);
    const match = legal.find((a) => this._actionsEqual(a, action));
    if (!match) {
      throw new Error(`Недопустимое действие для ${playerId}: ${JSON.stringify(action)}`);
    }

    const idx = this.players.findIndex((p) => p.id === playerId);
    return this._dispatch(idx, match);
  }

  // Выполняет уже проверенное действие (объект из getLegalActions).
  // Учёт застоя оборачивает вызов снаружи (а не встроен в отдельные _doX), поэтому считает
  // ЛЮБОЕ действие любого игрока — атаку, перевод, отбой, взятие, пас — одинаково, и его
  // не может случайно обойти будущий новый тип действия.
  _dispatch(idx, match) {
    // Only public facts are retained, never the result of getState() or drawn hands.
    // Silent solver copies do not allocate event batches.
    this.actionNumber = (this.actionNumber || 0) + 1;
    if (!this.silent) {
      const card = (c) => ({ rank: c.rank, suit: c.suit });
      this.publicTransition = null;
      this._pendingTransition = {
        actionNumber: this.actionNumber,
        actor: this.players[idx].id,
        action: {
          type: match.type,
          ...(match.card ? { card: card(match.card) } : {}),
          ...(match.cards ? { cards: match.cards.map(card) } : {}),
        },
        closures: [],
        trumpDraws: [],
      };
    }
    const before = { discard: this.discardCount, talon: this.talon.length, out: this.finishedOrder.length };
    switch (match.type) {
      case 'attack': this._doAttack(idx, match.card); break;
      case 'pass': this._doPass(idx); break;
      case 'defend': this._doDefend(idx, match.card, match.against); break;
      case 'transfer': this._doTransfer(idx, match.cards); break;
      case 'take': this._doTake(idx); break;
      default: throw new Error('Неизвестное действие: ' + match.type);
    }
    this._trackStall(before);
    if (!this.silent) {
      this.publicTransition = this._pendingTransition;
      this._pendingTransition = null;
    }
    return this._result();
  }

  // Прогресс — то, что гарантированно приближает партию к концу: пара карт ушла в бито,
  // игрок вышел из игры, кто-то взял карту из колоды (колода конечна, поэтому взятие из неё
  // тоже прогресс). Если за stallLimit действий подряд прогресса не было — ничья.
  _trackStall(before) {
    if (this.phase === 'finished') return;
    const limit = this._stallLimit();
    if (limit <= 0) return;

    const progressed = this.discardCount > before.discard
      || this.finishedOrder.length > before.out
      || this.talon.length < before.talon;

    if (progressed) {
      if (this._stallWarned) {
        this._log(() => 'Угроза ничьей по застою снята: счётчик действий без прогресса обнулён.');
      }
      this.stallActions = 0;
      this._stallWarned = false;
      return;
    }

    this.stallActions++;
    const remaining = limit - this.stallActions;
    if (remaining <= 0) {
      this._finishDraw('stall');
      return;
    }
    if (remaining <= this.rules.stallWarning) {
      this._stallWarned = true;
      this._log(() => `Внимание: ничья через ${remaining} ${pluralMoves(remaining)}, если ни одна пара карт не уйдёт в бито, никто не выйдет из игры и никто не возьмёт карту из колоды.`);
    }
  }

  _finishDraw(reason) {
    this.phase = 'finished';
    this.durak = null;
    this.drawReason = reason;
    this._log(() => `Игра окончена: ничья (${this.stallActions} ${pluralMoves(this.stallActions)} подряд без прогресса — ни одна пара карт не ушла в бито, никто не вышел из игры). Дурака нет, места игрокам, оставшимся с картами, не присваиваются.`);
  }

  // ---------- Копии позиции (для перебора: src/bots/endgame.js) ----------

  /** id игрока, чей ход прямо сейчас (или null, если партия окончена / ходить некому). */
  currentActorId() {
    if (this.phase === 'finished') return null;
    if (this.phase === 'defender-to-act') return this.players[this.defenderIndex].id;
    const idx = this.throwInQueue[this.throwInQueuePos];
    return idx === undefined ? null : this.players[idx].id;
  }

  /**
   * Выполняет действие БЕЗ повторной проверки: `legalAction` обязан быть объектом из
   * `getLegalActions(playerId)`. Нужен перебору позиций, где список легальных действий
   * уже получен и проверять его второй раз — лишняя работа. Для всего остального — applyAction.
   */
  applyLegalAction(playerId, legalAction) {
    const idx = this.players.findIndex((p) => p.id === playerId);
    if (idx === -1) throw new Error(`Нет игрока ${playerId}`);
    return this._dispatch(idx, legalAction);
  }

  /**
   * Независимая копия партии: её можно играть дальше, не трогая оригинал. Карты — неизменяемые
   * объекты и общие; руки, стол, очередь подкидывания — свои. Тест test/endgame.test.js сверяет
   * копию с оригиналом по всем полям, так что забытое при добавлении нового поля будет поймано.
   */
  clone() {
    const g = Object.create(DurakGame.prototype);
    g.rules = this.rules;
    g._publicRules = this._publicRules;
    g.rng = this.rng;
    g.silent = this.silent;
    g.log = this.silent ? [] : this.log.slice();
    g.players = this.players.map((p) => ({ ...p, hand: p.hand.slice() }));
    g.trumpCard = this.trumpCard;
    g.trumpSuit = this.trumpSuit;
    g.talon = this.talon.slice();
    g.table = this.table.map((t) => ({ attack: t.attack, defense: t.defense }));
    g.discardCount = this.discardCount;
    g.finishedOrder = this.finishedOrder.slice();
    g.durak = this.durak;
    g.drawReason = this.drawReason;
    g.stallActions = this.stallActions;
    g._stallWarned = this._stallWarned;
    g.phase = this.phase;
    g.perevodUsedThisRound = this.perevodUsedThisRound;
    g.attackerIndex = this.attackerIndex;
    g.defenderIndex = this.defenderIndex;
    g._defenderHandAtStart = this._defenderHandAtStart;
    g.allowAnyCardNow = this.allowAnyCardNow;
    g.tookCards = this.tookCards;
    g.postTakeMode = this.postTakeMode;
    g.attackCountThisRound = this.attackCountThisRound;
    g.throwInQueue = this.throwInQueue.slice();
    g.throwInQueuePos = this.throwInQueuePos;
    g.passedPlayers = new Set(this.passedPlayers);
    if (this._talonEmptyLogged !== undefined) g._talonEmptyLogged = this._talonEmptyLogged;
    return g;
  }

  /**
   * «Тихая» партия из готовой позиции — без раздачи и прикупа (talon пуст). Правила хода
   * (что можно подкинуть, перевод, лимит стола, конец партии) в ней — ровно движка, потому что
   * дальше её играет тот же код. Позиция описывается простыми данными:
   *   { rules,                               // state.rules (см. getState)
   *     trumpSuit, trumpCard?,
   *     players: [{ id, hand }, …],          // только живые игроки; порядок — по кругу
   *     attacker, defender,                  // id
   *     phase: 'need-attack' | 'defender-to-act',
   *     table: [{ attack, defense|null }],
   *     tookCards?,                          // защитник уже решил забрать (tableGoingToDefender)
   *     allowAnyCardNow?,                    // пустой стол, начало раунда: можно любую карту
   *     attackCountThisRound?, defenderHandAtStart?,   // счётчики лимита стола
   *     discardCount? }
   * Бросает Error, если позиция противоречива.
   */
  static fromPosition(pos) {
    if (!pos || !Array.isArray(pos.players) || pos.players.length < 2) throw new Error('В позиции должно быть минимум два игрока');
    if (pos.phase !== 'need-attack' && pos.phase !== 'defender-to-act') throw new Error(`Фаза позиции не поддерживается: ${pos.phase}`);
    const idOf = (id) => pos.players.findIndex((p) => p.id === id);
    const attackerIndex = idOf(pos.attacker);
    const defenderIndex = idOf(pos.defender);
    if (attackerIndex === -1 || defenderIndex === -1 || attackerIndex === defenderIndex) {
      throw new Error('Атакующий и защищающийся должны быть разными игроками позиции');
    }
    const copy = (c) => ({ suit: c.suit, rank: c.rank });

    const g = Object.create(DurakGame.prototype);
    g.rules = resolveRules({ ...pos.rules, numPlayers: pos.players.length });
    g._publicRules = publicRulesOf(g.rules);
    g.rng = Math.random;
    g.silent = true;
    g.log = [];
    g.players = pos.players.map((p) => ({ id: p.id, name: p.id, hand: p.hand.map(copy), out: false, finishRank: null }));
    g.trumpSuit = pos.trumpSuit;
    g.trumpCard = pos.trumpCard ? copy(pos.trumpCard) : null;
    g.talon = [];
    g.table = (pos.table || []).map((t) => ({ attack: copy(t.attack), defense: t.defense ? copy(t.defense) : null }));
    g.discardCount = pos.discardCount || 0;
    g.finishedOrder = [];
    g.durak = null;
    g.drawReason = null;
    g.stallActions = 0;
    g._stallWarned = false;
    g.phase = pos.phase;
    g.perevodUsedThisRound = false;
    g.attackerIndex = attackerIndex;
    g._setDefender(defenderIndex);
    if (Number.isInteger(pos.defenderHandAtStart)) g._defenderHandAtStart = pos.defenderHandAtStart;
    g.allowAnyCardNow = pos.allowAnyCardNow === true;
    g.tookCards = pos.tookCards === true;
    g.postTakeMode = g.tookCards;
    g.attackCountThisRound = Number.isInteger(pos.attackCountThisRound) ? pos.attackCountThisRound : 0;
    g._talonEmptyLogged = true;
    g._resetThrowInQueue();
    return g;
  }

  _actionsEqual(a, b) {
    if (a.type !== b.type) return false;
    if (a.type === 'attack' || a.type === 'defend') {
      return a.card.suit === b.card.suit && a.card.rank === b.card.rank;
    }
    if (a.type === 'transfer') {
      if (a.cards.length !== b.cards.length) return false;
      // Сравниваем как множества (порядок карт в запросе значения не имеет),
      // чтобы разные варианты перевода (одной картой из двух и т.п.) не путались.
      const bRemaining = b.cards.slice();
      for (const ac of a.cards) {
        const i = bRemaining.findIndex((bc) => bc.suit === ac.suit && bc.rank === ac.rank);
        if (i === -1) return false;
        bRemaining.splice(i, 1);
      }
      return true;
    }
    return true;
  }

  _removeFromHand(idx, card) {
    const hand = this.players[idx].hand;
    const i = cardIndexInHand(hand, card);
    if (i === -1) throw new Error('Карты нет в руке');
    return hand.splice(i, 1)[0];
  }

  _doAttack(idx, card) {
    this._removeFromHand(idx, card);
    this.attackCountThisRound++;
    this.table.push({ attack: card, defense: null });

    if (this.postTakeMode) {
      // Защищающийся уже решил забрать карты в этом раунде: новая подкинутая карта
      // ложится на стол рядом с остальными — видно всем, что она тоже уйдёт защитнику
      // при закрытии стола. Отбиваться от неё не нужно, фаза защиты не открывается.
      const defender = this.players[this.defenderIndex];
      this._log(() => `${this.players[idx].name} подкидывает ${cardToString(card)} — карта ляжет в стопку, которую забирает ${defender.name}`);
      this.allowAnyCardNow = false;
      this.passedPlayers.clear();
      this._advanceThrowInQueue();
      this._maybeResolveNeedAttack();
      return this._result();
    }

    this._log(() => `${this.players[idx].name} подкидывает ${cardToString(card)}`);
    this.allowAnyCardNow = false;
    this.passedPlayers.clear();
    this._advanceThrowInQueue();
    this.phase = 'defender-to-act';
    return this._result();
  }

  _doPass(idx) {
    this.passedPlayers.add(idx);
    this._log(() => `${this.players[idx].name} пасует`);
    this._advanceThrowInQueue();
    this._maybeResolveNeedAttack();
    return this._result();
  }

  _advanceThrowInQueue() {
    this.throwInQueuePos = (this.throwInQueuePos + 1) % Math.max(this.throwInQueue.length, 1);
  }

  _maybeResolveNeedAttack() {
    // Если все, кто мог подкинуть, спасовали подряд — стол закрывается.
    const activeThrowers = this.throwInQueue.length;
    if (activeThrowers === 0 || this.passedPlayers.size >= activeThrowers) {
      this._resolveTableClosed();
    }
  }

  _doDefend(idx, card, against) {
    this._removeFromHand(idx, card);
    const entry = this.table.find((t) => t.defense === null && t.attack.suit === against.suit && t.attack.rank === against.rank);
    entry.defense = card;
    this._log(() => `${this.players[idx].name} отбивается ${cardToString(card)} от ${cardToString(against)}`);

    if (this._undefendedAttacks().length > 0) {
      // есть ещё неотбитые — защищающийся продолжает
      this.phase = 'defender-to-act';
    } else {
      // всё отбито — снова очередь подкидывающих
      this.phase = 'need-attack';
      this._resetThrowInQueue();
      this._log(() => `Стол отбит. ${this._throwInStatusText()}`);
      this._maybeResolveNeedAttack(); // на случай если подкидывать больше некому/нечем
    }
    return this._result();
  }

  _doTransfer(idx, cards) {
    for (const c of cards) {
      this._removeFromHand(idx, c);
      this.table.push({ attack: c, defense: null });
    }
    this.attackCountThisRound += cards.length;
    this._log(() => `${this.players[idx].name} переводит: ${cards.map(cardToString).join(', ')}`);
    this.perevodUsedThisRound = true;

    // Переводящий сам становится атакующим (актуально прежде всего при
    // игре вдвоём: иначе "новый защищающийся" совпал бы с атакующим).
    this.attackerIndex = idx;
    this._setDefender(this._nextActiveIndex(idx)); // лимит фиксируется под нового защищающегося сразу
    this.allowAnyCardNow = false;
    this._resetThrowInQueue();
    this._log(() => `Теперь защищается: ${this.players[this.defenderIndex].name}`);
    this.phase = 'defender-to-act';
    return this._result();
  }

  _doTake(idx) {
    // Карты со стола НЕ убираем сразу — они остаются лежать до конца захода (пока все
    // не спасуют), чтобы всем было видно, что именно защитник забирает и что ещё
    // подкинули следом. Физически в руку защитника они уйдут в _resolveTableClosed.
    const cardCount = this.table.length + this.table.filter((t) => t.defense).length;
    this.tookCards = true;
    this.postTakeMode = true;
    this.allowAnyCardNow = false;
    this._log(() => `${this.players[idx].name} решает забрать карты (пока на столе ${cardCount} шт.). ${this._throwInStatusText()}`);
    this.phase = 'need-attack';
    this._resetThrowInQueueForThrowInAfterTake();
    this._maybeResolveNeedAttack();
    return this._result();
  }

  _resetThrowInQueueForThrowInAfterTake() {
    if (!this.rules.throwInAfterTake) {
      this.throwInQueue = [];
      this.throwInQueuePos = 0;
      this.passedPlayers = new Set();
      this._resolveTableClosed();
      return;
    }
    this._resetThrowInQueue();
  }

  _resolveTableClosed() {
    const tookCards = this.tookCards === true;
    this.tookCards = false;
    this.postTakeMode = false;

    const prevDefenderIdx = this.defenderIndex;
    if (tookCards) {
      // Заход завершён (все спасовали) — только теперь физически отдаём защитнику
      // всё, что накопилось на столе (то, что он изначально не отбил, плюс всё,
      // что успели подкинуть следом).
      const defender = this.players[prevDefenderIdx];
      const cardCount = this.table.length + this.table.filter((t) => t.defense).length;
      for (const t of this.table) {
        defender.hand.push(t.attack);
        if (t.defense) defender.hand.push(t.defense);
      }
      this.table = [];
      this._log(() => `${defender.name} забирает карты со стола (${cardCount} шт.)`);
    } else {
      this.discardCount += this.table.length * 2;
      this.table = [];
      this._log(() => `Карты биты, уходят в отбой.`);
    }

    this._refillHands(prevDefenderIdx);
    this._checkFinishedPlayers();

    if (this.phase === 'finished') return;

    // Следующий раунд:
    // - если защищавшийся отбился — он сам становится атакующим (роли переходят по кругу),
    //   если только он этим же ходом не вышел из игры (тогда ход передаётся дальше);
    // - если забрал карты — он пропускает ход, атакует снова тот, кто атаковал до этого.
    let newAttacker;
    if (tookCards) {
      newAttacker = this._nextActiveIndex(prevDefenderIdx);
    } else {
      newAttacker = this.players[prevDefenderIdx].out
        ? this._nextActiveIndex(prevDefenderIdx)
        : prevDefenderIdx;
    }
    const newDefender = this._nextActiveIndex(newAttacker);

    if (newAttacker === newDefender) {
      // остался де факто один активный игрок — партия окончена
      this._finishGame();
      return;
    }

    this.attackerIndex = newAttacker;
    this._setDefender(newDefender);
    this.perevodUsedThisRound = false;
    this.allowAnyCardNow = true;
    this.postTakeMode = false;
    this.attackCountThisRound = 0;
    this.phase = 'need-attack';
    this._resetThrowInQueue();
    this._log(() => `Новый раунд. Ходит: ${this.players[this.attackerIndex].name}, защищается: ${this.players[this.defenderIndex].name}`);
    this._maybeResolveNeedAttack();
  }

  _refillHands(startFromIdx) {
    if (this.talon.length === 0) return;
    // Порядок добора: атакующий и все, кто подкидывал (по кругу от атакующего), затем защищающийся последним.
    const order = [];
    let idx = this.attackerIndex;
    for (let i = 0; i < this.players.length; i++) {
      if (idx !== this.defenderIndex && !this.players[idx].out) order.push(idx);
      idx = (idx + 1) % this.players.length;
    }
    if (!this.players[this.defenderIndex].out) order.push(this.defenderIndex);

    for (const pIdx of order) {
      const player = this.players[pIdx];
      const drawn = [];
      while (player.hand.length < this.rules.handSize && this.talon.length > 0) {
        const card = this.talon.shift();
        player.hand.push(card);
        drawn.push(card);
      }
      if (drawn.length > 0) {
        this._log(() => `${player.name} добирает из колоды: ${drawn.map(cardToString).join(', ')} (в колоде осталось ${this.talon.length})`);
      }
    }
    if (this.talon.length === 0 && !this._talonEmptyLogged) {
      this._talonEmptyLogged = true;
      this._log(() => `Колода закончилась — дальше играем без добора.`);
    }
  }

  _checkFinishedPlayers() {
    this.players.forEach((p) => {
      if (!p.out && p.hand.length === 0 && this.talon.length === 0) {
        p.out = true;
        p.finishRank = this.finishedOrder.length + 1;
        this.finishedOrder.push(p.id);
        this._log(() => `${p.name} избавился от карт и выходит из игры (место ${p.finishRank})`);
      }
    });

    const active = this._activeIndices();
    if (active.length <= 1) {
      this._finishGame(active.length === 1 ? this.players[active[0]].id : null);
    }
  }

  _finishGame(durakId) {
    this.phase = 'finished';
    if (durakId !== undefined) {
      this.durak = durakId ?? null;
    } else {
      const active = this._activeIndices();
      this.durak = active.length === 1 ? this.players[active[0]].id : null;
    }
    this.drawReason = this.durak ? null : 'simultaneous';
    if (this.durak) {
      this._log(() => `Игра окончена. Дурак: ${this.players.find(p=>p.id===this.durak).name}`);
    } else {
      this._log(() => `Игра окончена. Ничья (колода закончилась, карты у нескольких игроков не совпали по времени).`);
    }
  }
}
