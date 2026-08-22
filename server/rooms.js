// Комнаты мультиплеера: держат DurakGame как авторитетное состояние партии,
// привязку игроков к сокетам, подмену ботом при разрыве связи, и — в этой
// версии — лобби со списком комнат и автоочистку пустых/заброшенных комнат.
// Никакого HTTP/WS здесь нет — это чисто игровая/сессионная логика,
// index.js занимается только транспортом.

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DurakGame } from '../src/game.js';
import { simpleBotDecide } from '../src/bots/simpleBot.js';

// Через сколько мс после разрыва связи игрока в УЖЕ ИДУЩЕЙ партии начинает
// подменять бот. Настраивается через переменную окружения — удобно для тестов.
const DISCONNECT_BOT_TAKEOVER_MS = Number(process.env.BOT_TAKEOVER_MS) || 30000;
const BOT_MOVE_DELAY_MS = Number(process.env.BOT_MOVE_DELAY_MS) || 700;

// Через сколько мс полностью опустевшая комната (никто не подключён) удаляется.
// Не начавшиеся комнаты пустеют мгновенно, если создатель вышел/отключился —
// удалятся при следующей проверке. Для начавшихся и брошенных партий даём
// небольшой запас на случай кратковременных разрывов сети у зрителей.
const ROOM_CLEANUP_GRACE_MS = Number(process.env.ROOM_CLEANUP_GRACE_MS) || 60000;
const CLEANUP_SWEEP_INTERVAL_MS = Number(process.env.ROOM_SWEEP_INTERVAL_MS) || 10000;

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без символов, которые легко перепутать

function generateRoomCode(existingIds) {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join('');
  } while (existingIds.has(code));
  return code;
}

// Чей сейчас ход, по той же логике, что используется в интерактивном клиенте
// (visual/index.html) — там она проверена на ~780 симулированных партиях.
function currentTurnIndex(game) {
  if (game.phase === 'finished') return -1;
  if (game.phase === 'defender-to-act') return game.defenderIndex;
  if (game.phase === 'need-attack') {
    if (game.throwInQueue.length === 0) return -1;
    return game.throwInQueue[game.throwInQueuePos];
  }
  return -1;
}

export class Room extends EventEmitter {
  constructor(roomId, options) {
    super();
    this.roomId = roomId;
    this.label = options.label || null;
    this.numPlayers = options.numPlayers;
    this.ruleOverrides = options.ruleOverrides || {};
    this.createdAt = Date.now();
    // seats[i].playerId соответствует game.players[i].id — порядок мест
    // фиксируется в момент старта партии и больше не меняется.
    this.seats = [];
    this.game = null;
    this.botTimer = null;
    // Момент, с которого комната полностью опустела (0 подключённых сокетов),
    // либо null, если сейчас кто-то подключён. Используется RoomManager для очистки.
    this.emptySince = Date.now(); // только что создана, пока в ней никого
  }

  get isFull() {
    return this.seats.length >= this.numPlayers;
  }

  get isStarted() {
    return this.game !== null;
  }

  get isFinished() {
    return this.game !== null && this.game.phase === 'finished';
  }

  summary() {
    return {
      roomId: this.roomId,
      label: this.label,
      numPlayers: this.numPlayers,
      seatsFilled: this.seats.length,
      started: this.isStarted,
      finished: this.isFinished,
      deckSize: this.ruleOverrides.deckSize,
      throwInPolicy: this.ruleOverrides.throwInPolicy,
      createdAt: this.createdAt,
    };
  }

  addPlayer(name, socket) {
    if (this.isFull) throw new Error('Комната уже заполнена');
    if (this.isStarted) throw new Error('Партия в этой комнате уже началась');
    const playerId = randomUUID();
    const seat = {
      playerId,
      name: name && name.trim() ? name.trim() : `Игрок ${this.seats.length + 1}`,
      socket,
      connected: true,
      botControlled: false,
      botTakeoverTimer: null,
    };
    this.seats.push(seat);
    socket.playerId = playerId;
    socket.roomId = this.roomId;
    this._touchEmptyState();
    if (this.isFull) this._startGame();
    this.emit('changed');
    return seat;
  }

  reconnect(playerId, socket) {
    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return null;
    seat.socket = socket;
    seat.connected = true;
    seat.botControlled = false;
    if (seat.botTakeoverTimer) {
      clearTimeout(seat.botTakeoverTimer);
      seat.botTakeoverTimer = null;
    }
    // На момент реконнекта мог быть уже запланирован ход бота за это же место
    // (this.botTimer — общий для комнаты таймер хода бота). Если не отменить его
    // здесь, бот может сходить одновременно с вернувшимся игроком за одно и то же
    // место — второе из двух действий сервер отклонит как недопустимое.
    clearTimeout(this.botTimer);
    this.botTimer = null;
    socket.playerId = playerId;
    socket.roomId = this.roomId;
    if (this.game) this._log(`${seat.name} снова на связи.`);
    this._touchEmptyState();
    this.emit('changed');
    return seat;
  }

  // Уйти из ещё не начавшейся партии — место освобождается для других.
  // Для уже идущей партии полноценный выход не поддержан (это разрыв связи,
  // см. handleDisconnect) — там нельзя просто вынуть игрока, не сломав индексацию мест.
  leave(playerId) {
    if (this.isStarted) return false;
    const before = this.seats.length;
    this.seats = this.seats.filter((s) => s.playerId !== playerId);
    if (this.seats.length === before) return false;
    this._touchEmptyState();
    this.emit('changed');
    return true;
  }

