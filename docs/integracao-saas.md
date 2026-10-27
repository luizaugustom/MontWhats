# Integração SaaS — MontWhats

Como o seu sistema se conecta à API e como **mostrar corretamente uma conexão WhatsApp por cliente** no painel.

## Conceitos

| Conceito | Significado |
|----------|-------------|
| **Tenant** | Sua conta na MontWhats (1 API key) |
| **Session** | 1 número WhatsApp = 1 conexão = 1 cliente no seu SaaS |
| **Webhook** | MontWhats avisa seu backend (QR, conectado, mensagem, risco) |

Regra: **um cliente do seu SaaS ↔ uma `sessionId`**. Guarde esse vínculo no seu banco.

```
Seu SaaS
  cliente_id = 42  ──salva──►  montwhats_session_id = uuid
```

---

## Autenticação

Todas as rotas abaixo (exceto health) usam:

```http
X-Api-Key: mw_SUA_CHAVE
Content-Type: application/json
```

Base URL (exemplo): `https://whats.seudominio.com`

---

## Passo a passo de integração

### 1. Cadastrar webhook (uma vez por tenant)

Endpoint no **seu** backend que receberá POSTs da MontWhats:

```http
PUT /webhook
X-Api-Key: mw_...

{ "url": "https://seu-saas.com/api/hooks/montwhats" }
```

Resposta:

```json
{
  "webhookUrl": "https://seu-saas.com/api/hooks/montwhats",
  "webhookSecret": "..."
}
```

Guarde o `webhookSecret` e valide cada request:

```http
X-MontWhats-Signature: sha256=<hmac_sha256_hex_do_body>
X-MontWhats-Event: message.received
```

Pseudocódigo:

```js
const expected = "sha256=" + hmacSha256(webhookSecret, rawBody);
if (expected !== req.headers["x-montwhats-signature"]) reject();
```

### 2. Quando o usuário clicar em “Conectar WhatsApp”

No seu backend, crie a sessão na MontWhats e associe ao cliente:

```http
POST /sessions
X-Api-Key: mw_...
```

Resposta:

```json
{
  "id": "4b97d59d-...",
  "phone": null,
  "status": "pending",
  "warmupPhase": 1,
  "connectedAt": null,
  "riskReason": null
}
```

No seu banco:

```sql
UPDATE clientes
SET montwhats_session_id = '4b97d59d-...',
    whatsapp_status = 'pending'
WHERE id = 42;
```

### 3. Mostrar o QR no painel (por cliente)

Use a `sessionId` **daquele cliente**:

```http
GET /sessions/{sessionId}/qr
X-Api-Key: mw_...
```

JSON:

```json
{
  "status": "qr",
  "qr": "data:image/png;base64,...."
}
```

Ou imagem direta:

```http
GET /sessions/{sessionId}/qr
Accept: image/png
X-Api-Key: mw_...
```

#### UX recomendada no frontend

1. Botão “Conectar WhatsApp” → backend cria session e devolve `{ sessionId }`
2. Tela modal com:
   - imagem do QR (`<img src={qrDataUrl} />` ou proxy da sua API)
   - status: `Aguardando leitura…`
3. Poll a cada 2–3s:
   - `GET /sessions/{sessionId}` **ou**
   - `GET /sessions/{sessionId}/qr` até `status === "connected"` / `409 already_connected`
4. Preferível: atualizar via webhook `session.connected` (WebSocket/SSE interno do SaaS para o browser)

Estados para mostrar no UI:

| `status` MontWhats | Texto sugerido no painel |
|--------------------|---------------------------|
| `pending` / `connecting` | Preparando conexão… |
| `qr` | Escaneie o QR no WhatsApp |
| `connected` | Conectado · +55… |
| `disconnected` | Desconectado — reconectar |
| `restricted` | Número em risco / bloqueado |

### 4. Confirmar conexão

Webhook que você recebe:

```json
{
  "event": "session.connected",
  "tenantId": "...",
  "sessionId": "4b97d59d-...",
  "timestamp": "...",
  "data": { "phone": "5511999999999" }
}
```

Atualize o cliente:

```sql
UPDATE clientes
SET whatsapp_status = 'connected',
    whatsapp_phone = '5511999999999'
WHERE montwhats_session_id = '4b97d59d-...';
```

No painel, troque o QR por um badge **Conectado** + número.

### 5. Enviar mensagem (sempre pela session do cliente)

```http
POST /sessions/{sessionId}/messages
X-Api-Key: mw_...

{
  "to": "5511888777666",
  "text": "Olá, seu pedido saiu!"
}
```

