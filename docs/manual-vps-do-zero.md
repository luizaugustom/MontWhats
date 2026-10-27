# Manual do zero — VPS DigitalOcean até a MontWhats rodando

Este guia assume que você **ainda não tem nada**: sem Docker, sem código no servidor, sem banco configurado. Siga na ordem.

Tempo estimado: 20–40 minutos.

---

## O que você vai criar

1. Um **banco Postgres gerenciado** (DigitalOcean Databases)  
2. Um **Droplet** (VPS Ubuntu)  
3. A **MontWhats** rodando em Docker nesse Droplet  
4. O **primeiro tenant** (API key para o seu SaaS)

---

## Parte A — No navegador (painel DigitalOcean)

### A1. Criar o Managed Database

1. Entre em [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Menu **Databases** → **Create Database Cluster**
3. Escolha:
   - Engine: **PostgreSQL** (16 se disponível)
   - Região: anote (ex.: `nyc3`, `nyc1`, `sfo3`) — **use a mesma depois no Droplet**
   - Plano: o mais barato serve no começo
4. Crie o cluster e espere ficar **Online**
5. Abra o banco → aba **Connection Details**
6. Em **Connection parameters** / **Connection string**, copie a URI. Deve parecer com:

```text
postgresql://doadmin:SENHA_LONGA@host-xxxxx.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

7. Guarde essa string num bloco de notas (você vai colar no servidor).

> Ainda **não** feche o painel do banco — depois vamos liberar o IP do Droplet em **Trusted Sources**.

---

### A2. Criar o Droplet (VPS vazia)

1. Menu **Droplets** → **Create Droplet**
2. Escolha:
   - Imagem: **Ubuntu 24.04 LTS** (ou 22.04)
   - Região: **a mesma do banco**
   - Plano: mínimo **2 GB RAM** (Basic)
   - Autenticação: **SSH key** (recomendado) ou senha
3. Crie o Droplet e espere o IP público aparecer (ex.: `167.99.x.x`)
4. Anote o **IP**

### A3. Firewall (recomendado)

Menu **Networking** → **Firewalls** → Create:

| Tipo | Porta | Origem |
|------|-------|--------|
| SSH | 22 | Seu IP (ou All se estiver testando) |
| Custom | 3000 | All (API sem domínio) |
| HTTP | 80 | All (só se for usar domínio + HTTPS) |
| HTTPS | 443 | All (só se for usar domínio + HTTPS) |

Aplique o firewall ao Droplet.

Se não quiser firewall agora, pode pular e abrir depois com `ufw` no servidor.

---

## Parte B — Entrar na VPS

No seu computador:

```bash
ssh root@IP_DO_DROPLET
```

(Se criou usuário com key, use esse usuário e `sudo` quando preciso.)

Você deve ver o prompt do Ubuntu. A partir daqui **tudo é no servidor**.

---

## Parte C — Preparar o servidor (primeira vez)

### C1. Atualizar o sistema

```bash
apt update && apt upgrade -y
apt install -y git curl ca-certificates
```

### C2. Trazer o código da MontWhats

**Opção 1 — Git (melhor)**

```bash
cd /opt
git clone URL_DO_SEU_REPOSITORIO montwhats
cd /opt/montwhats
```

**Opção 2 — Sem Git ainda**

No seu PC, compacte o projeto (sem `node_modules` e sem `dist`) e envie:

```bash
# no seu PC
cd "Área de trabalho/www"
tar --exclude=node_modules --exclude=dist --exclude=.git -czf montwhats.tar.gz MontWhats
scp montwhats.tar.gz root@IP_DO_DROPLET:/opt/
```

No servidor:

```bash
cd /opt
mkdir -p montwhats
tar -xzf montwhats.tar.gz -C montwhats --strip-components=1
cd /opt/montwhats
```

---

## Parte D — Configurar o `.env` (banco DO + senha admin)

```bash
cd /opt/montwhats
cp .env.example .env
nano .env
```

Deixe **pelo menos** assim (cole a connection string real do painel):

```env
PORT=3000
MASTER_ADMIN_KEY=troque-por-uma-senha-bem-longa-e-aleatoria
SESSIONS_PATH=/data/sessions

DATABASE_URL=postgresql://doadmin:SENHA@host-xxxxx.db.ondigitalocean.com:25060/defaultdb?sslmode=require
DATABASE_SSL=true
```

Salve: `Ctrl+O`, Enter, `Ctrl+X`.

> **Importante:** `MASTER_ADMIN_KEY` não é a API key do SaaS. É a senha **sua** para criar tenants. Não use a padrão do exemplo.

---

## Parte E — Liberar o Droplet no banco

1. Volte ao painel → **Databases** → seu cluster  
2. **Settings** → **Trusted Sources** → **Edit**  
3. Adicione o **Droplet** (pelo nome) **ou** o IP público do Droplet  
4. Salve  

Sem isso a API sobe e falha ao conectar no Postgres.

---

## Parte F — Subir a MontWhats

```bash
cd /opt/montwhats
chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

O script vai:

1. Instalar Docker (se ainda não existir)  
2. Validar o `.env`  
3. Buildar a imagem  
4. Subir o container da API  
5. Rodar as migrations no banco DO  
6. Testar `/health`

Se pedir para sair e entrar de novo no SSH por causa do grupo `docker`:

```bash
exit
ssh root@IP_DO_DROPLET
cd /opt/montwhats
./scripts/deploy.sh
```

### Conferir se está no ar

```bash
curl http://127.0.0.1:3000/health
```

Esperado:

```json
{"ok":true,"service":"montwhats","ts":"..."}
```

Do seu computador:

```bash
curl http://IP_DO_DROPLET:3000/health
```

Ver containers:

```bash
docker ps
docker compose -f docker-compose.prod.yml logs -f api
```

(`Ctrl+C` para sair dos logs.)

---

## Parte G — Criar o primeiro tenant (API key)

Ainda no servidor:

```bash
cd /opt/montwhats
set -a && source .env && set +a

curl -s -X POST http://127.0.0.1:3000/admin/tenants \
  -H "Content-Type: application/json" \
  -H "X-Master-Key: $MASTER_ADMIN_KEY" \
  -d '{"name":"Meu SaaS"}'
```

A resposta traz:

- `apiKey` → `mw_...` (**guarde agora**; não aparece de novo)  
- `webhookSecret`  
- `tenant.id`

Entregue ao seu SaaS:

- URL base: `http://IP_DO_DROPLET:3000`  
- Header: `X-Api-Key: mw_...`  

Guia do SaaS: [integracao-saas.md](./integracao-saas.md)

---

## Parte H — (Opcional) Domínio + HTTPS

Só faça se já tiver um domínio.

1. No DNS do domínio, crie registro **A**:
   - Nome: `whats` (ou `@`)
   - Valor: IP do Droplet
2. No servidor:

```bash
nano /opt/montwhats/.env
```

Adicione:

```env
DOMAIN=whats.seudominio.com
```

3. Firewall: portas **80** e **443** abertas  
4. Redeploy:

```bash
cd /opt/montwhats
./scripts/deploy.sh
```

5. Teste:

```bash
curl https://whats.seudominio.com/health
```

A URL pública passa a ser `https://whats.seudominio.com`.

---

## Comandos do dia a dia

```bash
cd /opt/montwhats

# ver se está rodando
docker ps
curl http://127.0.0.1:3000/health

# logs
docker compose -f docker-compose.prod.yml logs -f api

# atualizar código (se usa git)
git pull
./scripts/deploy.sh

# reiniciar
docker compose -f docker-compose.prod.yml restart api

# parar
docker compose -f docker-compose.prod.yml down
```

> **Nunca** use `docker compose down -v` em produção: o `-v` apaga o volume das sessões WhatsApp e todo mundo precisa escanear QR de novo.

---

## Se der errado

| Problema | O que fazer |
|----------|-------------|
| `deploy.sh` reclama do `DATABASE_URL` | Cole a URI completa do painel DO com `?sslmode=require` |
| Migration / timeout no banco | Trusted Sources: IP do Droplet liberado? Mesma região? |
| `curl` externo não abre | Firewall DO / porta 3000 / security group |
| Docker “permission denied” | `newgrp docker` ou novo login SSH |
| Container reiniciando | `docker compose -f docker-compose.prod.yml logs api --tail 100` |
| Health OK mas SaaS não conecta | Teste a URL pública; confira `X-Api-Key` |

---

## Checklist final

- [ ] Managed Postgres Online  
- [ ] Droplet Ubuntu com IP anotado  
- [ ] Código em `/opt/montwhats`  
- [ ] `.env` com `DATABASE_URL`, `DATABASE_SSL=true`, `MASTER_ADMIN_KEY`  
- [ ] Droplet em Trusted Sources do banco  
- [ ] `./scripts/deploy.sh` concluiu  
- [ ] `/health` responde no IP  
- [ ] Tenant criado e `apiKey` guardada  

Pronto: a VPS que estava vazia agora hospeda a MontWhats ligada ao banco da DigitalOcean.