  handleDisconnect(playerId) {
    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) return;
    if (!this.isStarted) {
      // Партия не началась — реконнект тут не нужен, просто освобождаем место.
      this.leave(playerId);
      return;
    }
    seat.connected = false;
    this._touchEmptyState();
    if (this.game.phase === 'finished') {
      this.emit('changed');
      return;
    }
    this._log(`${seat.name} отключился — если не вернётся за ${Math.round(DISCONNECT_BOT_TAKEOVER_MS / 1000)} с, за него временно будет ходить бот.`);
    this.broadcastState();
    seat.botTakeoverTimer = setTimeout(() => {
      seat.botControlled = true;
      this._log(`${seat.name} долго не отвечает — временно ходит бот вместо него.`);
      this._maybeAutoPlay();
      this.broadcastState();
    }, DISCONNECT_BOT_TAKEOVER_MS);
  }

  applyAction(playerId, action) {
    if (!this.game) throw new Error('Партия ещё не началась');
    const seat = this.seats.find((s) => s.playerId === playerId);
    if (!seat) throw new Error('Вы не участник этой комнаты');
    const wasFinished = this.game.phase === 'finished';
    // game.applyAction сам бросит понятную ошибку, если действие недопустимо —
    // этого достаточно, чтобы отсечь читерский или рассинхронизированный клиент.
    this.game.applyAction(playerId, action);
    this.broadcastState();
    this._maybeAutoPlay();
    if (!wasFinished && this.game.phase === 'finished') this.emit('changed');
  }

  _startGame() {
    const playerDefs = this.seats.map((s) => ({ id: s.playerId, name: s.name }));
    this.game = new DurakGame(playerDefs, { ...this.ruleOverrides, numPlayers: this.numPlayers });
    this.broadcastState();
    this._maybeAutoPlay();
  }

  // Если сейчас ход отключённого (и уже переданного боту) игрока — доигрываем за него.
  _maybeAutoPlay() {
    if (!this.game || this.game.phase === 'finished') return;
    const turnIdx = currentTurnIndex(this.game);
    if (turnIdx === -1) return;
    const seat = this.seats[turnIdx];
    if (!seat || !seat.botControlled) return;

    clearTimeout(this.botTimer);
    this.botTimer = setTimeout(() => {
      if (!this.game || this.game.phase === 'finished') return;
      const legal = this.game.getLegalActions(seat.playerId);
      if (legal.length === 0) return;
      const stateForBot = {
        trumpSuit: this.game.trumpSuit,
        players: this.game.players.map((p) => ({ id: p.id, hand: p.hand })),
      };
      const action = simpleBotDecide(stateForBot, seat.playerId, legal);
      if (action) this.game.applyAction(seat.playerId, action);
      this.broadcastState();
      this._maybeAutoPlay();
    }, BOT_MOVE_DELAY_MS);
  }

  _log(msg) {
    if (this.game) this.game.log.push(msg);
  }

  // Обновляет emptySince: null, если хоть один сокет подключён, иначе — момент,
  // с которого комната опустела (если ещё не было отмечено).
  _touchEmptyState() {
    const anyConnected = this.seats.some((s) => s.connected);
    if (anyConnected) {
      this.emptySince = null;
    } else if (this.emptySince === null) {
      this.emptySince = Date.now();
    }
  }

  isCleanable(graceMs) {
    return this.emptySince !== null && Date.now() - this.emptySince >= graceMs;
  }

  // Останавливает все таймеры комнаты — вызывается перед удалением,
  // чтобы не оставлять висящие setTimeout на брошенную партию.
  destroy() {
    clearTimeout(this.botTimer);
    for (const seat of this.seats) clearTimeout(seat.botTakeoverTimer);
  }

  broadcastState() {
    if (!this.game) return;
    const rosterInfo = this.seats.map((s) => ({
      id: s.playerId,
      name: s.name,
      connected: s.connected,
      botControlled: s.botControlled,
    }));
    for (const seat of this.seats) {
      this._send(seat.socket, {
        type: 'state',
        you: seat.playerId,
        state: this.game.getState(seat.playerId), // маскирует чужие карты
        legalActions: this.game.getLegalActions(seat.playerId), // пусто, если сейчас не ваш ход
        players: rosterInfo,
        log: this.game.log.slice(-20),
      });
    }
  }

  _send(socket, payload) {
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
}

export class RoomManager extends EventEmitter {
  constructor() {
    super();
    this.rooms = new Map();
    this.sweepTimer = setInterval(() => this._sweep(), CLEANUP_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.(); // не мешает процессу завершиться в тестах/скриптах
  }

  createRoom(options) {
    const roomId = generateRoomCode(this.rooms);
    const room = new Room(roomId, options);
    room.on('changed', () => this.emit('changed'));
    this.rooms.set(roomId, room);
    // Не эмитим 'changed' здесь: index.js всегда сразу вызывает addPlayer()
    // для создателя, и его собственный emit('changed') уже отразит финальное
    // состояние комнаты (с заполненным местом) одним broadcast'ом, а не двумя.
    return room;
  }

  get(roomId) {
    return this.rooms.get(roomId);
  }

  // Список комнат для лобби. Отдаём и уже начавшиеся/завершённые — клиент
  // сам решает, что показывать активным для входа (started === false).
  listOpen(limit = 50) {
    return Array.from(this.rooms.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((r) => r.summary());
  }

  _sweep() {
    let changed = false;
    for (const [id, room] of this.rooms) {
      if (room.isCleanable(ROOM_CLEANUP_GRACE_MS)) {
        room.destroy();
        this.rooms.delete(id);
        changed = true;
      }
    }
    if (changed) this.emit('changed');
  }

  stopSweeping() {
    clearInterval(this.sweepTimer);
  }
}
