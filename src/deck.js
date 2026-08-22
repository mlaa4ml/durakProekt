// Колода: карты как {suit, rank}. rank — число, чем больше, тем старше.
export const SUITS = ['♠', '♥', '♦', '♣'];

const RANKS_BY_DECK_SIZE = {
  24: [9, 10, 11, 12, 13, 14],                    // 9,10,J,Q,K,A
  36: [6, 7, 8, 9, 10, 11, 12, 13, 14],            // 6..A
  52: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],// 2..A
};

export function createDeck(deckSize = 24) {
  const ranks = RANKS_BY_DECK_SIZE[deckSize];
  if (!ranks) throw new Error(`Неподдерживаемый размер колоды: ${deckSize}`);
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of ranks) {
      deck.push({ suit, rank });
    }
  }
  return deck;
}

export function shuffle(deck, rng = Math.random) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const RANK_NAMES = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export function rankName(rank) {
  return RANK_NAMES[rank] || String(rank);
}

export function cardToString(c) {
  return `${rankName(c.rank)}${c.suit}`;
}

export function sameRank(a, b) {
  return a.rank === b.rank;
}
