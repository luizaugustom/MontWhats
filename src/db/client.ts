import { readFileSync, existsSync } from "node:fs";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

/**
 * Remove sslmode da URL. No pg recente, sslmode=require vira verify-full
 * e causa SELF_SIGNED_CERT_IN_CHAIN com Managed Postgres da DO.
 * O SSL fica só no objeto `ssl` do Pool.
 */
function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("uselibpqcompat");
    const qs = u.searchParams.toString();
    u.search = qs ? `?${qs}` : "";
    return u.toString();
  } catch {
    return url
      .replace(/([?&])sslmode=[^&]*/gi, "$1")
      .replace(/([?&])uselibpqcompat=[^&]*/gi, "$1")
      .replace(/[?&]$/, "")
      .replace(/\?&/, "?");
  }
}

function buildSsl(): pg.PoolConfig["ssl"] {
  if (!config.databaseSsl) return undefined;

  const caPath = process.env.DATABASE_CA_PATH;
  if (caPath && existsSync(caPath)) {
    return {
      rejectUnauthorized: true,
      ca: readFileSync(caPath, "utf8"),
    };
  }

  // DigitalOcean Managed Postgres (cadeia própria) — aceitar sem CA local.
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: stripSslParams(config.databaseUrl),
  ssl: buildSsl(),
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
