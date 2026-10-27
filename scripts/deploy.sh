#!/usr/bin/env bash
# Deploy MontWhats na VPS
#   DEPLOY_MODE=allinone  → api + postgres no mesmo servidor
#   DEPLOY_MODE=managed   → só api + banco externo (DigitalOcean Managed)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE=".env"

# Lê KEY=value do .env sem `source` (evita quebrar com & na DATABASE_URL)
env_get() {
  local key="$1"
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
  if [ -z "$line" ]; then
    printf ""
    return
  fi
  local val="${line#*=}"
  if [[ "$val" == \"*\" ]]; then
    val="${val:1:${#val}-2}"
  elif [[ "$val" == \'*\' ]]; then
    val="${val:1:${#val}-2}"
  fi
  printf '%s' "$val"
}

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
  echo
  echo "Edite o .env (use ASPAS na DATABASE_URL se tiver & ou caracteres especiais):"
  echo
  echo "  MANAGED DB (DigitalOcean) — recomendado se o banco já é da DO:"
  echo '    DEPLOY_MODE=managed'
  echo '    DATABASE_URL="postgresql://doadmin:SENHA@HOST:25060/montwhats?sslmode=require"'
  echo "    DATABASE_SSL=true"
  echo "    MASTER_ADMIN_KEY=sua-senha-forte"
  echo
  echo "  BARATO (1 VPS, api+postgres):"
  echo "    DEPLOY_MODE=allinone"
  echo "    DATABASE_URL=postgres://montwhats:montwhats@postgres:5432/montwhats"
  echo "    DATABASE_SSL=false"
  echo
  echo "Depois: ./scripts/deploy.sh"
  exit 1
fi

MASTER_ADMIN_KEY="$(env_get MASTER_ADMIN_KEY)"
DATABASE_URL="$(env_get DATABASE_URL)"
DEPLOY_MODE="$(env_get DEPLOY_MODE)"
PORT="$(env_get PORT)"
DOMAIN="$(env_get DOMAIN)"
PORT="${PORT:-3000}"

if [ -z "$MASTER_ADMIN_KEY" ] || [ "$MASTER_ADMIN_KEY" = "change-me-to-a-long-random-secret" ]; then
  echo "ERRO: defina MASTER_ADMIN_KEY forte no .env antes do deploy."
  exit 1
fi

MODE="${DEPLOY_MODE:-}"
if [ -z "$MODE" ]; then
  if [[ "$DATABASE_URL" == *"@postgres:"* ]] || [[ "$DATABASE_URL" == *"@postgres/"* ]]; then
    MODE="allinone"
  else
    MODE="managed"
  fi
fi

if [ "$MODE" = "allinone" ]; then
  COMPOSE_FILE="docker-compose.yml"
  echo "==> Modo BARATO (allinone): API + Postgres no mesmo VPS"
else
  COMPOSE_FILE="docker-compose.prod.yml"
  echo "==> Modo MANAGED: só API + banco externo"
  if [ -z "$DATABASE_URL" ] || [[ "$DATABASE_URL" == *"@postgres:5432"* ]]; then
    echo "ERRO: no modo managed, configure DATABASE_URL do Managed Postgres no .env"
    echo "      Use aspas, ex.:"
    echo '      DATABASE_URL="postgresql://doadmin:SENHA@HOST:25060/montwhats?sslmode=require"'
    exit 1
  fi
  if [[ "$DATABASE_URL" != *"ondigitalocean.com"* ]] && [[ "$DATABASE_URL" != *"sslmode"* ]] && [[ "$(env_get DATABASE_SSL)" != "true" ]]; then
    echo "AVISO: DATABASE_SSL=true é recomendado para Managed Postgres."
  fi
fi

PROFILES=()
if [ -n "${DOMAIN:-}" ] && [ "$MODE" = "managed" ]; then
  PROFILES+=(--profile https)
  echo "==> HTTPS via Caddy para DOMAIN=$DOMAIN"
elif [ -n "${DOMAIN:-}" ] && [ "$MODE" = "allinone" ]; then
  echo "AVISO: DOMAIN/Caddy no modo allinone ainda não está no docker-compose.yml."
  echo "       Use a porta ${PORT} ou coloque um proxy na frente."
fi

echo "==> Build e start ($COMPOSE_FILE)"
# --env-file do Compose lê & corretamente (não use source no shell)
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "${PROFILES[@]}" up -d --build

echo "==> Aguardando health..."
for i in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "OK: API saudável em http://127.0.0.1:${PORT}/health"
    break
  fi
  if [ "$i" -eq 40 ]; then
    echo "Falha no healthcheck. Logs:"
    docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail 80
    exit 1
  fi
  sleep 2
done

echo
echo "Próximos passos:"
echo "  curl -s -X POST http://127.0.0.1:${PORT}/admin/tenants \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -H \"X-Master-Key: \$MASTER_ADMIN_KEY\" \\"
echo "    -d '{\"name\":\"Meu SaaS\"}'"
echo
echo "  URL: http://IP_DA_VPS:${PORT}"
