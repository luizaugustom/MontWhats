import Fastify from "fastify";
import { mkdir } from "node:fs/promises";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { healthRoutes } from "./routes/health.js";
import { adminRoutes } from "./routes/admin.js";
import { sessionRoutes } from "./routes/sessions.js";
import { messageRoutes } from "./routes/messages.js";
import { webhookRoutes } from "./routes/webhook.js";
import { sessionManager } from "./baileys/session-manager.js";
import { wireSessionHandlers } from "./baileys/inbound.js";

async function main() {
  await mkdir(config.sessionsPath, { recursive: true });

  // Ensure DB is reachable
  await pool.query("SELECT 1");

  const app = Fastify({
    logger: true,
    bodyLimit: 1_048_576,
  });

  await app.register(healthRoutes);
  await app.register(adminRoutes);
  await app.register(webhookRoutes);
  await app.register(sessionRoutes);
  await app.register(messageRoutes);

  wireSessionHandlers();
  await sessionManager.restoreConnectedSessions();

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
