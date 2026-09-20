#!/usr/bin/env bash
# Синхронизация локального клиента: visual/index.html -> docs/index.html.
#
# Зачем: играбельный клиент лежит в двух местах — `visual/index.html` (его отдаёт
# сервер по пути /visual) и `docs/index.html` (GitHub Pages). Они обязаны быть
# байт-в-байт одинаковыми, иначе на Pages уезжает устаревшая версия.
# Редактируем ВСЕГДА `visual/index.html`, а в `docs/` копируем этим скриптом.
#
# Использование:
#   npm run sync-client        # скопировать visual -> docs
#   npm run sync-client -- --check   # только проверить (ничего не менять)
#
# Тот же самый `cmp` выполняется в CI, так что забытая синхронизация валит сборку.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/visual/index.html"
DST="$ROOT/docs/index.html"

if [ ! -f "$SRC" ]; then
  echo "::error::Нет исходного файла клиента: $SRC" >&2
  exit 1
fi

MODE="sync"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
fi

if [ "$MODE" = "check" ]; then
  if cmp -s "$SRC" "$DST"; then
    echo "OK: visual/index.html и docs/index.html идентичны ($(wc -c < "$SRC") байт)."
    exit 0
  fi
  echo "::error::visual/index.html и docs/index.html РАЗОШЛИСЬ — выполните: npm run sync-client" >&2
  diff <(wc -c < "$SRC") <(wc -c < "$DST") || true
  exit 1
fi

if cmp -s "$SRC" "$DST"; then
  echo "Файлы уже идентичны, копировать нечего ($(wc -c < "$SRC") байт)."
  exit 0
fi

mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"
echo "Скопировано: visual/index.html -> docs/index.html ($(wc -c < "$DST") байт)."
