// Сохранение лога законченной партии (issue #61).
//
// Зачем: в issue #61 логи интересных партий «постоянно теряются» — они живут только
// в памяти процесса (`game.log`) и в клиенте показываются последними 20 строками.
// Полноценная база данных здесь не нужна: партия — это маленький JSON, которого
// достаточно, чтобы приложить его к issue. Поэтому в момент окончания партии комната
// пишет один файл `logs/<дата>-<roomId>.json`.
//
// Свойства, важные для сервера:
//   * запись АСИНХРОННАЯ и никогда не роняет партию: любая ошибка ФС только логируется
//     в консоль (`console.warn`), игроки её не видят;
//   * каталог настраивается переменной окружения `DURAK_LOG_DIR` (по умолчанию `logs/`),
//     а полностью выключается `DURAK_SAVE_LOGS=0` — удобно для тестов и для хостинга
//     с read-only файловой системой;
//   * файл самодостаточен: правила партии, состав игроков, кто «дурак», полный текстовый
//     лог и сводка по столу — то, что нужно, чтобы разобрать жалобу на ход бота.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_LOG_DIR = process.env.DURAK_LOG_DIR || 'logs';

/** Выключено ли сохранение логов (DURAK_SAVE_LOGS=0/false/no). */
export function logsDisabled() {
  const v = String(process.env.DURAK_SAVE_LOGS ?? '1').toLowerCase();
  return v === '0' || v === 'false' || v === 'no' || v === 'off';
}

/** Безопасное для файловой системы имя: только латиница, цифры, дефис и подчёркивание. */
function safe(part, fallback = 'x') {
  const s = String(part ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return s || fallback;
}

/** Имя файла лога: 2024-05-01T12-00-00-000Z-ROOMID.json (сортируется по времени как строка). */
export function logFileName(roomId, when = new Date()) {
  const ts = when.toISOString().replace(/[:.]/g, '-');
  return `${ts}-${safe(roomId, 'room')}.json`;
}

/**
 * Готовит объект лога партии. Чистая функция: ничего не пишет и не мутирует game.
 * `game` — DurakGame (нужны поля phase, log, players, durak, rules, discard/talon).
 */
export function buildMatchLog(game, meta = {}) {
  const players = Array.isArray(game.players) ? game.players : [];
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    roomId: meta.roomId ?? null,
    label: meta.label ?? null,
    startedAt: meta.startedAt ?? null,
    finishedAt: Date.now(),
    rules: game.rules ? { ...game.rules } : null,
    trumpSuit: game.trumpSuit ?? null,
    players: players.map((p, i) => ({
      index: i,
      id: p.id,
      name: p.name,
      // Кто это был на самом деле: живой игрок, бот-заглушка при обрыве связи или бот-место.
      kind: (meta.seatKinds && meta.seatKinds[i]) || 'human',
      finishRank: p.finishRank ?? null,
      handCountAtEnd: Array.isArray(p.hand) ? p.hand.length : null,
    })),
    durak: game.durak ? { id: game.durak.id, name: game.durak.name } : null,
    phase: game.phase ?? null,
        log: Array.isArray(game.log) ? [...game.log] : [],
    // Only supplied by the server recorder after completion; never broadcast.
    diagnostic: meta.diagnostic ?? null,
  };
}

/**
 * Пишет лог партии в каталог. Возвращает путь к файлу или null, если сохранение
 * выключено/не удалось. Никогда не бросает.
 */
export async function saveMatchLog(game, meta = {}, dir = DEFAULT_LOG_DIR) {
  if (logsDisabled()) return null;
  try {
    const payload = buildMatchLog(game, meta);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, logFileName(meta.roomId, new Date()));
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    return file;
  } catch (err) {
    console.warn(`Не удалось сохранить лог партии: ${err && err.message ? err.message : err}`);
    return null;
  }
}

export default saveMatchLog;
