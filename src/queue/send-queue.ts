import { config } from "../config.js";
import { query } from "../db/client.js";
import type { Message, Session } from "../db/types.js";
import {
  AntibanError,
  assertCanEnqueue,
  isColdContact,
  recordSuccessfulSend,
  toWhatsAppJid,
} from "../anti-ban/limits.js";
import { sessionManager } from "../baileys/session-manager.js";
import { dispatchWebhook } from "../webhook/dispatcher.js";

interface QueueItem {
  messageId: string;
  sessionId: string;
  tenantId: string;
  toJid: string;
  text: string;
}

class SessionSendQueue {
  private queues = new Map<string, QueueItem[]>();
  private running = new Map<string, boolean>();
  private paused = new Set<string>();

  pause(sessionId: string): void {
    this.paused.add(sessionId);
  }

  resume(sessionId: string): void {
    this.paused.delete(sessionId);
    void this.pump(sessionId);
  }

  async enqueue(
    session: Session,
    text: string,
    to: string
  ): Promise<{ message: Message; estimatedSendAt: string }> {
    const toJid = toWhatsAppJid(to);
    await assertCanEnqueue(session, toJid, text);

    const inserted = await query<Message>(
      `INSERT INTO messages (session_id, direction, remote_jid, body, status, queued_at)
       VALUES ($1, 'out', $2, $3, 'queued', NOW())
       RETURNING *`,
      [session.id, toJid, text]
    );
    const message = inserted.rows[0];

    const list = this.queues.get(session.id) ?? [];
    list.push({
      messageId: message.id,
      sessionId: session.id,
      tenantId: session.tenant_id,
      toJid,
      text,
    });
    this.queues.set(session.id, list);

    const depth = list.length;
    const estimatedMs =
      depth * ((config.antiban.jitterMinMs + config.antiban.jitterMaxMs) / 2);
    const estimatedSendAt = new Date(Date.now() + estimatedMs).toISOString();

    void this.pump(session.id);
    return { message, estimatedSendAt };
  }

  private async pump(sessionId: string): Promise<void> {
    if (this.running.get(sessionId)) return;
    if (this.paused.has(sessionId)) return;

    const list = this.queues.get(sessionId);
    if (!list || list.length === 0) return;

    this.running.set(sessionId, true);
    try {
      while (true) {
        if (this.paused.has(sessionId)) break;
        const item = this.queues.get(sessionId)?.[0];
        if (!item) break;

        await this.processItem(item);
        this.queues.get(sessionId)?.shift();
      }
    } finally {
      this.running.set(sessionId, false);
      const remaining = this.queues.get(sessionId);
      if (remaining && remaining.length > 0 && !this.paused.has(sessionId)) {
        void this.pump(sessionId);
      }
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    await query(
      `UPDATE messages SET status = 'sending' WHERE id = $1`,
      [item.messageId]
    );

    const sock = sessionManager.getSocket(item.sessionId);
    if (!sock) {
      await query(
        `UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`,
        [item.messageId, "socket_unavailable"]
      );
      return;
    }

    try {
      const resolvedJid = await resolveDeliverableJid(sock, item.toJid);
      if (!resolvedJid) {
        await query(
          `UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`,
          [item.messageId, "number_not_on_whatsapp"]
        );
        return;
      }

      // Persiste o JID resolvido (pode diferir do digitado — BR 9º dígito / LID).
      if (resolvedJid !== item.toJid) {
        item.toJid = resolvedJid;
        await query(`UPDATE messages SET remote_jid = $2 WHERE id = $1`, [
          item.messageId,
          resolvedJid,
        ]);
      }

      const cold = await isColdContact(item.sessionId, item.toJid);

      await sock.sendPresenceUpdate("composing", item.toJid);
      await sleep(config.antiban.composingMs);

      const sent = await sock.sendMessage(item.toJid, { text: item.text });
      const waId = sent?.key?.id ?? null;

      await query(
        `UPDATE messages
         SET status = 'sent', wa_message_id = $2, sent_at = NOW(), error = NULL
         WHERE id = $1`,
        [item.messageId, waId]
      );

      await recordSuccessfulSend(item.sessionId, item.toJid, item.text, cold);
      await sock.sendPresenceUpdate("paused", item.toJid);

      // Wait remaining jitter before next message (recordSuccessfulSend already set next_allowed_at)
      const counter = await query<{ next_allowed_at: Date | null }>(
        `SELECT next_allowed_at FROM send_counters WHERE session_id = $1`,
        [item.sessionId]
      );
      const next = counter.rows[0]?.next_allowed_at;
      if (next) {
        const wait = new Date(next).getTime() - Date.now();
        if (wait > 0) await sleep(wait);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "send_failed";
      await query(
        `UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`,
        [item.messageId, message]
      );
      // small backoff after failure
      await sleep(2000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve o JID real via Baileys onWhatsApp.
 * Sem isso, sendMessage pode retornar id e status "sent" sem entrega
 * (números BR com/sem 9º dígito, LID, etc.).
 */
async function resolveDeliverableJid(
  sock: { onWhatsApp?: (...args: string[]) => Promise<Array<{ jid: string; exists: boolean }> | undefined> },
  toJid: string
): Promise<string | null> {
  if (typeof sock.onWhatsApp !== "function") {
    return toJid;
  }

  const digits = toJid.replace(/\D/g, "");
  const candidates = new Set<string>([digits]);

  // Variantes comuns BR: com/sem o 9 após o DDD (55 + DDD + 9 + 8 dígitos)
  if (digits.startsWith("55") && digits.length === 13) {
    // 55 + 2 DDD + 9 + 8 → tenta sem o 9
    candidates.add(digits.slice(0, 4) + digits.slice(5));
  } else if (digits.startsWith("55") && digits.length === 12) {
    // 55 + 2 DDD + 8 → tenta com o 9
    candidates.add(digits.slice(0, 4) + "9" + digits.slice(4));
  }

  for (const candidate of candidates) {
    try {
      const results = await sock.onWhatsApp(candidate);
      const hit = results?.find((r) => r?.exists && r.jid);
      if (hit?.jid) return hit.jid;
    } catch {
      // tenta próximo candidato
    }
  }

  return null;
}

export const sendQueue = new SessionSendQueue();

export { AntibanError };
