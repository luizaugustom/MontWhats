# Deploy fácil — DigitalOcean (Droplet + Managed Database)

**Passo a passo completo a partir de uma VPS vazia:** [manual-vps-do-zero.md](./manual-vps-do-zero.md)

Cenário recomendado:

- **Droplet** (VPS) → container da API + volume das sessões WhatsApp  
- **Managed PostgreSQL** → banco gerenciado da DigitalOcean  

Não use App Platform sozinha (disco efêmero + WebSocket longo).

---

## 1. Criar o banco (Managed Database)

No painel DigitalOcean:

1. **Databases** → **Create Database** → PostgreSQL 16  
2. Mesma região do Droplet  
3. Em **Users & Databases**, anote usuário/senha (ex.: `doadmin`)  
4. Em **Connection Details** → **Connection string** (URI)

Exemplo:

```text
postgresql://doadmin:SENHA@host-do-usuario.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

5. Em **Trusted Sources**, depois de criar o Droplet, adicione o **IP do Droplet** (ou o Droplet como resource). Sem isso a API não conecta.

Opcional (SSL estrito): baixe o **CA certificate** do banco e no Droplet salve em `/opt/montwhats/certs/ca-certificate.crt`.

---

## 2. Criar o Droplet (VPS)

1. **Droplets** → Ubuntu 24.04 LTS  
2. Plano mínimo sugerido: **2 GB RAM** (para poucas sessões; suba conforme 50–500 conexões)  
3. Mesma região do banco  
4. Firewall (Cloud Firewall ou ufw):
   - SSH `22`
   - API `3000` **ou** HTTP/HTTPS `80`/`443` se for usar domínio + Caddy

Acesse:

```bash
ssh root@IP_DO_DROPLET
```

---

## 3. Subir a MontWhats (um comando)

No Droplet:

```bash
# clone (ajuste a URL do seu repositório)
git clone SEU_REPO_GIT montwhats
cd montwhats

chmod +x scripts/deploy.sh
./scripts/deploy.sh
```

Na primeira vez o script cria `.env` e pede para editar. Configure:

```bash
nano .env
```

Mínimo obrigatório:

```env
MASTER_ADMIN_KEY=troque-por-uma-chave-longa
DATABASE_URL=postgresql://doadmin:SENHA@HOST:25060/defaultdb?sslmode=require
DATABASE_SSL=true
PORT=3000
```

Se baixou o CA da DO:

```env
DATABASE_CA_PATH=/opt/montwhats/certs/ca-certificate.crt
```

(e monte/copie o arquivo no servidor; se rodar só no Docker, coloque o CA no host e adicione volume no compose — o default com `DATABASE_SSL=true` já funciona sem CA).

Rode de novo:

```bash
./scripts/deploy.sh
```

O script:

1. Instala Docker se faltar  
2. Sobe só a API (`docker-compose.prod.yml`)  
3. Roda migrations no start  
4. Checa `/health`

---

## 4. HTTPS com domínio (opcional, ainda simples)

1. Crie DNS **A** `whats.seudominio.com` → IP do Droplet  
2. No `.env`:

```env
DOMAIN=whats.seudominio.com
```

3. Abra portas **80** e **443** no firewall  
4. Redeploy:

```bash
./scripts/deploy.sh
```

O Caddy sobe no profile `https` e emite certificado automático.

URL: `https://whats.seudominio.com`

---

## 5. Criar o primeiro tenant

```bash
source .env
curl -s -X POST http://127.0.0.1:3000/admin/tenants \
  -H "Content-Type: application/json" \
  -H "X-Master-Key: $MASTER_ADMIN_KEY" \
  -d '{"name":"Meu SaaS"}'
```

Guarde `apiKey` e `webhookSecret`. Entregue ao SaaS com a URL pública.

Detalhes: [manual-admin.md](./manual-admin.md) · [integracao-saas.md](./integracao-saas.md)

---

## 6. Atualizar depois

```bash
cd montwhats
git pull
./scripts/deploy.sh
```

Sessões WhatsApp ficam no volume Docker `sessions_data` (sobrevivem a rebuild).

---

## Checklist rápido

- [ ] Managed Postgres criado  
- [ ] Droplet na mesma região  
- [ ] IP do Droplet em Trusted Sources do banco  
- [ ] `.env` com `DATABASE_URL` + `DATABASE_SSL=true` + `MASTER_ADMIN_KEY`  
- [ ] `./scripts/deploy.sh` OK  
- [ ] `curl /health` responde  
- [ ] Tenant criado  
- [ ] (Opcional) `DOMAIN` + DNS + portas 80/443  

---

## Local vs produção

| Ambiente | Comando |
|----------|---------|
| Local (Postgres no Compose) | `docker compose up -d --build` |
| VPS + banco DO | `./scripts/deploy.sh` (= `docker compose -f docker-compose.prod.yml ...`) |

---

## Problemas comuns

| Sintoma | Causa | Correção |
|---------|-------|----------|
| Timeout no start / migration | Trusted Sources | Libere IP do Droplet no banco |
| `SSL required` | Sem SSL | `DATABASE_SSL=true` e `?sslmode=require` na URL |
| Perdeu QR após reboot | Volume apagado | Não rode `docker compose down -v` |
| 502 com Caddy | DNS/API | Confira `DOMAIN` e `docker logs montwhats-api` |
