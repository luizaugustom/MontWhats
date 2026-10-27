# MontWhats

API WhatsApp multi-tenant self-hosted (Baileys) para conectar números aos seus SaaS, enviar e receber mensagens, com freios anti-ban no envio.

> Aviso: Baileys usa o protocolo do WhatsApp Web (não oficial). Banimentos e quebras de protocolo são possíveis. Os limites reduzem o risco, mas não eliminam.

## Documentação

| Documento | Para quem |
|-----------|-----------|
| [Manual VPS do zero](docs/manual-vps-do-zero.md) | **Comece aqui** — Droplet vazio até API no ar |
| [Deploy DigitalOcean](docs/deploy-digitalocean.md) | Resumo Droplet + Managed Postgres |
| [Manual do administrador](docs/manual-admin.md) | Criar tenants / API keys |
| [Integração SaaS](docs/integracao-saas.md) | Conectar o SaaS e **1 conexão por cliente** |

## Requisitos

- Docker + Docker Compose
- VPS (Droplet) com volume persistente — **não** use App Platform sozinha
- Em produção: Managed PostgreSQL (DigitalOcean) com `sslmode=require`

## Subir em produção (DigitalOcean)

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh          # gera .env
nano .env                    # cole DATABASE_URL do Managed DB + MASTER_ADMIN_KEY
./scripts/deploy.sh          # build + sobe API
```

Detalhes: [docs/deploy-digitalocean.md](docs/deploy-digitalocean.md)

## Subir local (teste)

```bash
cp .env.example .env
docker compose up -d --build
```

Healthcheck: `GET http://localhost:3000/health`

## Criar tenant + API key

```bash
curl -s -X POST http://localhost:3000/admin/tenants \
  -H "Content-Type: application/json" \
  -H "X-Master-Key: $MASTER_ADMIN_KEY" \
  -d '{"name":"Meu SaaS"}'
```

Guarde o `apiKey` — ele só aparece uma vez.

Ou:

```bash
MASTER_ADMIN_KEY=... npm run create-tenant -- "Meu SaaS"
```

## Fluxo de integração (SaaS)

Todas as rotas (exceto `/health` e `/admin/*`) usam `X-Api-Key`.

### 1. Webhook

```bash
curl -X PUT http://localhost:3000/webhook \
  -H "X-Api-Key: mw_..." \
  -H "Content-Type: application/json" \
  -d '{"url":"https://seu-saas.com/hooks/montwhats"}'
```

Valide `X-MontWhats-Signature: sha256=<hmac>` com o `webhookSecret`.

Eventos: `session.qr`, `session.connected`, `session.disconnected`, `session.risk`, `message.received`, `message.ack`.

### 2. Conectar número

```bash
# cria sessão
curl -X POST http://localhost:3000/sessions -H "X-Api-Key: mw_..."

# busca QR (JSON com data URL, ou Accept: image/png)
curl http://localhost:3000/sessions/<id>/qr -H "X-Api-Key: mw_..."
```

Mostre o QR no seu painel; o usuário escaneia no WhatsApp.

### 3. Enviar texto

```bash
curl -X POST http://localhost:3000/sessions/<id>/messages \
  -H "X-Api-Key: mw_..." \
  -H "Content-Type: application/json" \
  -d '{"to":"5511999999999","text":"Olá"}'
```

Respostas:

- `202` — `{ id, status: "queued", estimatedSendAt }`
- `429` — `{ error, message, retry_after }` — **respeite o retry_after**

### 4. Status da mensagem

```bash
curl http://localhost:3000/sessions/<id>/messages/<msgId> -H "X-Api-Key: mw_..."
```

## Anti-ban (resumo)

- Fila serial por número
- Jitter 3–15s entre envios
- Warmup diário (fase 1/2/3 conforme idade da sessão)
- Teto horário
- Presence `composing` antes do send
- Bloqueio de blast (texto idêntico)
- Limite de contatos frios em sequência no warmup
- Circuit breaker → status `restricted` + webhook `session.risk`

Defaults via env (ver `.env.example`).

## Desenvolvimento local

```bash
cp .env.example .env
# DATABASE_URL apontando para Postgres local
npm install
npm run migrate
npm run dev
```

## Estrutura

- `src/routes` — HTTP
- `src/baileys` — SessionManager
- `src/queue` — fila de envio
- `src/anti-ban` — limites / guards
- `src/webhook` — dispatcher HMAC
