// Бот уровня "нормально играет, но не считает вероятности".
// Логика:
// - Атакует/подкидывает самой младшей не козырной картой, если есть; козыри бережёт всегда
//   (кроме обязательного хода).
// - Дам, королей и тузов придерживает, только пока в колоде есть прикуп — их выгодно
//   разыгрывать позже, когда рука уже неизвестна другим игрокам. Мелкие карты кидает
//   в любой момент, независимо от размера своей руки: держать их про запас смысла нет.
// - Когда прикуп закончился (колода пуста), беречь уже нечего — бросает всё некозырное.
// - Защищается самой дешёвой подходящей картой (не козырной, если можно).
// - Переводит, если пришлось бы отбиваться козырем, а перевести можно недорогой картой.
// - Если отбиться нечем — берёт карты.

function cardValue(card, trumpSuit) {
  return (card.suit === trumpSuit ? 100 : 0) + card.rank;
}

// Дама и старше (валет уже не считается "крупной" картой — его невыгодно придерживать).
function isHighCard(card) {
  return card.rank >= 12;
}

export function simpleBotDecide(state, playerId, legalActions) {
  if (legalActions.length === 0) return null;

  const trumpSuit = state.trumpSuit;
  // Пока в колоде есть прикуп, есть смысл экономить крупные карты на потом.
  // Когда колода пуста, экономить дальше нечего — задача избавиться от карт как можно быстрее.
  const endgame = state.talonCount === 0;

  const attacks = legalActions.filter((a) => a.type === 'attack');
  const defends = legalActions.filter((a) => a.type === 'defend');
  const transfers = legalActions.filter((a) => a.type === 'transfer');
  // Среди вариантов перевода бот предпочитает не отдавать козыри и переводить
  // минимальным числом карт, оставляя остальные такого же ранга в руке про запас.
  transfers.sort((a, b) => {
    const aTrump = a.cards.some((c) => c.suit === trumpSuit) ? 1 : 0;
    const bTrump = b.cards.some((c) => c.suit === trumpSuit) ? 1 : 0;
    if (aTrump !== bTrump) return aTrump - bTrump;
    return a.cards.length - b.cards.length;
  });
  const transfer = transfers[0];
  const take = legalActions.find((a) => a.type === 'take');
  const pass = legalActions.find((a) => a.type === 'pass');

  if (attacks.length > 0) {
    const mustAttack = !pass;
    attacks.sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
    const cheapest = attacks[0];
    const isTrump = cheapest.card.suit === trumpSuit;
    // Козырь придерживаем всегда; крупную карту (Q+) — только пока есть смысл её беречь
    // (в колоде ещё остался прикуп). Мелкие некозырные карты кидаем без ограничений.
    const shouldHold = isTrump || (isHighCard(cheapest.card) && !endgame);
    if (mustAttack || !shouldHold) {
      return cheapest;
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
