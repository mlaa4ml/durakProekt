// Профили умного бота (вынесены из политики в отдельный модуль, issue #72)

export const SMART_PROFILE = {
  // Вес удержания козырей при оценке руки
  trumpRetentionWeight: 1.2,
  // Использовать ли эвристику угрозы старших карт
  useThreatAssessment: true,
  // Глубина поиска в endgame / roundSearch
  searchDepth: 3,
  // Использовать ли точный решатель эндшпиля
  exactEndgameSolver: true,
  // Вес атаки по давлению
  pressureAttackWeight: 1.0,
  // Учитывать ли память вышедших карт
  useMemoryTracker: true,
  // Вес контроля масти
  suitControlWeight: 1.1,
  // Штраф за подброс сильных карт сопернику
  strongThrowInPenalty: 0.8,
  // Использовать публичную память при защите/атаке (#70)
  publicMemoryInDefense: true,
  // Использовать публичный вывод в поиске
  publicOutputInSearch: true
};

export const SMART_PROFILES = {
  // 2 игрока — исторический профиль
  duel: SMART_PROFILE,
  // 3-4 игрока
  small: {
    ...SMART_PROFILE,
    trumpRetentionWeight: 1.4,
    pressureAttackWeight: 0.9,
    strongThrowInPenalty: 1.0
  },
  // 5-6 игроков
  large: {
    ...SMART_PROFILE,
    trumpRetentionWeight: 1.6,
    pressureAttackWeight: 0.7,
    strongThrowInPenalty: 1.2,
    searchDepth: 2
  }
};

export function pickProfileName(rules) {
  const n = rules && rules.numPlayers ? Number(rules.numPlayers) : 2;
  if (n >= 5) return 'large';
  if (n >= 3) return 'small';
  return 'duel';
}

export function pickProfile(rules) {
  const name = pickProfileName(rules);
  return SMART_PROFILES[name] || SMART_PROFILES.duel;
}
