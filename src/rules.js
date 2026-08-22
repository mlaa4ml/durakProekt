// Все настраиваемые параметры игры собраны здесь.
// Это тот самый "конфиг", через который в будущем будут переключаться
// колоды 24/36/52, число игроков 2-6 и вариации правил.

export const DEFAULT_RULES = {
  deckSize: 24,               // 24 | 36 | 52
  numPlayers: 2,               // 2..6
  handSize: 6,                 // сколько карт на руках держим (добор до этого числа)

  allowPerevod: true,          // включён ли "переводной" механизм (работает и при 2 игроках — см. ниже)
  perevodOnlyOnFirstCard: true,// перевод возможен только пока ни одна карта на столе ещё не отбита
  perevodRequiresEnoughCards: true, // у принимающего перевод должно быть в руке не меньше карт, чем неотбитых атак

  maxTableAttacks: 6,          // классический предел одновременных атак на столе
  attackLimitByDefenderHand: true, // нельзя подкинуть больше карт, чем было в руке у защищающегося на начало раунда
  throwInAfterTake: true,      // если защищающийся забрал карты — остальные могут ещё раз подкинуть карты того же ранга

  // Кто имеет право подкидывать карты на стол (выбирается один раз в начале партии):
  //   'attackerOnly' — только текущий атакующий
  //   'neighbors'    — атакующий и игроки, сидящие рядом с защищающимся (по обе стороны от него)
  //   'all'          — все игроки, кроме самого защищающегося (классический вариант)
  // Порядок подкидывания внутри "захода" всегда один: сначала текущий атакующий,
  // затем игрок, сидящий рядом с защищающимся (следующий после него по кругу),
  // затем — если разрешено правилом 'all' — остальные игроки по кругу.
  throwInPolicy: 'all',

  firstAttackerRule: 'lowestTrump', // кто ходит первым в самой первой раздаче
};

const THROW_IN_POLICIES = ['attackerOnly', 'neighbors', 'all'];

export function resolveRules(overrides = {}) {
  const rules = { ...DEFAULT_RULES, ...overrides };

  if (![24, 36, 52].includes(rules.deckSize)) {
    throw new Error('deckSize должен быть 24, 36 или 52');
  }
  if (rules.numPlayers < 2 || rules.numPlayers > 6) {
    throw new Error('numPlayers должен быть от 2 до 6');
  }
  if (!THROW_IN_POLICIES.includes(rules.throwInPolicy)) {
    throw new Error(`throwInPolicy должен быть одним из: ${THROW_IN_POLICIES.join(', ')}`);
  }
  // При 2 игроках "перевод" не отключаем: переводящий и получающий перевод
  // просто меняются ролями (переводящий сам становится атакующим).

  const cardsNeededForDeal = rules.numPlayers * rules.handSize;
  if (cardsNeededForDeal > rules.deckSize) {
    throw new Error(
      `Колода из ${rules.deckSize} карт слишком мала для ${rules.numPlayers} игроков ` +
      `по ${rules.handSize} карт (нужно минимум ${cardsNeededForDeal})`
    );
  }

  return rules;
}
