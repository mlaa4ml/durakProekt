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

// Уровни, «мозг» которых реально реализован. С этапа 3 это и `simple`, и `smart`.
// Всё, чего здесь нет, создаётся с откатом на DEFAULT_BOT_LEVEL.
export const IMPLEMENTED_BOT_LEVELS = ['simple', 'smart'];

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

// «Мозг» умного бота: помнит вышедшие карты и умеет объяснять ходы.
// Внутри — SmartBot из ./smartBot.js; интерфейс тот же, что у простого,
// поэтому вызывающему коду (CLI, клиент, сервер) знать об уровне ничего не нужно.
function createSmartBrain(options) {
  const explain = options.explain === true;
  const bot = new SmartBot({ explain, trace: options.trace, profile: options.profile, solver: options.solver });
  return {
    level: 'smart',
    actualLevel: 'smart',
    fallback: false,
    explain,
    profile: bot.profile,
    solverStats: bot.solverStats,
    reset(state = null, meId = null) { bot.reset(state, meId); },
    observe(state, meId = null, event = null) { bot.observe(state, meId, event); },
    decide(state, playerId, legalActions) { return bot.decide(state, playerId, legalActions); },
  };
}

/**
 * Фабрика «мозга» бота.
 *
 * @param {string} level  идентификатор уровня (`simple` | `smart`), нестрогий
 * @param {object} options  { explain?: boolean, profile?: object, solver?: { maxNodes, maxMs } }
 * @returns {{ level: string, actualLevel: string, fallback: boolean,
 *             reset: Function, observe: Function, decide: Function }}
 *
 * decide(state, playerId, legalActions) -> { action, reason?, analysis? }
 * где `state` — ОБЯЗАТЕЛЬНО маскированное состояние `game.getState(playerId)`.
 */
/**
 * Apply one local action and deliver its public transition to every bot that was
 * alive before it (including players who finish during this action). The optional
 * executor allows CLI diagnostic recording without applying the action twice.
 * Never deliver applyAction's return value: it contains unmasked hands.
 */
export function applyObservedAction(game, brains, playerId, action, execute = null) {
  const recipients = game.players.filter((p) => !p.out && brains.has(p.id)).map((p) => p.id);
  if (execute) execute();
  else game.applyAction(playerId, action);
  const event = game.publicTransition;
  for (const id of recipients) {
    // Independent copies prevent one observer from mutating another's observation.
    brains.get(id).observe(
      structuredClone(game.getState(id)), id,
      event ? structuredClone(event) : null,
    );
  }
}

export function createBotBrain(level, options = {}) {
  const requested = normalizeBotLevel(level);
  switch (requested) {
    case 'smart':
      return createSmartBrain(options);
    case 'simple':
    default:
      return createSimpleBrain('simple', options);
  }
}
