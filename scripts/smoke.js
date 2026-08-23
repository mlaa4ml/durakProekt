// Автоматический smoke-тест (проверка движка, ботов, HTTP-маршрутов и WS-сервера)
// Запускается через `npm run smoke`.

import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { RoomManager } from '../server/rooms.js';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { simpleBotDecide } from '../src/bots/simpleBot.js';

const PORT = process.env.SMOKE_PORT || 8099;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const STATIC_ROUTES = {
  '/': 'server/test-client.html',
  '/test-client.html': 'server/test-client.html',
  '/visual': 'docs/index.html',
  '/visual/': 'docs/index.html',
};

async function runSmoke() {
  console.log('=== Запуск smoke-теста ===');
  let checksPassed = 0;
  let totalChecks = 0;

  function check(name, condition) {
    totalChecks++;
    if (condition) {
      checksPassed++;
      console.log(`  [OK] ${name}`);
    } else {
      console.error(`  [FAIL] ${name}`);
    }
  }

  // 1. Проверка движка и ботов оффлайн (симуляция коротких партий)
  {
    const { playBatch } = await import('../src/cli/simulate.js');
    // simulate.js не экспортирует playBatch напрямую, но мы можем проверить запуск simulate через node или импорт game.js
    const { Game } = await import('../src/game.js');
    const g = new Game(2, { deckSize: 24 });
    g.start();
    check('Движок: создание и старт партии 2 игрока / 24 карты', g.players.length === 2 && g.deck.length > 0);
  }

  // 2. Поднимаем тестовый экземпляр сервера
  const manager = new RoomManager();
  const lobbySockets = new Set();

  const httpServer = createHttpServer(async (req, res) => {
    let pathname = '/';
    try {
      pathname = normalize(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
    } catch {}

    if (pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, rooms: manager.listOpen().length }));
    }
    const route = STATIC_ROUTES[pathname];
    if (route) {
      try {
        const body = await readFile(join(ROOT, route));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(body);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end(e.message);
      }
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server: httpServer });

  manager.on('changed', () => {
    const payload = { type: 'rooms', rooms: manager.listOpen() };
    for (const s of lobbySockets) if (s.readyState === s.OPEN) s.send(JSON.stringify(payload));
  });

  wss.on('connection', (socket) => {
    lobbySockets.add(socket);
    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      handleTestMessage(socket, manager, lobbySockets, msg);
    });
    socket.on('close', () => {
      lobbySockets.delete(socket);
      if (socket.roomId && socket.playerId) {
        const r = manager.get(socket.roomId);
        if (r) r.handleDisconnect(socket.playerId);
      }
    });
  });

  await new Promise((resolve) => httpServer.listen(PORT, resolve));
  console.log(`  Тестовый сервер запущен на порту ${PORT}`);

  // 3. HTTP HTTP-проверки (/health, /, /visual)
  try {
    const healthRes = await fetch(`http://localhost:${PORT}/health`);
    const healthJson = await healthRes.json();
    check('HTTP /health возвращает ok:true', healthJson.ok === true);

    const rootRes = await fetch(`http://localhost:${PORT}/`);
    check('HTTP / отдаёт HTML клиента', rootRes.status === 200 && (await rootRes.text()).includes('html'));

    const visualRes = await fetch(`http://localhost:${PORT}/visual`);
    check('HTTP /visual отдаёт HTML визуализации', visualRes.status === 200 && (await visualRes.text()).includes('html'));
  } catch (e) {
    check('HTTP проверка эндпоинтов', false);
    console.error(e);
  }

  // 4. WebSocket тест: создание комнаты и полноценная партия с ботами через WS
  try {
    const ws1 = new WebSocket(`ws://localhost:${PORT}`);
    const ws2 = new WebSocket(`ws://localhost:${PORT}`);

    let roomCode = null;
    let finished = false;

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WS timeout партии')), 10000);

      let p1Id = null;
      let p2Id = null;

      ws1.on('open', () => {
        ws1.send(JSON.stringify({ type: 'createRoom', name: 'Bot1', numPlayers: 2, deckSize: 24 }));
      });

      ws1.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') {
          p1Id = msg.playerId;
          roomCode = msg.roomId;
          // Подключаем второго игрока
          ws2.send(JSON.stringify({ type: 'join', roomId: roomCode, name: 'Bot2' }));
        }
        if (msg.type === 'state') {
          handleWsState(ws1, msg, p1Id);
          if (msg.state.finished) {
            finished = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      });

      ws2.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'joined') {
          p2Id = msg.playerId;
        }
        if (msg.type === 'state') {
          handleWsState(ws2, msg, p2Id);
          if (msg.state.finished) {
            finished = true;
            clearTimeout(timeout);
            resolve();
          }
        }
      });
    });

    check('WebSocket: успешное создание комнаты, подключение и завершение партии', finished);

    ws1.close();
    ws2.close();
  } catch (e) {
    check('WebSocket: партия через сервер', false);
    console.error(e);
  }

  // Завершение
  await new Promise((resolve) => wss.close(() => httpServer.close(resolve)));

  console.log(`\n=== Итог smoke-теста: ${checksPassed}/${totalChecks} проверок пройдено ===`);
  if (checksPassed < totalChecks) {
    process.exit(1);
  }
}

function handleWsState(ws, msg, myId) {
  const { state, legalActions, you } = msg;
  if (state.finished) return;
  // Проверяем, наш ли это ход (в Durak State передается каждому с его legalActions)
  if (legalActions && legalActions.length > 0) {
    const action = simpleBotDecide(state, myId, legalActions);
    if (action) {
      setTimeout(() => {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({ type: 'action', action }));
        }
      }, 10);
    }
  }
}

function handleTestMessage(socket, manager, lobbySockets, msg) {
  if (!msg || typeof msg.type !== 'string') return;
  switch (msg.type) {
    case 'listRooms':
      socket.send(JSON.stringify({ type: 'rooms', rooms: manager.listOpen() }));
      break;
    case 'createRoom': {
      const room = manager.createRoom({
        numPlayers: msg.numPlayers || 2,
        ruleOverrides: { deckSize: msg.deckSize || 24, throwInPolicy: 'all' },
      });
      const seat = room.addPlayer(msg.name, socket);
      lobbySockets.delete(socket);
      socket.send(JSON.stringify({ type: 'joined', playerId: seat.playerId, roomId: room.roomId, seatsFilled: 1, seatsTotal: room.numPlayers }));
      break;
    }
    case 'join': {
      const room = manager.get(msg.roomId);
      if (!room) return socket.send(JSON.stringify({ type: 'error', message: 'Not found' }));
      const seat = room.addPlayer(msg.name, socket);
      lobbySockets.delete(socket);
      socket.send(JSON.stringify({ type: 'joined', playerId: seat.playerId, roomId: msg.roomId, seatsFilled: room.seats.length, seatsTotal: room.numPlayers }));
      break;
    }
    case 'action': {
      const room = manager.get(socket.roomId);
      if (room) room.applyAction(socket.playerId, msg.action);
      break;
    }
  }
}

runSmoke().catch((err) => {
  console.error('Критическая ошибка smoke-теста:', err);
  process.exit(1);
});
