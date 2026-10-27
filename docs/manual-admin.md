# Manual do administrador — MontWhats

Guia para subir a API e criar tenants (clientes/SaaS que vão usar a MontWhats).

**VPS do zero (recomendado):** siga [manual-vps-do-zero.md](./manual-vps-do-zero.md) — do Droplet vazio até a API no ar.

Resumo técnico também em [deploy-digitalocean.md](./deploy-digitalocean.md).

## 1. Pré-requisitos

- Docker + Docker Compose
- VPS (ou máquina) com disco persistente
- Porta `3000` livre (ou altere `PORT` no `.env`)
- Em produção: **Managed PostgreSQL** (DigitalOcean) com SSL

## 2. Subir o serviço

### Produção (VPS + banco DO) — recomendado

```bash
cd MontWhats
chmod +x scripts/deploy.sh
./scripts/deploy.sh   # cria .env na 1ª vez
nano .env             # DATABASE_URL do painel DO + MASTER_ADMIN_KEY
./scripts/deploy.sh
```

### Local (Postgres no Compose)

```bash
cd MontWhats
cp .env.example .env
# MASTER_ADMIN_KEY=...
docker compose up -d --build
```

Verifique:

```bash
curl http://localhost:3000/health
```

Resposta esperada:

```json
{ "ok": true, "service": "montwhats", "ts": "..." }
```

## 3. Criar um tenant

Cada SaaS (ou cada cliente grande) recebe **um tenant** + **uma API key**.

### Via HTTP

```bash
export MASTER_ADMIN_KEY="uma-senha-longa-e-aleatoria"
export API_URL="http://localhost:3000"

curl -s -X POST "$API_URL/admin/tenants" \
  -H "Content-Type: application/json" \
  -H "X-Master-Key: $MASTER_ADMIN_KEY" \
  -d '{"name":"SaaS Acme","label":"producao"}'
```

### Via script

```bash
MASTER_ADMIN_KEY="uma-senha-longa-e-aleatoria" \
API_URL="http://localhost:3000" \
npm run create-tenant -- "SaaS Acme"
```

### Resposta (guarde agora)

```json
{
  "tenant": {
    "id": "uuid-do-tenant",
    "name": "SaaS Acme",
    "createdAt": "..."
  },
  "apiKey": "mw_....",
  "webhookSecret": "hex...",
  "note": "Store apiKey now; it will not be shown again."
}
```

| Campo | Uso |
|-------|-----|
| `tenant.id` | Identificador interno |
| `apiKey` | Entregar ao SaaS — header `X-Api-Key` |
| `webhookSecret` | O SaaS usa para validar assinatura dos webhooks |

A `apiKey` **não é recuperável** depois (só o hash fica no banco). Se perder, crie outro tenant ou evolua o sistema para rotacionar keys.

## 4. O que entregar ao time do SaaS

1. URL base da API (ex.: `https://whats.seudominio.com`)
2. `apiKey` (`mw_...`)
3. `webhookSecret` (ou peça para eles cadastrarem o webhook e receberem o secret no `PUT /webhook`)
4. Link da documentação: [Integração SaaS](./integracao-saas.md)

## 5. Segurança

- Nunca exponha `MASTER_ADMIN_KEY` no frontend
- Use HTTPS em produção (nginx/Caddy na frente do container)
- Restrinja `/admin/*` por IP/firewall se possível
- Cada tenant só enxerga as próprias sessões (isolamento por API key)

## 6. Modelo mental

```
Você (admin)
  └─ cria Tenant + ApiKey
       └─ SaaS usa a ApiKey
            └─ cria N Sessions (1 session = 1 número WhatsApp / 1 cliente final)
```

- **Tenant** = o SaaS (ou conta parceira)
- **Session** = um número WhatsApp conectado (um “cliente” no painel do SaaS)

Criação de sessão e QR ficam a cargo do SaaS — veja [integracao-saas.md](./integracao-saas.md).
