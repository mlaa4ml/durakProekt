#!/usr/bin/env bash
# ensure-sshd.sh: гарантирует запуск OpenSSH сервера в Codespace
# Вызывается через onCreateCommand и postStartCommand в devcontainer.json.
# Работает идемпотентно, без set -e, всегда завершается с exit 0,
# чтобы не блокировать создание/запуск Codespace при любых сбоях SSH.

echo "[ensure-sshd] Проверка sshd..."

# 1. Проверяем/устанавливаем openssh-server, если отсутствует
if ! command -v sshd >/dev/null 2>&1; then
    echo "[ensure-sshd] sshd не найден, устанавливаем openssh-server..."
    if command -v apt-get >/dev/null 2>&1; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update && apt-get install -y openssh-server || echo "[ensure-sshd] Не удалось установить openssh-server через apt-get"
    fi
fi

# 2. Убеждаемся, что директории для sshd существуют
mkdir -p /run/sshd
chmod 0755 /run/sshd

# 3. Генерируем хост-ключи, если их нет
if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
    echo "[ensure-sshd] Генерация SSH host-ключей..."
    ssh-keygen -A || true
fi

# 4. Пробуем запустить sshd через стандартный скрипт фичи, если он есть
if [ -x /usr/local/share/ssh-init.sh ]; then
    echo "[ensure-sshd] Запуск через /usr/local/share/ssh-init.sh..."
    /usr/local/share/ssh-init.sh || true
fi

# 5. Пробуем systemctl / service / прямой запуск /usr/sbin/sshd
if command -v service >/dev/null 2>&1; then
    service ssh start || true
elif command -v systemctl >/dev/null 2>&1; then
    systemctl start ssh || true
fi

if ! pgrep -x sshd >/dev/null 2>&1; then
    echo "[ensure-sshd] Запуск /usr/sbin/sshd напрямую..."
    /usr/sbin/sshd || true
fi

if pgrep -x sshd >/dev/null 2>&1; then
    echo "[ensure-sshd] Успех: sshd запущен."
else
    echo "[ensure-sshd] Предупреждение: sshd не запущен, но продолжаем без ошибки."
fi

exit 0
