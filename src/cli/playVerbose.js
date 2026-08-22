import { DurakGame } from '../game.js';
import { simpleBotDecide } from '../bots/simpleBot.js';
import { cardToString } from '../deck.js';

const numPlayers = Number(process.argv[2] || 2);
const deckSize = Number(process.argv[3] || 24);

const players = Array.from({ length: numPlayers }, (_, i) => ({ id: `p${i + 1}`, name: `Игрок ${i + 1}` }));
const game = new DurakGame(players, { numPlayers, deckSize });

console.log(`--- Начальные руки ---`);
for (const p of game.players) {
  console.log(`${p.name}: ${p.hand.map(cardToString).join(' ')}`);
}
console.log('');

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
    break; // применяем по одному действию за раз, чтобы состояние переоценивалось корректно
  }
  if (!acted) break;
}

console.log('--- Лог партии ---');
console.log(game.log.join('\n'));

console.log('');
console.log('--- Итог ---');
console.log('Порядок выхода (места):', game.finishedOrder.join(' -> '));
console.log('Дурак:', game.durak || 'нет (ничья)');
console.log('Шагов симуляции:', safety);
if (safety >= MAX_STEPS) {
  console.log('!! Достигнут предохранитель по числу шагов — похоже на зацикливание, нужно чинить.');
}
