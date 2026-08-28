#!/usr/bin/env bash
# Полная проверка проекта внутри Codespace (или любой другой машины с Node 20).
#
# Зачем отдельный скрипт:
#   внешние инструменты (`gh codespace ssh -c <name> -- '<команда>'`, обвязки
#   агентов и т.п.) выполняют команду в НЕИЗВЕСТНОМ рабочем каталоге — как
#   правило это домашний каталог `/home/node`, а не `/workspaces/durakProekt`.
#   Из-за этого `npm run smoke` падает с `ENOENT ... /home/node/package.json`.
#   Скрипт сам определяет корень репозитория, поэтому его можно запускать
#   откуда угодно, одной строкой без `cd`:
#
#     bash /workspaces/durakProekt/scripts/codespace-check.sh
#
# Что проверяется (то же, что и в .github/workflows/ci.yml):
#   1. версии node/npm и наличие зависимостей;
#   2. движок и боты офлайн (playVerbose + simulate);
#   3. HTTP-эндпоинты сервера: /health, /, /visual;
#   4. smoke-тест полной партии по WebSocket (scripts/smoke.js).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8099}"

echo "=== 0. Окружение ==="
echo "Корень репозитория: $ROOT"
echo "Ветка: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(не git)')"
echo "node: $(node -v)"
echo "npm:  $(npm -v)"

if [ ! -d node_modules/ws ]; then
  echo "--- зависимостей нет, ставлю (npm install) ---"
  npm install --no-audit --no-fund
fi

echo
echo "=== 1. Движок — подробный лог одной партии ==="
node src/cli/playVerbose.js 2 24 | tail -12
node src/cli/playVerbose.js 4 36 | tail -12

echo
echo "=== 2. Движок — массовый прогон ==="
for cfg in "300 2 24" "200 3 36" "200 4 36" "150 6 52"; do
  echo "--- simulate $cfg ---"
  out="$(node src/cli/simulate.js $cfg)"
  echo "$out"
  echo "$out" | grep -q "Ошибок движка: 0" || {
    echo "ОШИБКА: simulate $cfg — ненулевое число ошибок движка" >&2
    exit 1
  }
done

echo
echo "=== 3. Сервер — /health, /, /visual (порт $PORT) ==="
PORT="$PORT" node server/index.js &
SERVER_PID=$!
cleanup() { kill "$SERVER_PID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null; then break; fi
  sleep 1
done

curl -sf "http://127.0.0.1:$PORT/health" | tee /tmp/durak-health.json
echo
grep -q '"ok":true' /tmp/durak-health.json || {
  echo "ОШИБКА: /health не вернул ok:true" >&2
  exit 1
}

for path in / /visual; do
  code="$(curl -s -o /tmp/durak-page.html -w '%{http_code}' "http://127.0.0.1:$PORT$path")"
  size="$(wc -c < /tmp/durak-page.html)"
  echo "$path -> HTTP $code, $size байт"
  [ "$code" = "200" ] || { echo "ОШИБКА: $path вернул $code" >&2; exit 1; }
  [ "$size" -gt 100 ] || { echo "ОШИБКА: $path вернул пустую страницу" >&2; exit 1; }
done

cleanup
trap - EXIT

echo
echo "=== 4. Smoke-тест (полная партия по WebSocket) ==="
npm --prefix "$ROOT" run smoke

echo
echo "=== ВСЁ ПРОШЛО УСПЕШНО ==="
