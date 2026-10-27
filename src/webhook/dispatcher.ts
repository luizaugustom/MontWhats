import { createHmac } from "node:crypto";
import { query } from "../db/client.js";
import type { Tenant } from "../db/types.js";

export type WebhookEvent =
  | "session.qr"
  | "session.connected"
  | "session.disconnected"
  | "session.risk"
  | "message.received"
  | "message.ack";

export interface WebhookPayload {
  event: WebhookEvent;
  tenantId: string;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

function sign(secret: string, body: string): string {
  const digest = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${digest}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function dispatchWebhook(
  tenantId: string,
  event: WebhookEvent,
  sessionId: string,
  data: Record<string, unknown>
): Promise<void> {
  const result = await query<Tenant>(
    `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  const tenant = result.rows[0];
  if (!tenant?.webhook_url || !tenant.webhook_secret) {
    return;
  }

  const payload: WebhookPayload = {
    event,
    tenantId,
    sessionId,
    timestamp: new Date().toISOString(),
    data,
  };
  const body = JSON.stringify(payload);
  const signature = sign(tenant.webhook_secret, body);

  const delays = [0, 1000, 3000, 8000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleep(delays[attempt]);
    try {
      const res = await fetch(tenant.webhook_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MontWhats-Signature": signature,
          "X-MontWhats-Event": event,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
    } catch {
      // retry
    }
  }
}
