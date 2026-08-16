// Бот уровня "нормально играет, но не считает вероятности".
// Логика:
// - Атакует/подкидывает самой младшей не козырной картой, если есть; козыри бережёт.
// - Останавливается подкидывать, если у него самого осталось мало карт.
// - Защищается самой дешёвой подходящей картой (не козырной, если можно).
// - Переводит, если пришлось бы отбиваться козырем, а перевести можно недорогой картой.
// - Если отбиться нечем — берёт карты.

function cardValue(card, trumpSuit) {
  return (card.suit === trumpSuit ? 100 : 0) + card.rank;
}

export function simpleBotDecide(state, playerId, legalActions) {
  if (legalActions.length === 0) return null;

  const trumpSuit = state.trumpSuit;
  const me = state.players.find((p) => p.id === playerId);
  const myHandSize = me.handCount;

  const attacks = legalActions.filter((a) => a.type === 'attack');
  const defends = legalActions.filter((a) => a.type === 'defend');
  const transfer = legalActions.find((a) => a.type === 'transfer');
  const take = legalActions.find((a) => a.type === 'take');
  const pass = legalActions.find((a) => a.type === 'pass');

  if (attacks.length > 0) {
    // Не подкидываем, если у нас и так мало карт (бережём руку под конец игры), кроме обязательного первого хода
    const mustAttack = !pass;
    if (mustAttack || myHandSize > 3) {
      attacks.sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
      const cheapest = attacks[0];
      if (mustAttack || cardValue(cheapest.card, trumpSuit) < 90) {
        return cheapest;
      }
    }
    if (pass) return pass;
  }

  if (defends.length > 0) {
    defends.sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
    const cheapest = defends[0];
    const wouldUseTrump = cheapest.card.suit === trumpSuit;

    if (wouldUseTrump && transfer) {
      return transfer;
    }
    return cheapest;
  }

  if (transfer) return transfer;
  if (take) return take;
  if (pass) return pass;
  return legalActions[0];
}
