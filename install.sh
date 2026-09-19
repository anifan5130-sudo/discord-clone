#!/usr/bin/env bash
# Установка Voxa на чистый VPS (Ubuntu/Debian). Запуск: sudo bash install.sh
set -euo pipefail
cd "$(dirname "$0")"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите через sudo: sudo bash install.sh"; exit 1
fi

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  green "Устанавливаю Docker…"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Нужен плагин docker compose (apt install docker-compose-plugin)"; exit 1
fi

# 2. Настройки
if [ ! -f .env ]; then
  read -rp "Домен (например voice.example.com): " DOMAIN
  [ -n "$DOMAIN" ] || { echo "Домен обязателен — без HTTPS браузер не даст доступ к микрофону"; exit 1; }
  read -rp "Название сервера [Voxa]: " SERVER_NAME
  SERVER_NAME=${SERVER_NAME:-Voxa}
  read -rp "Пароль для входа (Enter — без пароля): " SERVER_PASSWORD
  ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)
  LK_KEY="API$(openssl rand -hex 6)"
  LK_SECRET=$(openssl rand -base64 48 | tr -d '/+=' | cut -c1-48)
  cat > .env <<EOF
DOMAIN=$DOMAIN
SERVER_NAME=$SERVER_NAME
SERVER_PASSWORD=$SERVER_PASSWORD
ADMIN_PASSWORD=$ADMIN_PASSWORD
LIVEKIT_API_KEY=$LK_KEY
LIVEKIT_API_SECRET=$LK_SECRET
MAX_ROOMS=100
EOF
  chmod 600 .env
  green "Создан .env"
fi
set -a; . ./.env; set +a

if [ ! -f livekit.yaml ]; then
  sed -e "s/__KEY__/$LIVEKIT_API_KEY/g" -e "s/__SECRET__/$LIVEKIT_API_SECRET/g" -e "s/__DOMAIN__/$DOMAIN/g" \
    livekit.yaml.example > livekit.yaml
  chmod 600 livekit.yaml
  green "Создан livekit.yaml"
fi
mkdir -p data

# 3. Файрвол
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  green "Открываю порты в ufw…"
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw allow 7881/tcp
  ufw allow 50000:60000/udp
else
  yellow "ufw не активен. Если у хостера есть свой файрвол, откройте: 80/tcp, 443/tcp, 7881/tcp, 50000-60000/udp"
fi

# 4. Запуск
green "Собираю и запускаю…"
docker compose up -d --build

echo
green "Готово! Откройте https://$DOMAIN"
echo "Пароль администратора: $ADMIN_PASSWORD  (введите его в поле пароля при входе)"
echo "Логи: docker compose logs -f"
