#!/usr/bin/env bash
set -e

SRC="visual/index.html"
DEST="docs/index.html"

if [ "$1" = "--check" ]; then
  if cmp -s "$SRC" "$DEST"; then
    echo "Файлы $SRC и $DEST идентичны."
    exit 0
  else
    echo "::error::Файлы $SRC и $DEST различаются! Запустите npm run sync-client для синхронизации."
    exit 1
  fi
fi

if [ ! -f "$SRC" ]; then
  echo "::error::Исходный файл $SRC не найден!"
  exit 1
fi

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
echo "Успешно скопировано: $SRC -> $DEST ($(wc -c < "$DEST") байт)"
