import { DurakGame } from '../game.js';
import { createBotBrain, normalizeBotLevel, botLevelLabel, IMPLEMENTED_BOT_LEVELS } from '../bots/index.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const cleanArgs = args.filter(a => a !== '--verbose');

const numGames = Number(cleanArgs[0] || 1000);
const levelA = normalizeBotLevel(cleanArgs[1] || 'simple');
const levelB = normalizeBotLevel(cleanArgs[2] || 'simple');
const deckSize = Number(cleanArgs[3] || 24);
const numPlayers = Number(cleanArgs[4] || 2);

console.log(`=== Матч ботов: ${numGames} партий ===`);
console.log(`Игрок A (первая половина): ${levelA} (${botLevelLabel(levelA)})`);
console.log(`Игрок B (первая половина): ${levelB} (${botLevelLabel(levelB)})`);
console.log(`Конфигурация: игроков=${numPlayers}, колода=${deckSize}, verbose=${verbose}`);

let errors = 0;
let stuck = 0;
let draws = 0;
const durakCounts = {}; // по ID игрока ('p1', 'p2', ...)
const durakByLevel = {}; // по уровню бота ('simple', 'smart', ...)
const durakBySeat = {}; // по месту (1, 2, ...)
let totalSteps = 0;

// Распределение мест:
// В первой половине (g < numGames / 2):
// Игрок p1 имеет уровень levelA, остальные p2..pN имеют уровень levelB.
// Во второй половине (g >= numGames / 2):
// Меняем местами или сдвигаем по кругу, чтобы каждый бот побывал на разных местах.
// Для 2 игроков: в первой половине p1=A, p2=B; во второй половине p1=B, p2=A.
// Для N игроков: циклический сдвиг уровня A по местам.

for (let g = 0; g < numGames; g++) {
  const isSecondHalf = g >= numGames / 2;
  const playersInfo = [];
  
  for (let i = 0; i < numPlayers; i++) {
    const seatNum = i + 1; // 1, 2, ...
    let assignedLevel;
    if (numPlayers === 2) {
      if (!isSecondHalf) {
        assignedLevel = seatNum === 1 ? levelA : levelB;
      } else {
        assignedLevel = seatNum === 1 ? levelB : levelA;
      }
    } else {
      // Для N игроков циклически сдвигаем A
      const shift = isSecondHalf ? 1 : 0;
      const aSeat = ((Math.floor(g / (numGames / (numPlayers * 2))) + shift) % numPlayers) + 1;
      assignedLevel = seatNum === aSeat ? levelA : levelB;
    }

    playersInfo.push({
      id: `p${seatNum}`,
      name: `P${seatNum}(${assignedLevel})`,
      level: assignedLevel,
      seat: seatNum
    });
  }

  const brains = {};
  playersInfo.forEach(p => {
    brains[p.id] = createBotBrain(p.level, { explain: verbose && g === 0, _suppressSmartWarning: true });
    brains[p.id].reset();
  });

  try {
    const gamePlayers = playersInfo.map(p => ({ id: p.id, name: p.name }));
    const game = new DurakGame(gamePlayers, { numPlayers, deckSize }, Math.random);
    let safety = 0;
    const MAX_STEPS = 5000;

    while (game.phase !== 'finished' && safety < MAX_STEPS) {
      safety++;
      let acted = false;
      for (const p of game.players) {
        if (p.out) continue;
        const legal = game.getLegalActions(p.id);
        if (legal.length === 0) continue;

        const brain = brains[p.id];
        const state = game.getState(p.id);
        const decision = brain.decide(state, p.id, legal);

        if (verbose && g === 0 && decision && decision.reason) {
          console.log(`[Verbose P${p.seat} (${p.level})] шаг ${safety}: действие`, decision.action, 'причина:', decision.reason);
        }

        const action = decision ? (decision.action || decision) : null;
        if (!action) continue;

        game.applyAction(p.id, action);
        acted = true;
        break;
      }
      if (!acted) break;
    }

    totalSteps += safety;
    if (safety >= MAX_STEPS) stuck++;

    if (!game.durak) {
      draws++;
    } else {
      const durakId = game.durak;
      durakCounts[durakId] = (durakCounts[durakId] || 0) + 1;

      const durakPlayerInfo = playersInfo.find(p => p.id === durakId);
      if (durakPlayerInfo) {
        durakByLevel[durakPlayerInfo.level] = (durakByLevel[durakPlayerInfo.level] || 0) + 1;
        durakBySeat[durakPlayerInfo.seat] = (durakBySeat[durakPlayerInfo.seat] || 0) + 1;
      }
    }
  } catch (e) {
    errors++;
    if (errors <= 3) {
      console.error(`Ошибка в партии ${g}:`, e.message);
      console.error(e.stack);
    }
  }
}

console.log('\n--- Результаты матча ---');
console.log(`Сыграно партий: ${numGames} (${numPlayers} игроков, колода ${deckSize})`);
console.log(`Ошибок движка: ${errors}`);
console.log(`Зависших (упёрлись в предохранитель): ${stuck}`);
console.log(`Ничьих: ${draws}`);
console.log(`Среднее число шагов на партию: ${(totalSteps / numGames).toFixed(1)}`);

console.log('\nДоля "дурака" (проигравших) по уровням ботов:');
const completedGames = numGames - draws;
for (const [lvl, count] of Object.entries(durakByLevel)) {
  const pct = completedGames > 0 ? ((count / completedGames) * 100).toFixed(1) : '0.0';
  console.log(`  - Уровень "${lvl}": ${count} раз (${pct}%)`);
}

console.log('\nДоля "дурака" по местам (seat):');
for (const [seat, count] of Object.entries(durakBySeat)) {
  const pct = completedGames > 0 ? ((count / completedGames) * 100).toFixed(1) : '0.0';
  console.log(`  - Место ${seat}: ${count} раз (${pct}%)`);
}

if (errors > 0 || stuck > 0) {
  process.exitCode = 1;
}
