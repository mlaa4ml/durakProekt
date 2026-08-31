#!/usr/bin/env bash
set -e

# Определяем корень репозитория независимо от того, откуда запущен скрипт
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "=== Корень репозитория: $REPO_ROOT ==="
cd "$REPO_ROOT"

echo "Node version: $(node -v)"
echo "NPM version: $(npm -v)"
echo "Git branch: $(git rev-parse --abbrev-ref HEAD)"
echo "Git commit: $(git log -1 --oneline)"

if [ ! -d "node_modules" ]; then
  echo "Устанавливаем зависимости..."
  npm install
fi

echo ""
echo "1. Запуск simulate.js (200 партий, 2 игрока, колода 24)..."
node src/cli/simulate.js 200 2 24

echo ""
echo "2. Запуск simulate.js (100 партий, 4 игрока, колода 36)..."
node src/cli/simulate.js 100 4 36

echo ""
echo "3. Запуск playVerbose.js..."
node src/cli/playVerbose.js 2 24

echo ""
echo "4. Запуск smoke.js (движок + HTTP + WebSocket)..."
node scripts/smoke.js

echo ""
echo "=== ИТОГ: все проверки успешно пройдены ==="
