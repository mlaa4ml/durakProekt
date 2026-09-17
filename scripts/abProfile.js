// A/B-прогон флагов умного бота (issue #33, DoD: «каждый флаг подтверждён A/B-прогоном»).
//
// Зачем: в SMART_PROFILE каждое правило раздела 5.3 включается отдельным флагом.
// Здесь мы по очереди ВЫКЛЮЧАЕМ по одному флагу и смотрим, как меняется доля «дурака»
// у умного бота против простого. Если без флага результат НЕ хуже — флаг бесполезен
// (или вреден) и его надо выключить в профиле.
//
// Использование:
//   node scripts/abProfile.js [партий] [deckSize] [numPlayers]
//   node scripts/abProfile.js 1000 24 2
//
// Матч, как и в botMatch.js, гоняется в обе стороны: половина партий умный на 1-м месте,
// половина — на 2-м, чтобы преимущество первого хода не перекашивало цифры.

import { DurakGame } from '../src/game.js';
import { SmartBot, SMART_PROFILE } from '../src/bots/smartBot.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';

const MAX_STEPS = 3000;

function makeBrain(level, profile) {
  if (level === 'smart') {
    const bot = new SmartBot({ profile });
    return {
      reset: (s, id) => bot.reset(s, id),
      observe: (s, id) => bot.observe(s, id),
      decide: (s, id, legal) => bot.decide(s, id, legal).action,
    };
  }
  return {
    reset: () => {},
    observe: () => {},
    decide: (s, id, legal) => simpleBotDecide(s, id, legal),
  };
}

function playOne(levels, deckSize, numPlayers, profile) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
  const game = new DurakGame(players, { numPlayers, deckSize }, Math.random);

  const brains = new Map();
  players.forEach((p, i) => {
    const b = makeBrain(levels[i], profile);
    b.reset(game.getState(p.id), p.id);
    brains.set(p.id, b);
  });

  let steps = 0;
  while (game.phase !== 'finished' && steps < MAX_STEPS) {
    steps++;
    let acted = false;
    for (const p of game.players) {
      if (p.out) continue;
      const legal = game.getLegalActions(p.id);
      if (legal.length === 0) continue;
      const state = game.getState(p.id);
      const brain = brains.get(p.id);
      brain.observe(state, p.id);
      const action = brain.decide(state, p.id, legal);
      if (!action) continue;
      game.applyAction(p.id, action);
      acted = true;
      break;
    }
    if (!acted) break;
  }
  return game.durak ? game.players.findIndex((p) => p.id === game.durak) : -1;
}

/** @returns {{ smartDurakPct: number|null, decided: number }} */
function runMatch(numGames, deckSize, numPlayers, profile) {
  let smartDurak = 0;
  let decided = 0;
  for (let g = 0; g < numGames; g++) {
    const smartFirst = g % 2 === 0;
    const levels = Array.from({ length: numPlayers }, (_, i) => {
      const even = i % 2 === 0;
      return even === smartFirst ? 'smart' : 'simple';
    });
    const seat = playOne(levels, deckSize, numPlayers, profile);
    if (seat < 0) continue;
    decided++;
    if (levels[seat] === 'smart') smartDurak++;
  }
  return { smartDurakPct: decided ? (smartDurak / decided) * 100 : null, decided };
}

function main() {
  const numGames = Number(process.argv[2] || 1000);
  const deckSize = Number(process.argv[3] || 24);
  const numPlayers = Number(process.argv[4] || 2);

  console.log(`A/B профиля умного бота: ${numGames} партий, колода ${deckSize}, игроков ${numPlayers}`);
  console.log('Метрика — доля партий, где «дураком» остался УМНЫЙ бот (меньше = лучше).\n');

  const base = runMatch(numGames, deckSize, numPlayers, SMART_PROFILE);
  console.log(`| ${'конфигурация профиля'.padEnd(34)} | доля «дурака» у smart | дельта к базе |`);
  console.log(`|${'-'.repeat(36)}|${'-'.repeat(23)}|${'-'.repeat(15)}|`);
  console.log(`| ${'все флаги включены (база)'.padEnd(34)} | ${base.smartDurakPct.toFixed(1).padStart(20)} % | ${'—'.padStart(13)} |`);

  for (const flag of Object.keys(SMART_PROFILE)) {
    const profile = { ...SMART_PROFILE, [flag]: false };
    const res = runMatch(numGames, deckSize, numPlayers, profile);
    const delta = res.smartDurakPct - base.smartDurakPct;
    const verdict = delta < -0.5 ? ' ← без флага ЛУЧШЕ' : '';
    console.log(
      `| ${`без ${flag}`.padEnd(34)} | ${res.smartDurakPct.toFixed(1).padStart(20)} % | ` +
        `${`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`.padStart(13)} |${verdict}`,
    );
  }
}

main();
