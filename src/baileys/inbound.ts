import type { WAMessage } from "@whiskeysockets/baileys";
import { query } from "../db/client.js";
import { sessionManager } from "./session-manager.js";
import { dispatchWebhook } from "../webhook/dispatcher.js";
import { sendQueue } from "../queue/send-queue.js";

export function wireSessionHandlers(): void {
  sessionManager.setHandlers({
    onRestricted: (sessionId) => {
      sendQueue.pause(sessionId);
    },
    onInbound: async (sessionId, tenantId, msg) => {
      await handleInbound(sessionId, tenantId, msg);
    },
    onAck: async (sessionId, tenantId, waMessageId, status) => {
      await query(
        `UPDATE messages
         SET status = CASE
           WHEN $3 >= 3 THEN 'sent'
           ELSE status
         END
         WHERE session_id = $1 AND wa_message_id = $2`,
        [sessionId, waMessageId, status]
      );
      void dispatchWebhook(tenantId, "message.ack", sessionId, {
        waMessageId,
        status,
      });
    },
  });
}

async function handleInbound(
  sessionId: string,
  tenantId: string,
  msg: WAMessage
): Promise<void> {
  const remoteJid = msg.key.remoteJid;
  if (!remoteJid || remoteJid.endsWith("@g.us")) {
    // MVP: ignore groups
    return;
  }

  const text = sessionManager.extractText(msg) ?? "";
  const waId = msg.key.id ?? null;

  const inserted = await query(
    `INSERT INTO messages (session_id, direction, remote_jid, body, status, wa_message_id, sent_at)
     VALUES ($1, 'in', $2, $3, 'received', $4, NOW())
     RETURNING id`,
    [sessionId, remoteJid, text, waId]
  );

  await query(
    `INSERT INTO known_contacts (session_id, remote_jid)
     VALUES ($1, $2)
     ON CONFLICT (session_id, remote_jid) DO UPDATE SET last_seen_at = NOW()`,
    [sessionId, remoteJid]
  );

  void dispatchWebhook(tenantId, "message.received", sessionId, {
    messageId: inserted.rows[0].id,
    from: remoteJid,
    text,
    waMessageId: waId,
    timestamp: msg.messageTimestamp,
  });
}
