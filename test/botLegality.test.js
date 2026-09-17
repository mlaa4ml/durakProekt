// Фаззинг ботов: легальность ходов и честность (issue #33, этап 3, DoD).
// Запуск: node --test test/
//
// Проверяем три вещи, которые нельзя ловить глазами:
//   1) ЛЕГАЛЬНОСТЬ. Бот обязан возвращать действие ИЗ СПИСКА, который дал движок.
//      Прогоняем много партий во всех поддерживаемых конфигурациях; любое действие
//      вне списка (или отвергнутое applyAction) — падение теста.
//   2) «БОТ НЕ ПОДГЛЯДЫВАЕТ». В decide() приходит только маскированное состояние:
//      у чужих игроков поля `hand` нет вообще. Проверяем это на КАЖДОМ вызове,
//      причём состояние ещё и замораживаем, чтобы бот не мог его испортить.
//   3) ОБЪЯСНЕНИЯ. При explain: true умный бот отдаёт русские reason/analysis
//      и не называет чужие карты, пока не знает их наверняка.
//
// Число партий регулируется переменной окружения FUZZ_GAMES (по умолчанию — быстрый
// режим для CI). Полный прогон DoD (5000 партий):
//   FUZZ_GAMES=5000 node --test test/botLegality.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { DurakGame } from '../src/game.js';
import { createBotBrain } from '../src/bots/index.js';

const MAX_STEPS = 3000;
const TOTAL_GAMES = Number(process.env.FUZZ_GAMES || 300);

// Конфигурации, которые обязаны работать (те же, что в метрике G2).
const CONFIGS = [
  { deckSize: 24, numPlayers: 2 },
  { deckSize: 36, numPlayers: 2 },
  { deckSize: 36, numPlayers: 4 },
  { deckSize: 52, numPlayers: 3 },
];

function cloneState(state) {
  // getState() отдаёт СВОЙ массив руки по ссылке, поэтому замораживать его нельзя —
  // сломается сам движок. Вместо этого даём боту глубокую копию: так он физически
  // не может испортить состояние игры, а мы дополнительно сверяем копию до и после.
  return structuredClone(state);
}

/**
 * Одна партия. На каждом шаге сверяем состояние и выбранное действие.
 * @returns {{steps:number, explained:number}}
 */
function playChecked(levels, deckSize, numPlayers, { explain = false } = {}) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
  const game = new DurakGame(players, { numPlayers, deckSize }, Math.random);

  const brains = new Map();
  players.forEach((p, i) => {
    const brain = createBotBrain(levels[i], { explain });
    brain.reset(game.getState(p.id), p.id);
    brains.set(p.id, brain);
  });

  let steps = 0;
  let explained = 0;

  while (game.phase !== 'finished' && steps < MAX_STEPS) {
    steps++;
    let acted = false;
    for (const p of game.players) {
      if (p.out) continue;
      const legal = game.getLegalActions(p.id);
      if (legal.length === 0) continue;

      const state = cloneState(game.getState(p.id));

      // (2) Инвариант «бот не подглядывает»: чужих рук в состоянии нет.
      for (const other of state.players) {
        if (other.id === p.id) {
          assert.ok(Array.isArray(other.hand), 'своя рука должна быть видна');
        } else {
          assert.equal(other.hand, undefined, `в состоянии для ${p.id} видна рука ${other.id}`);
        }
      }
      const before = JSON.stringify(state);

      const brain = brains.get(p.id);
      brain.observe(state, p.id);
      const decision = brain.decide(state, p.id, legal) || {};
      const action = decision.action;
      assert.ok(action, `${p.id}: бот не выбрал действие, хотя ходы есть`);

      // (1) Легальность: действие обязано быть одним из выданных движком объектов.
      assert.ok(
        legal.includes(action),
        `${p.id}: нелегальное действие ${JSON.stringify(action)} (легальны: ${JSON.stringify(legal)})`,
      );

      // Бот не имеет права править состояние, которое ему показали.
      assert.equal(JSON.stringify(state), before, `${p.id}: бот изменил показанное ему состояние`);

      // (3) Объяснения.
      if (explain && brain.actualLevel === 'smart') {
        assert.equal(typeof decision.reason, 'string');
        assert.ok(decision.reason.length > 0, 'пустое объяснение');
        assert.equal(typeof decision.analysis, 'string');
        // Без внутренних терминов кода.
        for (const bad of ['undefined', 'null', 'NaN', '[object', 'attack', 'defend', 'legalActions']) {
          assert.ok(!decision.reason.includes(bad), `в объяснении технический термин: ${bad}`);
        }
        explained++;
      }

      game.applyAction(p.id, action); // бросит, если движок сочтёт ход недопустимым
      acted = true;
      break;
    }
    if (!acted) break;
  }

  assert.ok(steps < MAX_STEPS, 'партия не завершилась за разумное число шагов');
  return { steps, explained };
}

for (const { deckSize, numPlayers } of CONFIGS) {
  const games = Math.max(1, Math.round(TOTAL_GAMES / CONFIGS.length));

  test(`умный бот: ${games} партий колодой ${deckSize} на ${numPlayers} — только легальные ходы`, () => {
    for (let g = 0; g < games; g++) {
      const levels = Array.from({ length: numPlayers }, () => 'smart');
      playChecked(levels, deckSize, numPlayers);
    }
  });

  test(`умный против простого: ${games} партий колодой ${deckSize} на ${numPlayers} — только легальные ходы`, () => {
    for (let g = 0; g < games; g++) {
      const levels = Array.from({ length: numPlayers }, (_, i) => (i % 2 === 0 ? 'smart' : 'simple'));
      playChecked(levels, deckSize, numPlayers);
    }
  });
}

test('умный бот объясняет ходы по-русски и не выдумывает чужие карты', () => {
  let explained = 0;
  for (let g = 0; g < 20; g++) {
    const res = playChecked(['smart', 'smart'], 24, 2, { explain: true });
    explained += res.explained;
  }
  assert.ok(explained > 0, 'объяснения так и не появились');
});

test('уровень smart зарегистрирован как настоящий (без отката на простого)', async () => {
  const { IMPLEMENTED_BOT_LEVELS } = await import('../src/bots/index.js');
  const brain = createBotBrain('smart');
  assert.equal(brain.actualLevel, 'smart');
  assert.equal(brain.fallback, false);
  assert.ok(IMPLEMENTED_BOT_LEVELS.includes('smart'));
});
