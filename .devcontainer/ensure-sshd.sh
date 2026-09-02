#!/usr/bin/env bash
# Гарантирует, что в контейнере есть и работает SSH-сервер.
#
# Зачем (issue #13): автоматическая обвязка (агент/инструмент
# `run_in_codespace`) подключается к codespace по SSH и ждёт демон всего
# ~60 секунд после статуса Available. Если фича
# `ghcr.io/devcontainers/features/sshd:1` по какой-то причине не доехала
# (частичная сборка, prebuild, пересоздание/резюме контейнера) либо демон
# просто не стартовал после stop→start, команды падают с
#   "error getting ssh server details: failed to start SSH server:
#    Please check if an SSH server is installed in the container."
#
# Скрипт идемпотентный и намеренно НЕ падает: любая ошибка здесь не должна
# ломать создание codespace (обычная работа в VS Code/веб-терминале от SSH
# не зависит).

set -u

log() { echo "[ensure-sshd] $*"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo > /dev/null 2>&1; then
    SUDO="sudo"
  else
    log "нет root и нет sudo — пропускаю"
    exit 0
  fi
fi

# 1. Установить openssh-server, если фича sshd не отработала.
if ! command -v sshd > /dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
  log "sshd не найден — ставлю openssh-server"
  export DEBIAN_FRONTEND=noninteractive
  $SUDO apt-get update -y > /dev/null 2>&1 \
    && $SUDO apt-get install -y --no-install-recommends openssh-server > /dev/null 2>&1 \
    || log "не удалось установить openssh-server (продолжаю)"
else
  log "sshd уже установлен"
fi

if ! command -v sshd > /dev/null 2>&1 && [ ! -x /usr/sbin/sshd ]; then
  log "sshd по-прежнему недоступен — выходим без ошибки"
  exit 0
fi

# 2. Минимальная конфигурация: фича sshd слушает 2222, свою настройку не трогаем.
$SUDO mkdir -p /var/run/sshd /run/sshd 2> /dev/null || true
if [ ! -f /etc/ssh/sshd_config ] && [ -f /etc/ssh/sshd_config.orig ]; then
  $SUDO cp /etc/ssh/sshd_config.orig /etc/ssh/sshd_config || true
fi

# Хост-ключи (после пересоздания контейнера их может не быть).
if ! ls /etc/ssh/ssh_host_*_key > /dev/null 2>&1; then
  log "генерирую host-ключи"
  $SUDO ssh-keygen -A > /dev/null 2>&1 || true
fi

# 3. Запустить демон, если он ещё не слушает.
if pgrep -x sshd > /dev/null 2>&1; then
  log "sshd уже запущен"
  exit 0
fi

log "стартую sshd"
if [ -x /usr/local/share/ssh-init.sh ]; then
  # скрипт фичи devcontainers/features/sshd
  $SUDO /usr/local/share/ssh-init.sh > /dev/null 2>&1 || true
fi

if ! pgrep -x sshd > /dev/null 2>&1; then
  $SUDO service ssh start > /dev/null 2>&1 \
    || $SUDO /usr/sbin/sshd > /dev/null 2>&1 \
    || log "не удалось стартовать sshd (продолжаю)"
fi

if pgrep -x sshd > /dev/null 2>&1; then
  log "sshd работает"
else
  log "sshd НЕ работает — используйте веб-терминал Codespaces или CI (см. CODESPACES.md, раздел 7b)"
fi

exit 0
