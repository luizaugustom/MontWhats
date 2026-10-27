import type { FastifyInstance } from "fastify";
import { query } from "../db/client.js";
import type { Tenant } from "../db/types.js";
import { generateApiKey, generateWebhookSecret } from "../auth/keys.js";
import { requireMasterKey } from "../auth/middleware.js";

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/admin/tenants",
    { preHandler: requireMasterKey },
    async (request, reply) => {
      const body = request.body as { name?: string; label?: string } | null;
      const name = body?.name?.trim();
      if (!name) {
        return reply.code(400).send({ error: "name_required" });
      }

      const key = generateApiKey();
      const webhookSecret = generateWebhookSecret();

      const tenantResult = await query<Tenant>(
        `INSERT INTO tenants (name, webhook_secret)
         VALUES ($1, $2)
         RETURNING *`,
        [name, webhookSecret]
      );
      const tenant = tenantResult.rows[0];

      await query(
        `INSERT INTO api_keys (tenant_id, key_hash, key_prefix, label)
         VALUES ($1, $2, $3, $4)`,
        [tenant.id, key.hash, key.prefix, body?.label?.trim() || "default"]
      );

      return reply.code(201).send({
        tenant: {
          id: tenant.id,
          name: tenant.name,
          createdAt: tenant.created_at,
        },
        apiKey: key.plaintext,
        webhookSecret,
        note: "Store apiKey now; it will not be shown again.",
      });
    }
  );
}
