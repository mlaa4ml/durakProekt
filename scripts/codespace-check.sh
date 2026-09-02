#!/usr/bin/env bash
# Проверка проекта внутри Codespace одной командой.
#
# Зачем отдельный скрипт: команды, которые агент/CLI прокидывает в Codespace
# через `gh codespace ssh`, стартуют в домашнем каталоге (/home/node), а не в
# /workspaces/<repo>, и первая команда сессии иногда теряется (см. раздел 7b
# CODESPACES.md). Из-за этого `npm run smoke` падает с
# "Could not read package.json: /home/node/package.json", хотя проект цел.
#
# Скрипт сам находит корень репозитория относительно собственного пути,
# поэтому его можно вызывать откуда угодно и любым способом:
#
#   bash /workspaces/durakProekt/scripts/codespace-check.sh
#   npm --prefix /workspaces/durakProekt run codespace:check
#
# Код выхода: 0 — все проверки прошли, 1 — что-то сломалось.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}" || exit 1

echo "=== Проверка проекта в Codespace ==="
echo "Корень репозитория: ${ROOT_DIR}"
echo "Текущий каталог до перехода мог быть любым — скрипт перешёл сам."
echo

FAILED=0

step() {
  local title="$1"; shift
  echo "--- ${title}"
  if "$@"; then
    echo "    OK: ${title}"
  else
    echo "    FAIL: ${title}"
    FAILED=1
  fi
  echo
}

echo "node: $(node -v 2>&1)"
echo "npm:  $(npm -v 2>&1)"
if command -v git >/dev/null 2>&1; then
  echo "ветка: $(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD 2>&1)"
  echo "коммит: $(git -C "${ROOT_DIR}" log --oneline -1 2>&1)"
fi
echo

if [ ! -d "${ROOT_DIR}/node_modules/ws" ]; then
  echo "--- node_modules/ws не найден, ставлю зависимости"
  npm --prefix "${ROOT_DIR}" install || FAILED=1
  echo
fi

step "движок: simulate.js 200 партий, 2 игрока, колода 24" \
  node "${ROOT_DIR}/src/cli/simulate.js" 200 2 24

step "движок: simulate.js 100 партий, 4 игрока, колода 36" \
  node "${ROOT_DIR}/src/cli/simulate.js" 100 4 36

step "подробный лог партии: playVerbose.js 2 24" \
  bash -c "node '${ROOT_DIR}/src/cli/playVerbose.js' 2 24 | tail -5"

step "полный smoke-тест (движок + HTTP + WebSocket)" \
  npm --prefix "${ROOT_DIR}" run smoke

if [ "${FAILED}" -eq 0 ]; then
  echo "=== ИТОГ: все проверки пройдены ==="
else
  echo "=== ИТОГ: есть провалившиеся проверки (см. FAIL выше) ==="
fi

exit "${FAILED}"
