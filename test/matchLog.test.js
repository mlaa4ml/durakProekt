// Тесты сохранения лога законченной партии (issue #61, server/matchLog.js).
// Запуск: node --test test/
//
// Проверяем:
//   * buildMatchLog — чистая функция: собирает все важные поля и не мутирует игру;
//   * saveMatchLog — пишет валидный JSON в указанный каталог (каталог создаётся сам);
//   * DURAK_SAVE_LOGS=0 полностью выключает запись;
//   * ошибки записи не выбрасываются наружу (партия из-за логов упасть не должна).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildMatchLog, saveMatchLog, logFileName, logsDisabled } from '../server/matchLog.js';

function fakeGame() {
  return {
    phase: 'finished',
    trumpSuit: '♣',
    rules: { deckSize: 36, numPlayers: 2 },
    players: [
      { id: 'a', name: 'Аня', hand: [], finishRank: 1 },
      { id: 'b', name: 'Бот', hand: [{ rank: 6, suit: '♦' }], finishRank: null },
    ],
    durak: { id: 'b', name: 'Бот' },
    log: ['Аня ходит 6♦', 'Бот берёт карты'],
  };
}

test('buildMatchLog: собирает состав, дурака, правила и полный лог', () => {
  const g = fakeGame();
  const snapshot = JSON.stringify(g);
  const out = buildMatchLog(g, { roomId: 'ABCDE', label: 'тест', startedAt: 1000, seatKinds: ['human', 'bot'] });

  assert.equal(out.roomId, 'ABCDE');
  assert.equal(out.label, 'тест');
  assert.equal(out.startedAt, 1000);
  assert.equal(out.phase, 'finished');
  assert.deepEqual(out.rules, { deckSize: 36, numPlayers: 2 });
  assert.deepEqual(out.durak, { id: 'b', name: 'Бот' });
  assert.equal(out.players.length, 2);
  assert.equal(out.players[0].kind, 'human');
  assert.equal(out.players[1].kind, 'bot');
  assert.equal(out.players[1].handCountAtEnd, 1);
  assert.deepEqual(out.log, ['Аня ходит 6♦', 'Бот берёт карты']);

  // Лог — копия, а не ссылка: изменение результата не трогает партию.
  out.log.push('лишняя строка');
  assert.equal(JSON.stringify(g), snapshot, 'buildMatchLog не должен менять игру');
});

test('logFileName: безопасное имя и расширение .json', () => {
  const name = logFileName('AB/CD:E', new Date('2024-05-01T12:00:00.000Z'));
  assert.equal(name, '2024-05-01T12-00-00-000Z-ABCDE.json');
  assert.ok(!/[:/\\]/.test(name.replace(/\.json$/, '')), 'в имени не должно быть разделителей пути');
});

test('saveMatchLog: пишет читаемый JSON в указанный каталог', async () => {
  const dir = path.join(await mkdtemp(path.join(tmpdir(), 'durak-log-')), 'nested');
  const file = await saveMatchLog(fakeGame(), { roomId: 'ROOM1' }, dir);
  assert.ok(file, 'функция должна вернуть путь к файлу');

  const files = await readdir(dir);
  assert.equal(files.length, 1);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(parsed.roomId, 'ROOM1');
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.log, ['Аня ходит 6♦', 'Бот берёт карты']);
});

test('DURAK_SAVE_LOGS=0 — запись выключена', async () => {
  const prev = process.env.DURAK_SAVE_LOGS;
  process.env.DURAK_SAVE_LOGS = '0';
  try {
    assert.equal(logsDisabled(), true);
    const dir = await mkdtemp(path.join(tmpdir(), 'durak-log-off-'));
    assert.equal(await saveMatchLog(fakeGame(), { roomId: 'ROOM2' }, dir), null);
    assert.deepEqual(await readdir(dir), []);
  } finally {
    if (prev === undefined) delete process.env.DURAK_SAVE_LOGS;
    else process.env.DURAK_SAVE_LOGS = prev;
  }
});

test('ошибка записи не выбрасывается наружу', async () => {
  // Каталог внутри файла создать нельзя -> mkdir упадёт, но saveMatchLog вернёт null.
  const base = await mkdtemp(path.join(tmpdir(), 'durak-log-err-'));
  const asFile = path.join(base, 'file.json');
  await saveMatchLog(fakeGame(), { roomId: 'R' }, base); // создаёт что-то валидное рядом
  const bad = path.join(asFile, 'sub');
  const res = await saveMatchLog(fakeGame(), { roomId: 'R' }, bad === base ? '\0bad' : '\0bad');
  assert.equal(res, null);
});
