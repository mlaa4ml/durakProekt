import { DurakGame } from '../game.js';
import { simpleBotDecide } from '../bots/simpleBot.js';

const numGames = Number(process.argv[2] || 1000);
const numPlayers = Number(process.argv[3] || 2);
const deckSize = Number(process.argv[4] || 24);

let errors = 0;
let stuck = 0;
let draws = 0;
const durakCounts = {};
let totalSteps = 0;

for (let g = 0; g < numGames; g++) {
  const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `p${i + 1}` }));
  try {
    const game = new DurakGame(players, { numPlayers, deckSize }, Math.random);
    let safety = 0;
    const MAX_STEPS = 5000;
    while (game.phase !== 'finished' && safety < MAX_STEPS) {
      safety++;
      let acted = false;
      for (const p of game.players) {
        if (p.out) continue;
        const legal = game.getLegalActions(p.id);
        if (legal.length === 0) continue;
        const action = simpleBotDecide(game.getState(p.id), p.id, legal);
        if (!action) continue;
        game.applyAction(p.id, action);
        acted = true;
        break;
      }
      if (!acted) break;
    }
    totalSteps += safety;
    if (safety >= MAX_STEPS) stuck++;
    if (!game.durak) draws++;
    else durakCounts[game.durak] = (durakCounts[game.durak] || 0) + 1;
  } catch (e) {
    errors++;
    if (errors <= 3) {
      console.error('Ошибка в партии:', e.message);
      console.error(e.stack);
    }
  }
}

console.log(`Сыграно партий: ${numGames} (${numPlayers} игроков, колода ${deckSize})`);
console.log(`Ошибок движка: ${errors}`);
console.log(`Зависших (упёрлись в предохранитель): ${stuck}`);
console.log(`Ничьих: ${draws}`);
console.log(`Среднее число шагов на партию: ${(totalSteps / numGames).toFixed(1)}`);
console.log(`Распределение "дурака" по игрокам:`, durakCounts);
