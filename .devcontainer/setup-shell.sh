#!/usr/bin/env bash
# Делает так, чтобы команды, прилетающие в codespace извне
# (агент / `gh codespace ssh -- <команда>`), выполнялись в корне репозитория,
# а не в /home/node.
#
# Зачем (issue #15): внешняя обвязка запускает команду в домашнем каталоге,
# поэтому `npm run smoke` падает с
#   npm error enoent Could not read package.json: open '/home/node/package.json'
# а `node src/cli/simulate.js ...` — с
#   Error: Cannot find module '/home/node/src/cli/simulate.js'
# хотя проект полностью цел в /workspaces/durakProekt.
#
# Что делает скрипт: идемпотентно вставляет НЕБОЛЬШОЙ блок в начало
# ~/.bashrc (и в ~/.profile, ~/.zshrc, если они есть). Блок:
#   * переходит в корень репозитория, если текущий каталог — домашний;
#   * добавляет удобные alias'ы durak-check / durak-smoke.
#
# Важно: блок вставляется именно в НАЧАЛО ~/.bashrc, потому что стандартный
# debian-овский ~/.bashrc в первых строках делает
#   case $- in *i*) ;; *) return;; esac
# то есть для НЕинтерактивных сессий (а это как раз `ssh host "команда"`)
# выходит сразу. Bash читает ~/.bashrc в неинтерактивном режиме, когда его
# запускает sshd, — этим и пользуемся.
#
# Скрипт ничего не печатает в stdout при обычной работе (кроме коротких
# сообщений в лог создания контейнера) и никогда не завершается ошибкой,
# чтобы не ломать создание codespace.

set -u

log() { echo "[setup-shell] $*"; }

ROOT_DIR="${1:-}"
if [ -z "${ROOT_DIR}" ]; then
  ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

if [ ! -f "${ROOT_DIR}/package.json" ]; then
  log "не нашёл package.json в ${ROOT_DIR} — пропускаю"
  exit 0
fi

BEGIN_MARK="# >>> durakProekt codespace defaults (issue #15) >>>"
END_MARK="# <<< durakProekt codespace defaults (issue #15) <<<"

BLOCK="$(cat <<EOF
${BEGIN_MARK}
# Автоматически добавлено .devcontainer/setup-shell.sh.
# Внешние команды (агент, gh codespace ssh) стартуют в \$HOME — уводим их
# в корень репозитория, чтобы работали npm run smoke / node src/cli/*.
DURAK_ROOT="${ROOT_DIR}"
if [ -d "\$DURAK_ROOT" ]; then
  export DURAK_ROOT
  if [ "\$PWD" = "\$HOME" ]; then
    cd "\$DURAK_ROOT" 2>/dev/null || true
  fi
  alias durak-check='bash "\$DURAK_ROOT/scripts/codespace-check.sh"'
  alias durak-smoke='npm --prefix "\$DURAK_ROOT" run smoke'
  alias durak-root='cd "\$DURAK_ROOT"'
fi
${END_MARK}
EOF
)"

install_block() {
  local file="$1"
  [ -e "${file}" ] || : > "${file}"

  if grep -qF "${BEGIN_MARK}" "${file}" 2>/dev/null; then
    # блок уже есть — обновим его (путь мог измениться)
    local tmp
    tmp="$(mktemp)" || return 0
    awk -v b="${BEGIN_MARK}" -v e="${END_MARK}" '
      $0 == b { skip = 1 }
      skip != 1 { print }
      $0 == e { skip = 0 }
    ' "${file}" > "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 0; }
    { printf '%s\n\n' "${BLOCK}"; cat "${tmp}"; } > "${file}" 2>/dev/null || true
    rm -f "${tmp}"
    log "обновил блок в ${file}"
    return 0
  fi

  local tmp
  tmp="$(mktemp)" || return 0
  { printf '%s\n\n' "${BLOCK}"; cat "${file}"; } > "${tmp}" 2>/dev/null || { rm -f "${tmp}"; return 0; }
  cat "${tmp}" > "${file}" 2>/dev/null || true
  rm -f "${tmp}"
  log "добавил блок в ${file}"
}

install_block "${HOME}/.bashrc"

# Логин-шеллы (ssh -l, bash -l) читают ~/.profile.
install_block "${HOME}/.profile"

# zsh есть в образе devcontainers/javascript-node и может быть шеллом по умолчанию.
if [ -f "${HOME}/.zshrc" ]; then
  install_block "${HOME}/.zshrc"
fi

log "корень репозитория: ${ROOT_DIR}"
exit 0
