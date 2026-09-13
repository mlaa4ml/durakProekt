// Очный матч двух уровней ботов: кто чаще остаётся дураком.
// Заодно это самый простой способ увидеть объяснения ходов умного бота
// в том же виде, в котором их пишет сервер в лог партии.
//
// Запуск:
//   node src/cli/botMatch.js [партий] [уровеньA] [уровеньB] [колода] [игроков]
//   node src/cli/botMatch.js 200 smart simple 24 2
//   node src/cli/botMatch.js 1 smart simple 24 2 --verbose   # показать лог партии с объяснениями
//
// Уровни: simple | smart (см. src/bots/index.js).

import { DurakGame } from '../game.js';
import { createBotBrain, normalizeBotLevel, botLevelLabel } from '../bots/index.js';

const args = process.argv.slice(2).filter((a) => a !== '--verbose');
const verbose = process.argv.includes('--verbose');

const numGames = Number(args[0] || 200);
const levelA = normalizeBotLevel(args[1] || 'smart');
const levelB = normalizeBotLevel(args[2] || 'simple');
const deckSize = Number(args[3] || 24);
const numPlayers = Number(args[4] || 2);

const levels = Array.from({ length: numPlayers }, (_, i) => (i % 2 === 0 ? levelA : levelB));

let errors = 0;
let stuck = 0;
let draws = 0;
const durakCounts = {};
let explainedGameLog = null;

for (let g = 0; g < numGames; g++) {
  const players = levels.map((lvl, i) => ({ id: `p${i + 1}`, name: `p${i + 1}[${lvl}]` }));
  try {
    const game = new DurakGame(players, { numPlayers, deckSize }, Math.random);
    // Своя память на каждое место: умный бот накапливает знание о картах по ходу партии.
    const brains = new Map(players.map((p, i) => [p.id, createBotBrain(levels[i])]));
    const moveLog = [];

    let safety = 0;
    const MAX_STEPS = 5000;
    while (game.phase !== 'finished' && safety < MAX_STEPS) {
      safety++;
      let acted = false;
      for (const p of game.players) {
        if (p.out) continue;
        const legal = game.getLegalActions(p.id);
        if (legal.length === 0) continue;
        const { action, reason, analysis } = brains.get(p.id).decide(game.getState(p.id), p.id, legal);
        if (!action) continue;
        game.applyAction(p.id, action);
        if (reason) {
          moveLog.push(`🤖 ${p.name}: ${reason}`);
          if (analysis) moveLog.push(`   └ расклад: ${analysis}`);
        }
        acted = true;
        break;
      }
      if (!acted) break;
    }

    if (safety >= MAX_STEPS) stuck++;
    if (!game.durak) draws++;
    else durakCounts[game.durak] = (durakCounts[game.durak] || 0) + 1;
    if (verbose && !explainedGameLog) explainedGameLog = { game: game.log.slice(), moves: moveLog };
  } catch (e) {
    errors++;
    if (errors <= 3) console.error('Ошибка в партии:', e.message);
  }
}

console.log(`Матч ботов: ${numGames} партий, ${numPlayers} игроков, колода ${deckSize}`);
console.log(`Места: ${levels.map((l, i) => `p${i + 1} — ${botLevelLabel(l)}`).join(', ')}`);
console.log(`Ошибок движка: ${errors}, зависших: ${stuck}, ничьих: ${draws}`);
console.log('Сколько раз каждый остался дураком (меньше — лучше):');
for (let i = 0; i < numPlayers; i++) {
  const id = `p${i + 1}`;
  const count = durakCounts[id] || 0;
  const pct = ((count / numGames) * 100).toFixed(1);
  console.log(`  ${id} [${botLevelLabel(levels[i])}]: ${count} (${pct}%)`);
}

if (explainedGameLog) {
  console.log('\n--- Лог партии (события движка) ---');
  console.log(explainedGameLog.game.join('\n'));
  console.log('\n--- Объяснения ходов ботов (то, что уходит в лог игры на сервере) ---');
  console.log(explainedGameLog.moves.join('\n'));
}