Sucesso:

```json
{
  "id": "msg-uuid",
  "status": "queued",
  "estimatedSendAt": "..."
}
```

Rate limit / anti-ban:

```json
HTTP 429
{
  "error": "daily_limit",
  "message": "...",
  "retry_after": 3600
}
```

**Respeite `retry_after`** (segundos). Não faça retry agressivo — isso aumenta risco de ban.

Consultar status:

```http
GET /sessions/{sessionId}/messages/{msgId}
```

### 6. Receber mensagens

Webhook:

```json
{
  "event": "message.received",
  "sessionId": "4b97d59d-...",
  "data": {
    "messageId": "...",
    "from": "5511888777666@s.whatsapp.net",
    "text": "Oi",
    "waMessageId": "..."
  }
}
```

Ache o cliente por `montwhats_session_id = sessionId` e grave a mensagem na conversa dele.

### 7. Desconectar / trocar número

```http
DELETE /sessions/{sessionId}
X-Api-Key: mw_...
```

Limpa credenciais na MontWhats. No SaaS, zere `montwhats_session_id` e peça novo QR se quiser reconectar.

---

## Mapa “1 cliente = 1 conexão” (obrigatório no SaaS)

### O que guardar no seu banco

```text
clientes
  id
  nome
  montwhats_session_id   -- UUID MontWhats (nullable)
  whatsapp_status        -- pending|qr|connected|disconnected|restricted
  whatsapp_phone         -- preenchido após session.connected
```

### Fluxo visual

```
[Lista de clientes]
  Cliente Ana     [Conectar WhatsApp]     → cria session A → mostra QR A
  Cliente Bruno   [Conectado +5511...]    → session B
  Cliente Carla   [Desconectado]          → reconectar session C
```

Nunca reutilize a mesma `sessionId` para dois clientes.  
Nunca mostre o QR da sessão B na tela da Ana.

### Checklist de implementação no SaaS

- [ ] Coluna `montwhats_session_id` por cliente
- [ ] Endpoint interno “iniciar conexão” que chama `POST /sessions`
- [ ] Tela de QR só com a session daquele cliente
- [ ] Webhook atualiza status/phone pelo `sessionId`
- [ ] Envio de mensagem usa a session do cliente correto
- [ ] Tratamento de `429` com backoff
- [ ] Tratamento de `session.risk` / `restricted` (alerta no painel)

---

## Eventos de webhook

| Evento | Quando | Ação sugerida no SaaS |
|--------|--------|------------------------|
| `session.qr` | Novo QR gerado | Atualizar imagem do QR |
| `session.connected` | Número pareado | Badge conectado + telefone |
| `session.disconnected` | Caiu a conexão | Mostrar “reconectar” |
| `session.risk` | Logout/restrição | Pausar envios + alerta |
| `message.received` | Msg inbound | Inbox do cliente |
| `message.ack` | Ack WhatsApp | Atualizar ✓✓ na UI |

Payload comum:

```json
{
  "event": "session.connected",
  "tenantId": "uuid",
  "sessionId": "uuid",
  "timestamp": "ISO-8601",
  "data": {}
}
```

---

## Exemplos rápidos (curl)

```bash
export API=http://localhost:3000
export KEY=mw_...

# webhook
curl -X PUT $API/webhook -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://seu-saas.com/api/hooks/montwhats"}'

# nova conexão (cliente X)
curl -X POST $API/sessions -H "X-Api-Key: $KEY"

# QR
curl $API/sessions/SESSION_ID/qr -H "X-Api-Key: $KEY"

# status
curl $API/sessions/SESSION_ID -H "X-Api-Key: $KEY"

# enviar
curl -X POST $API/sessions/SESSION_ID/messages \
  -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"to":"5511999999999","text":"Olá"}'
```

---

## Erros comuns

| Situação | Causa | Correção |
|----------|-------|----------|
| `401 invalid_api_key` | Key errada | Confira `X-Api-Key` |
| QR sempre `null` | Sessão ainda subindo | Retry 2–3s; ouça `session.qr` |
| `429 session_not_connected` | Envio antes do pareamento | Só envie após `connected` |
| `429 daily_limit` / `blast_guard` | Anti-ban | Espere `retry_after`; reduza blast |
| QR de outro cliente | SessionId trocado no front | Sempre filtrar por cliente no backend |

---

## Aviso

A MontWhats usa Baileys (WhatsApp Web não oficial). Limites anti-ban reduzem risco de banimento, mas não eliminam. Evite disparos em massa e respeite os `429`.
