import { cardToString } from '../deck.js';
import { PRESSURE_COST_WEIGHT, HIGH_RANK, BIG_TRUMP, list, myHandOf, handCountOf, alivePlayersCount } from './policyContext.js';
import { beats, cardPower } from './analysis.js';
import { bestAttackByPressure, voidSuitsOf, MAX_CARD_POWER } from './estimate.js';

export function decideAttackPolicy(state, playerId, legalActions) {
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
