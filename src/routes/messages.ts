import type { FastifyInstance } from "fastify";
import { query } from "../db/client.js";
import type { Message, Session } from "../db/types.js";
import { requireApiKey } from "../auth/middleware.js";
import { AntibanError, sendQueue } from "../queue/send-queue.js";

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post<{ Params: { id: string } }>(
    "/sessions/:id/messages",
    async (request, reply) => {
      const tenant = request.tenant!;
      const body = request.body as { to?: string; text?: string } | null;
      const to = body?.to?.trim();
      const text = body?.text?.trim();

      if (!to || !text) {
        return reply.code(400).send({ error: "to_and_text_required" });
      }
      if (text.length > 4096) {
        return reply.code(400).send({ error: "text_too_long" });
      }

      const result = await query<Session>(
        `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant.id]
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      try {
        const { message, estimatedSendAt } = await sendQueue.enqueue(
          result.rows[0],
          text,
          to
        );
        return reply.code(202).send({
          id: message.id,
          status: message.status,
          estimatedSendAt,
        });
      } catch (err) {
        if (err instanceof AntibanError) {
          return reply.code(429).send({
            error: err.code,
            message: err.message,
            retry_after: err.retryAfterSec,
          });
        }
        throw err;
      }
    }
  );

  app.get<{ Params: { id: string; msgId: string } }>(
    "/sessions/:id/messages/:msgId",
    async (request, reply) => {
      const tenant = request.tenant!;
      const session = await query<Session>(
        `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant.id]
      );
      if (session.rowCount === 0) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const result = await query<Message>(
        `SELECT * FROM messages WHERE id = $1 AND session_id = $2`,
        [request.params.msgId, request.params.id]
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "message_not_found" });
      }

      const m = result.rows[0];
      return {
        id: m.id,
        direction: m.direction,
        to: m.remote_jid,
        text: m.body,
        status: m.status,
        waMessageId: m.wa_message_id,
        error: m.error,
        queuedAt: m.queued_at,
        sentAt: m.sent_at,
        createdAt: m.created_at,
      };
    }
  );
}
