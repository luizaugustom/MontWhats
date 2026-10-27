#!/usr/bin/env bash
# Deploy simples da MontWhats na VPS (DigitalOcean Droplet)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"

echo "==> MontWhats deploy"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker não encontrado. Instalando Docker Engine..."
  curl -fsSL https://get.docker.com | sh
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl enable --now docker || true
  fi
  if [ "$(id -u)" -ne 0 ]; then
    sudo usermod -aG docker "$USER" || true
    echo "AVISO: saia e entre de novo no SSH (ou rode: newgrp docker) para usar docker sem sudo."
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERRO: 'docker compose' não disponível. Instale Docker Compose v2."
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  cp .env.example "$ENV_FILE"
  echo "Arquivo .env criado a partir de .env.example"
  echo "Edite .env agora:"
  echo "  - MASTER_ADMIN_KEY"
  echo "  - DATABASE_URL (connection string do Managed Postgres DO, com ?sslmode=require)"
  echo "  - DATABASE_SSL=true"
  echo "Depois rode de novo: ./scripts/deploy.sh"
  exit 1
fi

# shellcheck disable=SC1091
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

if [ -z "${DATABASE_URL:-}" ] || [[ "$DATABASE_URL" == *"@postgres:5432"* ]]; then
  echo "ERRO: configure DATABASE_URL no .env com o banco da DigitalOcean."
  echo "Exemplo:"
  echo '  DATABASE_URL=postgresql://doadmin:SENHA@host:25060/defaultdb?sslmode=require'
  echo "  DATABASE_SSL=true"
  exit 1
fi

if [ -z "${MASTER_ADMIN_KEY:-}" ] || [ "$MASTER_ADMIN_KEY" = "change-me-to-a-long-random-secret" ]; then
  echo "ERRO: defina MASTER_ADMIN_KEY forte no .env antes do deploy."
  exit 1
fi

PROFILES=()
if [ -n "${DOMAIN:-}" ]; then
  PROFILES+=(--profile https)
  echo "==> HTTPS via Caddy para DOMAIN=$DOMAIN"
fi

echo "==> Build e start"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "${PROFILES[@]}" up -d --build

echo "==> Aguardando health..."
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT:-3000}/health" >/dev/null 2>&1; then
    echo "OK: API saudável em http://127.0.0.1:${PORT:-3000}/health"
    break
  fi
  if [ "$i" -eq 40 ]; then
    echo "Falha no healthcheck. Logs:"
    docker compose -f "$COMPOSE_FILE" logs api --tail 80
    exit 1
  fi
  sleep 2
done

echo
echo "Próximos passos:"
echo "  1) Liberar IP deste Droplet no Trusted Sources do Managed Database"
echo "  2) Firewall DO: abrir 3000 (ou 80/443 se DOMAIN estiver setado)"
echo "  3) Criar tenant:"
echo "     curl -s -X POST http://127.0.0.1:${PORT:-3000}/admin/tenants \\"
echo "       -H \"Content-Type: application/json\" \\"
echo "       -H \"X-Master-Key: \$MASTER_ADMIN_KEY\" \\"
echo "       -d '{\"name\":\"Meu SaaS\"}'"
echo
if [ -n "${DOMAIN:-}" ]; then
  echo "  URL pública: https://${DOMAIN}"
else
  echo "  URL pública: http://IP_DO_DROPLET:${PORT:-3000}"
fi
