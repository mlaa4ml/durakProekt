// Точка входа сервера мультиплеера. Занимается только транспортом
// (HTTP + WebSocket, парсинг сообщений, лобби-рассылка) — вся игровая
// и комнатная логика в rooms.js, движок не тронут в src/game.js.
//
// Протокол (JSON-сообщения по WebSocket):
//
//   клиент -> сервер:
//     {type:'listRooms'}
//     {type:'createRoom', label, name, numPlayers, deckSize, throwInPolicy}
//     {type:'join',   roomId, name}
//     {type:'rejoin', roomId, playerId}
//     {type:'leave'}                    // только для ещё не начавшейся партии
//     {type:'fillWithBots'}             // только создатель комнаты: занять все свободные места
//                                        // ботами и сразу начать партию
//     {type:'addBot'}                   // только создатель: добавить одного бота на свободное место
//     {type:'removeBot', playerId}      // только создатель: убрать ранее добавленного бота
//     {type:'action', action: {...}}    // тот же формат, что и getLegalActions()
//
//   сервер -> клиент:
//     {type:'rooms', rooms: [...]}      // ответ на listRooms И проактивно при любом
//                                        // изменении списка комнат (создание/заполнение/
//                                        // старт/уборка) — присылается всем, кто сейчас
//                                        // не сидит ни в одной комнате
//     {type:'joined', playerId, roomId, seatsFilled, seatsTotal}
//     {type:'roomUpdate', roomId, label, numPlayers, hostPlayerId, seats:[{id,name,connected,botControlled}]}
//                                        // состав ещё не начавшейся комнаты — шлётся всем, кто
//                                        // уже сидит в ней, при любом изменении состава (join/addBot/leave).
//                                        // hostPlayerId — кто сейчас может звать ботов.
//     {type:'left'}
//     {type:'state', you, state, legalActions, players, log}
//     {type:'error', message}
//
// legalActions — результат getLegalActions(playerId) для конкретного получателя:
// пустой массив, если сейчас не его ход. Сервер сам решает, что игроку можно
// делать прямо сейчас — клиенту не нужно дублировать логику движка, чтобы
// понять, какие карты кликабельны.
//
// playerId, который сервер выдаёт при join/createRoom, нужно сохранить на
// клиенте (например в localStorage) и использовать в 'rejoin' при повторном
// подключении — это то, что позволяет вернуться в ту же партию после разрыва связи.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const PORT = process.env.PORT || 8080;
const manager = new RoomManager();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Немного статики поверх того же порта: в GitHub Codespaces это важно —
// пробрасывать нужно ровно один порт, и по нему доступны и WebSocket,
// и тестовый клиент, и офлайн-визуализация.
const STATIC_ROUTES = {
  '/': 'server/test-client.html',
  '/test-client.html': 'server/test-client.html',
  '/visual': 'docs/index.html',
  '/visual/': 'docs/index.html',
};

// Сокеты, которые сейчас не сидят ни в одной комнате — им рассылаем
// обновления списка комнат (лобби).
const lobbySockets = new Set();

const httpServer = createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = normalize(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  } catch {
    pathname = '/';
  }

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
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(`Не удалось прочитать ${route}: ${e.message}`);
    }
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Durak multiplayer server работает. Тестовый клиент — на "/", визуализация — на "/visual".');
});

const wss = new WebSocketServer({ server: httpServer });

manager.on('changed', () => {
  const payload = { type: 'rooms', rooms: manager.listOpen() };
  for (const socket of lobbySockets) send(socket, payload);
});

wss.on('connection', (socket) => {
  lobbySockets.add(socket);

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return send(socket, { type: 'error', message: 'Некорректный JSON' });
    }

    try {
      handleMessage(socket, msg);
    } catch (e) {
      send(socket, { type: 'error', message: e.message });
    }
  });

  socket.on('close', () => {
    lobbySockets.delete(socket);
    if (socket.roomId && socket.playerId) {
      const room = manager.get(socket.roomId);
      if (room) room.handleDisconnect(socket.playerId);
    }
  });
});

