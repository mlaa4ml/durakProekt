// Автоматическая проверка "проект вообще запускается" — то же, что ручной
// чек-лист из CODESPACES.md (раздел 7), только без кликов в браузере.
//
// Запуск:  npm run smoke        (или node scripts/smoke.js)
// Порт:    SMOKE_PORT=8099      (по умолчанию 8099, чтобы не конфликтовать
//                                с `npm run server` на 8080)
//
// Что делает:
//   1) прогоняет движок ботами на нескольких конфигурациях (ошибок должно быть 0);
//   2) поднимает server/index.js отдельным процессом;
//   3) дёргает /health, / (тестовый клиент), /visual (визуализация);
//   4) поднимает два WebSocket-клиента, создаёт комнату, входит вторым игроком
//      и доигрывает партию до конца ботами через настоящий сетевой протокол;
//   5) печатает итог и возвращает код выхода 1, если что-то сломалось.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { DurakGame } from '../src/game.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT || 8099);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}`;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (predicate, timeoutMs, everyMs = 100) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(everyMs);
  }
  return false;
};

// ---------- 1. Движок ----------

function runEngine(numPlayers, deckSize, numGames) {
  let errors = 0;
  let stuck = 0;
  let finished = 0;
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
      if (safety >= MAX_STEPS) stuck++;
      if (game.phase === 'finished') finished++;
    } catch (e) {
      errors++;
      if (errors <= 2) console.error('   ошибка партии:', e.message);
    }
  }
  return { errors, stuck, finished, numGames };
}

function stepEngine() {
  console.log('\n[1/3] Движок и боты (офлайн)');
  const configs = [
    [2, 24, 200],
    [3, 36, 100],
    [4, 36, 100],
    [6, 52, 50],
  ];
  for (const [p, d, n] of configs) {
    const r = runEngine(p, d, n);
    check(
      `движок ${p} игроков / колода ${d} (${n} партий)`,
      r.errors === 0,
      `ошибок: ${r.errors}, зависших: ${r.stuck}, доигранных: ${r.finished}`
    );
  }
}

// ---------- 2. Сервер: HTTP ----------

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${HTTP}/health`);
      if (res.ok) return await res.json();
    } catch {
      /* сервер ещё не поднялся */
    }
    await sleep(250);
  }
  return null;
}

async function stepHttp() {
  console.log('\n[2/3] HTTP-эндпоинты сервера');
  const health = await waitForServer();
  check('/health отвечает', !!health && health.ok === true, health ? JSON.stringify(health) : 'нет ответа');

  for (const [path, marker] of [['/', 'тестовый клиент'], ['/visual', 'визуализация']]) {
    try {
      const res = await fetch(HTTP + path);
      const body = await res.text();
      check(
        `${path} отдаёт HTML (${marker})`,
        res.status === 200 && body.length > 1000,
        `статус ${res.status}, ${body.length} байт`
      );
    } catch (e) {
      check(`${path} отдаёт HTML (${marker})`, false, e.message);
    }
  }
}

// ---------- 3. Сервер: настоящая партия по WebSocket ----------

function openClient(name) {
  const ws = new WebSocket(WS_URL);
  const client = { ws, name, playerId: null, roomId: null, finished: false, sawState: false, error: null };
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'joined') {
      client.playerId = msg.playerId;
      client.roomId = msg.roomId;
    } else if (msg.type === 'error') {
      client.error = msg.message;
    } else if (msg.type === 'state') {
      client.sawState = true;
      client.lastState = msg.state;
      if (msg.state && msg.state.finished) {
        client.finished = true;
        client.durak = msg.state.durak;
        return;
      }
      if (Array.isArray(msg.legalActions) && msg.legalActions.length > 0) {
        const action = simpleBotDecide(msg.state, msg.you, msg.legalActions);
        if (action) ws.send(JSON.stringify({ type: 'action', action }));
      }
    }
  });
  return client;
}

async function stepWs() {
  console.log('\n[3/3] Партия на двоих через WebSocket');
  const a = openClient('smoke-A');
  await new Promise((resolve, reject) => {
    a.ws.once('open', resolve);
    a.ws.once('error', reject);
  });
  a.ws.send(JSON.stringify({ type: 'createRoom', label: 'smoke', name: 'smoke-A', numPlayers: 2, deckSize: 24 }));
  const created = await waitFor(() => a.roomId, 5000);
  if (!check('комната создана', created, a.roomId ? `код ${a.roomId}` : a.error || 'нет ответа joined')) return;

  const b = openClient('smoke-B');
  await new Promise((resolve, reject) => {
    b.ws.once('open', resolve);
    b.ws.once('error', reject);
  });
  b.ws.send(JSON.stringify({ type: 'join', roomId: a.roomId, name: 'smoke-B' }));
  const joined = await waitFor(() => b.playerId, 5000);
  check('второй игрок вошёл по коду', joined, b.playerId || b.error || 'нет ответа joined');

  const started = await waitFor(() => a.sawState && b.sawState, 5000);
  check('партия стартовала (оба получили state)', started);

  const done = await waitFor(() => a.finished || b.finished, 60000);
  check('партия доиграна до конца', done, done ? `дурак: ${a.durak || b.durak || 'ничья'}` : 'таймаут 60 с');

  a.ws.close();
  b.ws.close();
}

// ---------- main ----------

let server;
try {
  stepEngine();

  console.log(`\nЗапускаю сервер: PORT=${PORT} node server/index.js`);
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.stdout.write('  [server] ' + d.toString()));
  server.stderr.on('data', (d) => process.stderr.write('  [server:err] ' + d.toString()));

  await stepHttp();
  await stepWs();
} catch (e) {
  check('smoke-тест выполнился без исключений', false, e.message);
  console.error(e.stack);
} finally {
  if (server) server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== Итог: ${results.length - failed.length}/${results.length} проверок пройдено ===`);
if (failed.length) {
  console.log('Провалились:');
  for (const f of failed) console.log(` - ${f.name}${f.detail ? ' (' + f.detail + ')' : ''}`);
}
process.exit(failed.length ? 1 : 0);
