#!/usr/bin/env bash
# Универсальная обёртка: выполняет ЛЮБУЮ команду из корня репозитория.
#
# Зачем (issue #15): команды, отправленные в codespace извне (агент,
# `gh codespace ssh -- ...`), стартуют в /home/node, а первая команда строки
# иногда «съедается» сессией. Из-за этого `cd /workspaces/durakProekt &&
# npm run smoke` превращается в `npm run smoke` из домашнего каталога.
#
# Этот скрипт сам находит корень репозитория относительно собственного пути,
# переходит в него и запускает то, что ему передали. Вызывать можно откуда
# угодно и по абсолютному пути — тогда ни рабочий каталог, ни потерянный
# `cd` уже ничего не ломают:
#
#   bash /workspaces/durakProekt/scripts/codespace-run.sh npm run smoke
#   bash /workspaces/durakProekt/scripts/codespace-run.sh node src/cli/simulate.js 1000 2 24
#   bash /workspaces/durakProekt/scripts/codespace-run.sh          # без аргументов -> codespace-check.sh
#
# Код выхода — код выхода запущенной команды.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}" || exit 1

if [ "$#" -eq 0 ]; then
  exec bash "${ROOT_DIR}/scripts/codespace-check.sh"
fi

echo "[codespace-run] каталог: ${ROOT_DIR}"
echo "[codespace-run] команда: $*"
echo

exec "$@"
