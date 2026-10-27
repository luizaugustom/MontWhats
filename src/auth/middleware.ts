import type { FastifyReply, FastifyRequest } from "fastify";
import { query } from "../db/client.js";
import type { Tenant } from "../db/types.js";
import { hashApiKey } from "./keys.js";
import { config } from "../config.js";

export type AuthedRequest = FastifyRequest & {
  tenant: Tenant;
};

declare module "fastify" {
  interface FastifyRequest {
    tenant?: Tenant;
  }
}

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = request.headers["x-api-key"];
  if (!key || typeof key !== "string") {
    return reply.code(401).send({ error: "missing_api_key" });
  }

  const hash = hashApiKey(key);
  const result = await query<Tenant>(
    `SELECT t.*
     FROM api_keys k
     JOIN tenants t ON t.id = k.tenant_id
     WHERE k.key_hash = $1
     LIMIT 1`,
    [hash]
  );

  if (result.rowCount === 0) {
    return reply.code(401).send({ error: "invalid_api_key" });
  }

  request.tenant = result.rows[0];
}

export async function requireMasterKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const key = request.headers["x-master-key"];
  if (!key || typeof key !== "string" || key !== config.masterAdminKey) {
    return reply.code(401).send({ error: "invalid_master_key" });
  }
}
