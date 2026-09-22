// Тесты профилей умного бота по варианту игры (issue #50, этап 5 SMART_BOT_ROADMAP.md).
// Запуск: node --test test/
//
// Что проверяем:
//   * `pickProfile` / `pickProfileName` дают ожидаемый профиль для 2 / 3 / 4 / 5 / 6 игроков;
//   * мусорное, отсутствующее или бессмысленное `rules` даёт безопасный дефолт и НЕ бросает;
//   * все профили содержат ОДИН И ТОТ ЖЕ набор ключей — иначе флаг можно молча потерять
//     в одном из профилей, и правило перестанет работать только на части столов;
//   * `SMART_PROFILE` остался алиасом профиля `duel` (обратная совместимость: на него
//     ссылаются scripts/abProfile.js, scripts/evalBots.js, test/endgame.test.js);
//   * бот выбирает профиль сам, по state.rules, и фиксирует его на партию (reset).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SMART_PROFILE,
  SMART_PROFILES,
  pickProfile,
  pickProfileName,
  SmartBot,
} from '../src/bots/smartBot.js';
import { DurakGame } from '../src/game.js';

const PROFILE_NAMES = ['duel', 'small', 'large'];

test('профилей ровно три и все — объекты', () => {
  assert.deepEqual(Object.keys(SMART_PROFILES).sort(), [...PROFILE_NAMES].sort());
  for (const name of PROFILE_NAMES) {
    assert.equal(typeof SMART_PROFILES[name], 'object');
    assert.notEqual(SMART_PROFILES[name], null);
  }
});

test('SMART_PROFILE — алиас профиля duel (обратная совместимость)', () => {
  assert.equal(SMART_PROFILES.duel, SMART_PROFILE);
});

test('у всех профилей одинаковый набор ключей', () => {
  const base = Object.keys(SMART_PROFILE).sort();
  for (const name of PROFILE_NAMES) {
    assert.deepEqual(
      Object.keys(SMART_PROFILES[name]).sort(),
      base,
      `профиль ${name}: набор флагов разошёлся с duel`,
    );
  }
});

test('все значения флагов — булевы во всех профилях', () => {
  for (const name of PROFILE_NAMES) {
    for (const [flag, value] of Object.entries(SMART_PROFILES[name])) {
      assert.equal(typeof value, 'boolean', `${name}.${flag} должен быть boolean`);
    }
  }
});

test('pickProfileName: 2 -> duel, 3–4 -> small, 5–6 -> large', () => {
  assert.equal(pickProfileName({ numPlayers: 2 }), 'duel');
  assert.equal(pickProfileName({ numPlayers: 3 }), 'small');
  assert.equal(pickProfileName({ numPlayers: 4 }), 'small');
  assert.equal(pickProfileName({ numPlayers: 5 }), 'large');
  assert.equal(pickProfileName({ numPlayers: 6 }), 'large');
});

test('pickProfile отдаёт тот же объект, что и SMART_PROFILES[имя]', () => {
  assert.equal(pickProfile({ numPlayers: 2 }), SMART_PROFILES.duel);
  assert.equal(pickProfile({ numPlayers: 4 }), SMART_PROFILES.small);
  assert.equal(pickProfile({ numPlayers: 6 }), SMART_PROFILES.large);
});

test('неизвестное/отсутствующее/мусорное rules -> безопасный дефолт, без исключений', () => {
  const junk = [
    undefined,
    null,
    {},
    { numPlayers: undefined },
    { numPlayers: null },
    { numPlayers: 'четыре' },
    { numPlayers: NaN },
    { numPlayers: 0 },
    { numPlayers: -3 },
    { numPlayers: 1 },
    'строка',
    42,
    [],
  ];
  for (const rules of junk) {
    const name = pickProfileName(rules);
    assert.ok(PROFILE_NAMES.includes(name), `мусор ${JSON.stringify(rules)} дал профиль ${name}`);
    const profile = pickProfile(rules);
    assert.equal(typeof profile, 'object');
    assert.notEqual(profile, null);
    assert.deepEqual(Object.keys(profile).sort(), Object.keys(SMART_PROFILE).sort());
  }
  // Значение по умолчанию — дуэльный профиль.
  assert.equal(pickProfileName(undefined), 'duel');
  assert.equal(pickProfile(null), SMART_PROFILES.duel);
});

test('очень большой стол всё равно попадает в large', () => {
  assert.equal(pickProfileName({ numPlayers: 8 }), 'large');
  assert.equal(pickProfileName({ numPlayers: 100 }), 'large');
});

test('numPlayers строкой (устаревший клиент) не ломает выбор', () => {
  assert.equal(pickProfileName({ numPlayers: '2' }), 'duel');
  assert.equal(pickProfileName({ numPlayers: '4' }), 'small');
  assert.equal(pickProfileName({ numPlayers: '6' }), 'large');
});

// --- бот выбирает профиль сам, из состояния -------------------------------------

function startGame(numPlayers, deckSize) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
  return new DurakGame(players, { numPlayers, deckSize }, Math.random);
}

test('SmartBot подбирает профиль по state.rules без внешних переключателей', () => {
  for (const [numPlayers, deckSize, expected] of [[2, 24, 'duel'], [4, 36, 'small'], [6, 52, 'large']]) {
    const game = startGame(numPlayers, deckSize);
    const bot = new SmartBot();
    bot.reset(game.getState('p1'), 'p1');
    assert.equal(bot.profileName, expected, `${numPlayers} игроков -> ожидался профиль ${expected}`);
    assert.deepEqual(
      Object.keys(bot.profile).sort(),
      Object.keys(SMART_PROFILE).sort(),
      'набор флагов у бота должен совпадать с эталонным',
    );
  }
});

test('профиль фиксируется на партию и переизбирается только в reset()', () => {
  const duelGame = startGame(2, 24);
  const bigGame = startGame(6, 52);

  const bot = new SmartBot();
  bot.reset(bigGame.getState('p1'), 'p1');
  assert.equal(bot.profileName, 'large');

  // Наблюдение состояния из ДРУГОЙ партии посреди игры профиль не меняет.
  bot.observe(duelGame.getState('p1'), 'p1');
  assert.equal(bot.profileName, 'large');

  // Новая партия — новый подбор.
  bot.reset(duelGame.getState('p1'), 'p1');
  assert.equal(bot.profileName, 'duel');
});

test('явный profile в опциях перекрывает автоподбор (A/B-прогоны, тесты)', () => {
  const game = startGame(6, 52);
  const bot = new SmartBot({ profile: { dumpPairs: false } });
  bot.reset(game.getState('p1'), 'p1');
  assert.equal(bot.profile.dumpPairs, false, 'явный флаг обязан пережить автоподбор');
  assert.equal(bot.profileName, 'custom');
});

test('бот без состояния (decide без observe) не падает и имеет рабочий профиль', () => {
  const bot = new SmartBot();
  assert.equal(typeof bot.profile, 'object');
  const res = bot.decide(null, 'p1', []);
  assert.deepEqual(res, { action: null });
  assert.deepEqual(Object.keys(bot.profile).sort(), Object.keys(SMART_PROFILE).sort());
});
