// Реестр уровней ботов и фабрика «мозгов».
//
// Этап 1 плана умного бота (issue #31): здесь появилась ЕДИНАЯ точка правды про то,
// какие уровни ботов существуют, как они называются и как получить объект, принимающий
// решения.
// Этап 3 (issue #33): уровень `smart` стал НАСТОЯЩИМ — его «мозг» собран из памяти
// (`./memory.js`), анализа (`./analysis.js`) и политики (`./smartBot.js`). Отката на
// простую логику для него больше нет, поэтому `fallback` у него всегда false.
//
// Важное ограничение: `src/bots/simpleBot.js` не меняется ни на одном этапе — на нём
// висят simulate/playVerbose/smoke/сервер/локальный клиент, и он же служит эталоном,
// с которым умный бот сравнивается в `src/cli/botMatch.js`.

import { simpleBotDecide } from './simpleBot.js';
import { SmartBot } from './smartBot.js';

export const BOT_LEVELS = [
  {
    id: 'simple',
    label: 'Простой',
    description: 'Базовые эвристики, ничего не запоминает',
  },
  {
    id: 'smart',
    label: 'Умный (считает карты)',
    description: 'Помнит вышедшие карты, анализирует стол, объясняет ходы',
  },
];

export const DEFAULT_BOT_LEVEL = 'simple';

// Уровни, «мозг» которых реально реализован на текущем этапе.
// Всё остальное из BOT_LEVELS создаётся с откатом на DEFAULT_BOT_LEVEL.
export const IMPLEMENTED_BOT_LEVELS = ['simple'];

export function isBotLevel(id) {
  return BOT_LEVELS.some((l) => l.id === id);
}

// Неизвестное/пустое/не строка -> DEFAULT_BOT_LEVEL. Регистр и пробелы прощаются,
// чтобы данные из CLI-аргументов и из сети не требовали отдельной валидации на месте.
export function normalizeBotLevel(x) {
  if (typeof x !== 'string') return DEFAULT_BOT_LEVEL;
  const id = x.trim().toLowerCase();
  return isBotLevel(id) ? id : DEFAULT_BOT_LEVEL;
}

export function botLevelLabel(id) {
  const level = BOT_LEVELS.find((l) => l.id === normalizeBotLevel(id));
  return level ? level.label : DEFAULT_BOT_LEVEL;
}

export function botLevelDescription(id) {
  const level = BOT_LEVELS.find((l) => l.id === normalizeBotLevel(id));
  return level ? level.description : '';
}

// «Мозг» простого бота: состояния не имеет, наблюдения игнорирует.
function createSimpleBrain(requestedLevel, options) {
  const explain = options.explain === true;
  return {
    // Какой уровень запрашивали (для UI/логов) и какой реально работает.
    level: requestedLevel,
    actualLevel: 'simple',
    fallback: requestedLevel !== 'simple',
    explain,
    // У простого бота нет памяти — reset/observe существуют только ради общего интерфейса,
    // чтобы вызывающий код (CLI, клиент, сервер) не знал, какой уровень он крутит.
    reset() {},
    observe() {},
    decide(state, playerId, legalActions) {
      const action = simpleBotDecide(state, playerId, legalActions);
      if (!action) return { action: null };
      if (!explain) return { action };
      // На этапе 1 объяснений по существу ещё нет: простой бот их не формирует.
      // Отдаём честную заглушку, а не выдуманный «анализ».
      return { action, reason: 'Простой бот: ход по базовым эвристикам.', analysis: null };
    },
  };
}

/**
 * Фабрика «мозга» бота.
 *
 * @param {string} level  идентификатор уровня (`simple` | `smart`), нестрогий
 * @param {object} options  { explain?: boolean, ... } — зарезервировано под умного бота
 * @returns {{ level: string, actualLevel: string, fallback: boolean,
 *             reset: Function, observe: Function, decide: Function }}
 *
 * decide(state, playerId, legalActions) -> { action, reason?, analysis? }
 * где `state` — ОБЯЗАТЕЛЬНО маскированное состояние `game.getState(playerId)`.
 */
export function createBotBrain(level, options = {}) {
  const requested = normalizeBotLevel(level);
  switch (requested) {
    case 'smart':
      // Этап 1: умного бота ещё нет — осознанно откатываемся на простого.
      return createSimpleBrain(requested, options);
    case 'simple':
    default:
      return createSimpleBrain('simple', options);
  }
}
