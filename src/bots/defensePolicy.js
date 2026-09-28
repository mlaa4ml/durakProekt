import { cardToString } from '../deck.js';
import { PRESSURE_COST_WEIGHT, HIGH_RANK, BIG_TRUMP, list, myHandOf, handCountOf, alivePlayersCount } from './policyContext.js';
import { cardPower, planDefense, suitControl } from './analysis.js';
import { pDefenseSurvives, expectedThrowIn, voidSuitsOf } from './estimate.js';

export function decideDefensePolicy(state, playerId, legalActions, { defends, transfers, take }) {
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
