import type { FastifyInstance } from "fastify";
import { query } from "../db/client.js";
import type { Tenant } from "../db/types.js";
import { generateWebhookSecret } from "../auth/keys.js";
import { requireApiKey } from "../auth/middleware.js";

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.put(
    "/webhook",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const tenant = request.tenant!;
      const body = request.body as { url?: string; rotateSecret?: boolean } | null;
      const url = body?.url?.trim();
      if (!url) {
        return reply.code(400).send({ error: "url_required" });
      }
      try {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          return reply.code(400).send({ error: "invalid_url" });
        }
      } catch {
        return reply.code(400).send({ error: "invalid_url" });
      }

      const rotate = body?.rotateSecret !== false;
      const secret = rotate
        ? generateWebhookSecret()
        : tenant.webhook_secret ?? generateWebhookSecret();

      const result = await query<Tenant>(
        `UPDATE tenants
         SET webhook_url = $2, webhook_secret = $3
         WHERE id = $1
         RETURNING *`,
        [tenant.id, url, secret]
      );

      return {
        webhookUrl: result.rows[0].webhook_url,
        webhookSecret: result.rows[0].webhook_secret,
      };
    }
  );
}
