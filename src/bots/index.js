// Реестр уровней ботов. Единая точка, через которую сервер, CLI и тесты
// выбирают, "каким умом" играет конкретное место за столом.
//
// Уровни:
//   'simple' — прежний бот (простые эвристики, ничего не запоминает);
//   'smart'  — бот с памятью карт, анализом стола и планом на партию,
//              умеет объяснять свои ходы.
//
// Единый интерфейс для всех уровней:
//   const brain = createBotBrain(level);        // объект с собственной памятью
//   const { action, reason, analysis } = brain.decide(state, playerId, legalActions);
//
// Старый simpleBotDecide(state, playerId, legalActions) остаётся доступным
// как есть (src/bots/simpleBot.js) — совместимость с уже написанным кодом
// (visual/index.html, smoke-тесты) не ломается.

import { simpleBotDecide } from './simpleBot.js';
import { smartBotDecide, BotMemory } from './smartBot.js';

export const BOT_LEVELS = [
  {
    id: 'simple',
    label: 'Простой',
    description: 'Базовые эвристики: бережёт козыри, кидает младшее, не считает карты.',
  },
  {
    id: 'smart',
    label: 'Умный (считает карты)',
    description: 'Помнит вышедшие карты и карты соперника, анализирует стол, строит план на концовку.',
  },
];

export const DEFAULT_BOT_LEVEL = 'simple';

export function isValidBotLevel(level) {
  return BOT_LEVELS.some((l) => l.id === level);
}

export function normalizeBotLevel(level) {
  return isValidBotLevel(level) ? level : DEFAULT_BOT_LEVEL;
}

export function botLevelLabel(level) {
  const found = BOT_LEVELS.find((l) => l.id === normalizeBotLevel(level));
  return found ? found.label : level;
}

/**
 * Создаёт "мозг" бота для одного места за столом. У умного уровня внутри живёт
 * память карт, поэтому на каждое место нужен свой экземпляр.
 */
export function createBotBrain(level = DEFAULT_BOT_LEVEL) {
  const id = normalizeBotLevel(level);

  if (id === 'smart') {
    const memory = new BotMemory();
    return {
      level: id,
      memory,
      decide(state, playerId, legalActions) {
        const res = smartBotDecide(state, playerId, legalActions, memory);
        return { action: res.action, reason: res.reason || '', analysis: res.analysis || '' };
      },
    };
  }

  return {
    level: id,
    memory: null,
    decide(state, playerId, legalActions) {
      const action = simpleBotDecide(state, playerId, legalActions);
      return { action, reason: '', analysis: '' };
    },
  };
}

export { simpleBotDecide, smartBotDecide, BotMemory };
