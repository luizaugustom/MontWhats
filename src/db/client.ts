import { readFileSync, existsSync } from "node:fs";
import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

function buildSsl(): pg.PoolConfig["ssl"] {
  if (!config.databaseSsl) return undefined;

  const caPath = process.env.DATABASE_CA_PATH;
  if (caPath && existsSync(caPath)) {
    return {
      rejectUnauthorized: true,
      ca: readFileSync(caPath, "utf8"),
    };
  }

  // Managed DO exige SSL; sem CA local aceitamos o certificado do servidor.
  // Para verificação estrita: baixe o CA no painel DO e defina DATABASE_CA_PATH.
  return { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
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