function handleMessage(socket, msg) {
  if (!msg || typeof msg.type !== 'string') {
    return send(socket, { type: 'error', message: 'Не указан type сообщения' });
  }

  switch (msg.type) {
    case 'listRooms': {
      send(socket, { type: 'rooms', rooms: manager.listOpen() });
      return;
    }

    case 'createRoom': {
      const { label, name, numPlayers, deckSize, throwInPolicy } = msg;
      const room = manager.createRoom({
        label: label && String(label).trim() ? String(label).trim() : null,
        numPlayers: numPlayers || 2,
        ruleOverrides: {
          deckSize: deckSize || 24,
          throwInPolicy: throwInPolicy || 'all',
        },
      });
      const seat = room.addPlayer(name, socket);
      lobbySockets.delete(socket);
      send(socket, {
        type: 'joined',
        playerId: seat.playerId,
        roomId: room.roomId,
        seatsFilled: room.seats.length,
        seatsTotal: room.numPlayers,
      });
      return;
    }

    case 'join': {
      const { roomId, name } = msg;
      if (!roomId) return send(socket, { type: 'error', message: 'Не указан roomId' });
      const room = manager.get(roomId);
      if (!room) return send(socket, { type: 'error', message: 'Комната не найдена — возможно, код неверный или она уже закрылась' });
      const seat = room.addPlayer(name, socket);
      lobbySockets.delete(socket);
      send(socket, {
        type: 'joined',
        playerId: seat.playerId,
        roomId,
        seatsFilled: room.seats.length,
        seatsTotal: room.numPlayers,
      });
      return;
    }

    case 'rejoin': {
      const { roomId, playerId } = msg;
      const room = manager.get(roomId);
      if (!room) return send(socket, { type: 'error', message: 'Комната не найдена' });
      const seat = room.reconnect(playerId, socket);
      if (!seat) return send(socket, { type: 'error', message: 'Игрок не найден в этой комнате' });
      lobbySockets.delete(socket);
      send(socket, {
        type: 'joined',
        playerId,
        roomId,
        seatsFilled: room.seats.length,
        seatsTotal: room.numPlayers,
      });
      if (room.isStarted) room.broadcastState();
      return;
    }

    case 'leave': {
      if (!socket.roomId) return send(socket, { type: 'error', message: 'Вы не в комнате' });
      const room = manager.get(socket.roomId);
      const roomId = socket.roomId;
      const playerId = socket.playerId;
      socket.roomId = null;
      socket.playerId = null;
      if (!room) {
        lobbySockets.add(socket);
        return send(socket, { type: 'left' });
      }
      const ok = room.leave(playerId);
      if (!ok) {
        // Партия уже началась — восстановим привязку, выйти нельзя, можно только отключиться.
        socket.roomId = roomId;
        socket.playerId = playerId;
        return send(socket, { type: 'error', message: 'Нельзя покинуть уже начатую партию — можно только отключиться' });
      }
      lobbySockets.add(socket);
      send(socket, { type: 'left' });
      return;
    }

    case 'addBot': {
      if (!socket.roomId) return send(socket, { type: 'error', message: 'Вы не в комнате' });
      const room = manager.get(socket.roomId);
      if (!room) return send(socket, { type: 'error', message: 'Комната не найдена' });
      if (room.hostPlayerId !== socket.playerId) return send(socket, { type: 'error', message: 'Добавлять ботов может только создатель комнаты' });
      room.addBot();
      return;
    }

    case 'removeBot': {
      if (!socket.roomId) return send(socket, { type: 'error', message: 'Вы не в комнате' });
      const room = manager.get(socket.roomId);
      if (!room) return send(socket, { type: 'error', message: 'Комната не найдена' });
      if (room.hostPlayerId !== socket.playerId) return send(socket, { type: 'error', message: 'Убирать ботов может только создатель комнаты' });
      room.removeBot(msg.playerId);
      return;
    }

    case 'fillWithBots': {
      if (!socket.roomId) return send(socket, { type: 'error', message: 'Вы не в комнате' });
      const room = manager.get(socket.roomId);
      if (!room) return send(socket, { type: 'error', message: 'Комната не найдена' });
      if (room.hostPlayerId !== socket.playerId) return send(socket, { type: 'error', message: 'Заполнить ботами и начать может только создатель комнаты' });
      room.fillWithBots();
      return;
    }

    case 'action': {
      const room = manager.get(socket.roomId);
      if (!room) return send(socket, { type: 'error', message: 'Вы не в комнате — сначала join/createRoom' });
      room.applyAction(socket.playerId, msg.action);
      return;
    }

    default:
      send(socket, { type: 'error', message: `Неизвестный type: ${msg.type}` });
  }
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

httpServer.listen(PORT, () => {
  console.log(`Durak WS-сервер слушает порт ${PORT}`);
});
