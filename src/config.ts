function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return n;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function detectDatabaseSsl(databaseUrl: string): boolean {
  if (boolEnv("DATABASE_SSL", false)) return true;
  if (/ondigitalocean\.com/i.test(databaseUrl)) return true;
  try {
    const u = new URL(databaseUrl);
    const mode = (u.searchParams.get("sslmode") || "").toLowerCase();
    return ["require", "verify-ca", "verify-full"].includes(mode);
  } catch {
    return /sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl);
  }
}

const databaseUrl = required(
  "DATABASE_URL",
  "postgres://montwhats:montwhats@localhost:5432/montwhats"
);

export const config = {
  port: intEnv("PORT", 3000),
  databaseUrl,
  databaseSsl: detectDatabaseSsl(databaseUrl),
  masterAdminKey: required("MASTER_ADMIN_KEY", "change-me-to-a-long-random-secret"),
  sessionsPath: required("SESSIONS_PATH", "./data/sessions"),
  antiban: {
    jitterMinMs: intEnv("ANTIBAN_JITTER_MIN_MS", 3000),
    jitterMaxMs: intEnv("ANTIBAN_JITTER_MAX_MS", 15000),
    composingMs: intEnv("ANTIBAN_COMPOSING_MS", 1200),
    warmupPhase1Daily: intEnv("ANTIBAN_WARMUP_PHASE1_DAILY", 30),
    warmupPhase2Daily: intEnv("ANTIBAN_WARMUP_PHASE2_DAILY", 80),
    warmupPhase3Daily: intEnv("ANTIBAN_WARMUP_PHASE3_DAILY", 180),
    hourlyCap: intEnv("ANTIBAN_HOURLY_CAP", 25),
    blastSameTextLimit: intEnv("ANTIBAN_BLAST_SAME_TEXT_LIMIT", 5),
    blastWindowMs: intEnv("ANTIBAN_BLAST_WINDOW_MS", 600_000),
    coldContactStreak: intEnv("ANTIBAN_COLD_CONTACT_STREAK", 8),
  },
};
