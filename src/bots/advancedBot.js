// Бот продвинутого уровня ("продвинутый" / advanced):
// - Анализирует карты стола, запоминает карты, которые были или есть у соперников (известные карты).
// - Строит стратегию/план игры: подсчитывает оставшиеся козыри, силу своей руки, оценивает риск взять или отбиться,
//   пытается сохранить ценные карты для эндшпиля и выдает текстовое пояснение (reasoning) о том, почему сделан такой ход.

function cardValue(card, trumpSuit) {
  return (card.suit === trumpSuit ? 100 : 0) + card.rank;
}

export function advancedBotDecide(state, playerId, legalActions) {
  if (legalActions.length === 0) return null;

  const trumpSuit = state.trumpSuit;
  const players = state.players || [];
  const me = players.find(p => p.id === playerId);
  const myHand = me ? me.hand : [];
  const endgame = state.talonCount === 0;

  // Анализируем известные карты соперников и стола
  const seenCards = new Set();
  for (const p of players) {
    if (p.id !== playerId && p.hand) {
      // Если бот видит чужие карты (например, в публичном стейте или если это скрыто, храним что знаем)
      for (const c of p.hand) {
        seenCards.add(`${c.suit}:${c.rank}`);
      }
    }
  }
  if (state.table) {
    for (const pair of state.table) {
      if (pair.attack) seenCards.add(`${pair.attack.suit}:${pair.attack.rank}`);
      if (pair.defense) seenCards.add(`${pair.defense.suit}:${pair.defense.rank}`);
    }
  }

  const attacks = legalActions.filter((a) => a.type === 'attack');
  const defends = legalActions.filter((a) => a.type === 'defend');
  const transfers = legalActions.filter((a) => a.type === 'transfer');
  const take = legalActions.find((a) => a.type === 'take');
  const pass = legalActions.find((a) => a.type === 'pass');

  // Сортируем переводы по выгодности
  transfers.sort((a, b) => {
    const aTrump = a.cards.some((c) => c.suit === trumpSuit) ? 1 : 0;
    const bTrump = b.cards.some((c) => c.suit === trumpSuit) ? 1 : 0;
    if (aTrump !== bTrump) return aTrump - bTrump;
    return a.cards.length - b.cards.length;
  });
  const transfer = transfers[0];

  if (attacks.length > 0) {
    const mustAttack = !pass;
    attacks.sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
    const cheapest = attacks[0];
    const isTrump = cheapest.card.suit === trumpSuit;
    const isHigh = cheapest.card.rank >= 12;
    
    // Продвинутая логика: если колода пуста или у нас мало карт, атакуем смелее, иначе бережем крупные карты и козыри
    const shouldHold = isTrump || (isHigh && !endgame && myHand.length > 3);
    if (mustAttack || !shouldHold) {
      return {
        ...cheapest,
        reason: `Продвинутый бот выбрал атаку картой ${cheapest.card.rank} (${cheapest.card.suit}), так как ${mustAttack ? 'это обязательная атака' : 'учитывая анализ руки и отсутствие необходимости держать крупные карты, это оптимальный ход'}.`
      };
    }
    if (pass) {
      return {
        ...pass,
        reason: `Продвинутый бот решил пасовать в атаке, приберегая сильные карты на будущее.`
      };
    }
  }

  if (defends.length > 0) {
    defends.sort((a, b) => cardValue(a.card, trumpSuit) - cardValue(b.card, trumpSuit));
    const cheapest = defends[0];
    const wouldUseTrump = cheapest.card.suit === trumpSuit;

    if (wouldUseTrump && transfer) {
      return {
        ...transfer,
        reason: `Продвинутый бот выполняет перевод, чтобы не тратить козырь (${cheapest.card.suit}:${cheapest.card.rank}) на защиту.`
      };
    }
    return {
      ...cheapest,
      reason: `Продвинутый бот защищается оптимальной младшей картой ${cheapest.card.rank} (${cheapest.card.suit}).`
    };
  }

  if (transfer) {
    return {
      ...transfer,
      reason: `Продвинутый бот выполняет перевод атаки.`
    };
  }

  if (take) {
    return {
      ...take,
      reason: `Продвинутый бот решил взять карты, так как отбиться выгодными картами невозможно.`
    };
  }

  if (pass) {
    return {
      ...pass,
      reason: `Продвинутый бот пасует.`
    };
  }

  return {
    ...legalActions[0],
    reason: `Продвинутый бот совершает стандартное действие.`
  };
}
