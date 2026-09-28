import { cardToString } from '../deck.js';
import { PRESSURE_COST_WEIGHT, HIGH_RANK, BIG_TRUMP, list, myHandOf, handCountOf, alivePlayersCount } from './policyContext.js';
import { gamePhase, handStrength } from './analysis.js';

const PHASE_LABEL = { debut: 'начало партии', middle: 'середина партии', endgame: 'эндшпиль' };

export function analysisText(state, hand, trumpSuit, oppId) {
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

export function decisionReason(picked, trace) {
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

export function solverReason(action, value) {
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
