import { createHash, randomBytes } from "node:crypto";

export function generateApiKey(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = `mw_${randomBytes(24).toString("base64url")}`;
  return {
    plaintext,
    hash: hashApiKey(plaintext),
    prefix: plaintext.slice(0, 10),
  };
}

export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
