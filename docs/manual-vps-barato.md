# Manual barato — 1 VPS só (API + Postgres juntos)

Se o Droplet + Managed Database da DigitalOcean ficou caro: **não use banco gerenciado**.  
Rode **tudo num único VPS** com Docker Compose (API + Postgres + volume das sessões).

Isso é o caminho mais barato e continua válido para MontWhats.

---

## Quanto custa (ordem de grandeza)

| Opção | O que inclui | Faixa típica |
|-------|----------------|--------------|
| DO Droplet 2GB + Managed Postgres | 2 produtos | caro (~US$ 25–40/mês) |
| **1 VPS 2GB com Compose** | API + Postgres no mesmo servidor | **bem mais barato** |
| Hetzner / Contabo / OVH | VPS EU barato | frequentemente o menor custo |

**Recomendação de bolso:** Hetzner Cloud (CX22/CX23 ou equivalente ~2 vCPU / 4 GB) **ou** o Droplet **mais barato** da DO (1–2 GB) **sem** Managed Database.

Não use App Platform: disco efêmero quebra sessão WhatsApp.

---

## O que você vai criar

1. **Um** servidor Ubuntu (qualquer cloud barata)  
2. MontWhats com `docker compose` (api + postgres)  
3. Primeiro tenant  

Sem Databases gerenciado. Sem segundo serviço pago.

---

## Parte 1 — Criar a VPS

Em Hetzner / DigitalOcean / Vultr / etc.:

1. Ubuntu **24.04** ou **22.04**
2. **2 GB RAM** no mínimo (4 GB se quiser várias sessões WhatsApp)
3. Disco **20–40 GB** SSD
4. Anote o **IP**
5. Firewall: SSH `22` + API `3000` (e `80`/`443` se for domínio depois)

```bash
ssh root@IP_DA_VPS
```

---

## Parte 2 — Código no servidor

```bash
apt update && apt upgrade -y
apt install -y git curl ca-certificates

cd /opt
git clone URL_DO_SEU_REPOSITORIO montwhats
cd /opt/montwhats
```

(Se não tiver Git remoto, envie o projeto por `scp`/`tar` como no [manual-vps-do-zero.md](./manual-vps-do-zero.md).)

---

## Parte 3 — Configurar `.env` (modo barato)

```bash
cp .env.example .env
nano .env
```

Use o banco **interno** do Compose (não a URI da DigitalOcean):

```env
PORT=3000
MASTER_ADMIN_KEY=troque-por-uma-senha-bem-longa
SESSIONS_PATH=/data/sessions

# Postgres do próprio docker-compose.yml
DATABASE_URL=postgres://montwhats:montwhats@postgres:5432/montwhats
DATABASE_SSL=false

# Modo deploy barato (tudo no mesmo VPS)
DEPLOY_MODE=allinone
```

Salve (`Ctrl+O`, Enter, `Ctrl+X`).

> Em produção séria, troque a senha do Postgres no `docker-compose.yml` e na `DATABASE_URL`. No começo o default serve para validar.

---

## Parte 4 — Subir

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

O script detecta `DEPLOY_MODE=allinone` e sobe `docker-compose.yml` (api + postgres).

Teste:

```bash
curl http://127.0.0.1:3000/health
curl http://IP_DA_VPS:3000/health
```

---

## Parte 5 — Criar tenant

```bash
cd /opt/montwhats
set -a && source .env && set +a

curl -s -X POST http://127.0.0.1:3000/admin/tenants \
  -H "Content-Type: application/json" \
  -H "X-Master-Key: $MASTER_ADMIN_KEY" \
  -d '{"name":"Meu SaaS"}'
```

Guarde o `apiKey` (`mw_...`).

URL para o SaaS: `http://IP_DA_VPS:3000`

---

## Atualizar / logs

```bash
cd /opt/montwhats
git pull
./scripts/deploy.sh

docker compose ps
docker compose logs -f api
```

**Não** rode `docker compose down -v` — apaga banco e sessões WhatsApp.

---

## Quando voltar a gastar com Managed DB?

Só quando precisar de:

- backup gerenciado / alta disponibilidade  
- muitos Droplets/API separadas do banco  
- compliance mais rígido  

Até lá, **1 VPS all-in-one** é o suficiente e bem mais barato.

---

## Comparando os manuais

| Manual | Quando usar |
|--------|-------------|
| **[manual-vps-barato.md](./manual-vps-barato.md)** (este) | Orçamento apertado — 1 VPS |
| [manual-vps-do-zero.md](./manual-vps-do-zero.md) | Quer Managed Postgres na DO |
| [integracao-saas.md](./integracao-saas.md) | Conectar o SaaS |
