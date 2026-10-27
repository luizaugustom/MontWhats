import type { FastifyInstance } from "fastify";
import { query } from "../db/client.js";
import type { Session } from "../db/types.js";
import { requireApiKey } from "../auth/middleware.js";
import { sessionManager } from "../baileys/session-manager.js";
import { computeWarmupPhase } from "../anti-ban/limits.js";
import { sendQueue } from "../queue/send-queue.js";

function serializeSession(s: Session) {
  return {
    id: s.id,
    phone: s.phone,
    status: s.status,
    warmupPhase: computeWarmupPhase(s.connected_at),
    connectedAt: s.connected_at,
    lastSeenAt: s.last_seen_at,
    riskReason: s.risk_reason,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireApiKey);

  app.post("/sessions", async (request, reply) => {
    const tenant = request.tenant!;
    const result = await query<Session>(
      `INSERT INTO sessions (tenant_id, status)
       VALUES ($1, 'pending')
       RETURNING *`,
      [tenant.id]
    );
    const session = result.rows[0];
    void sessionManager.startSession(session.id, tenant.id);
    return reply.code(201).send(serializeSession(session));
  });

  app.get("/sessions", async (request) => {
    const tenant = request.tenant!;
    const result = await query<Session>(
      `SELECT * FROM sessions WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenant.id]
    );
    return { sessions: result.rows.map(serializeSession) };
  });

  app.get<{ Params: { id: string } }>("/sessions/:id", async (request, reply) => {
    const tenant = request.tenant!;
    const result = await query<Session>(
      `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2`,
      [request.params.id, tenant.id]
    );
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "session_not_found" });
    }
    return serializeSession(result.rows[0]);
  });

  app.get<{ Params: { id: string } }>(
    "/sessions/:id/qr",
    async (request, reply) => {
      const tenant = request.tenant!;
      const result = await query<Session>(
        `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant.id]
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const session = result.rows[0];
      if (session.status === "connected") {
        return reply.code(409).send({ error: "already_connected" });
      }

      if (!sessionManager.isLive(session.id)) {
        void sessionManager.startSession(session.id, tenant.id);
      }

      const qr = sessionManager.getQr(session.id);
      if (!qr) {
        return reply.code(202).send({
          status: session.status,
          qr: null,
          message: "QR not ready yet; retry shortly",
        });
      }

      const accept = request.headers.accept ?? "";
      if (accept.includes("image/png")) {
        const base64 = qr.replace(/^data:image\/png;base64,/, "");
        return reply
          .type("image/png")
          .send(Buffer.from(base64, "base64"));
      }

      return { status: session.status, qr };
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    async (request, reply) => {
      const tenant = request.tenant!;
      const result = await query<Session>(
        `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2`,
        [request.params.id, tenant.id]
      );
      if (result.rowCount === 0) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      sendQueue.pause(request.params.id);
      await sessionManager.destroySession(request.params.id);
      await query(`DELETE FROM sessions WHERE id = $1`, [request.params.id]);
      return reply.code(204).send();
    }
  );
}
