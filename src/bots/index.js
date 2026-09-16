import { simpleBotDecide } from './simpleBot.js';

export const BOT_LEVELS = {
  simple: {
    id: 'simple',
    label: 'Простой',
    description: 'Обычный бот с базовыми эвристиками (бережет крупные карты пока есть колода, не бьет козырем если можно перевести).'
  },
  smart: {
    id: 'smart',
    label: 'Умный (считает карты)',
    description: 'Умный бот (считает вышедшие карты и вероятности). В текущей версии реализован как заглушка с фолбэком на простой.'
  }
};

export const DEFAULT_BOT_LEVEL = 'simple';

export const IMPLEMENTED_BOT_LEVELS = ['simple', 'smart'];

export function isBotLevel(level) {
  return typeof level === 'string' && Object.prototype.hasOwnProperty.call(BOT_LEVELS, level.trim().toLowerCase());
}

export function normalizeBotLevel(level) {
  if (!level || typeof level !== 'string') return DEFAULT_BOT_LEVEL;
  const cleaned = level.trim().toLowerCase();
  return BOT_LEVELS[cleaned] ? cleaned : DEFAULT_BOT_LEVEL;
}

export function botLevelLabel(level) {
  const norm = normalizeBotLevel(level);
  return BOT_LEVELS[norm]?.label || BOT_LEVELS[DEFAULT_BOT_LEVEL].label;
}

export function botLevelDescription(level) {
  const norm = normalizeBotLevel(level);
  return BOT_LEVELS[norm]?.description || BOT_LEVELS[DEFAULT_BOT_LEVEL].description;
}

export function createBotBrain(level, options = {}) {
  const requested = typeof level === 'string' ? level.trim().toLowerCase() : DEFAULT_BOT_LEVEL;
  const normalized = normalizeBotLevel(requested);
  const explain = !!options.explain;

  const actualLevel = normalized === 'smart' ? 'simple' : normalized;
  const fallback = normalized === 'smart';

  if (fallback && !options._suppressSmartWarning) {
    console.warn(`[BotRegistry] Предупреждение: уровень "${requested}" ещё не реализован и играет логикой "simple".`);
  }

  return {
    level: normalized,
    actualLevel,
    fallback,
    explain,
    reset() {
      // Состояние сессии/памяти бота (если нужно для умного)
    },
    observe(actionResult, state) {
      // Наблюдение за ходами оппонентов (для умного бота)
    },
    decide(state, playerId, legalActions) {
      const action = simpleBotDecide(state, playerId, legalActions);
      if (!action) return null;

      if (explain) {
        return {
          action,
          reason: 'Выбрано базовой эвристикой simpleBot',
          analysis: {
            talonCount: state.talonCount,
            trumpSuit: state.trumpSuit,
            legalActionsCount: legalActions.length
          }
        };
      }

      return { action };
    }
  };
}
