import { createHash } from "node:crypto";
import { config } from "../config.js";
import { query } from "../db/client.js";
import type { SendCounter, Session } from "../db/types.js";

export class AntibanError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryAfterSec: number
  ) {
    super(message);
    this.name = "AntibanError";
  }
}

function dailyLimitForPhase(phase: number): number {
  if (phase <= 1) return config.antiban.warmupPhase1Daily;
  if (phase <= 2) return config.antiban.warmupPhase2Daily;
  return config.antiban.warmupPhase3Daily;
}

function hourlyLimitForPhase(phase: number): number {
  const base = config.antiban.hourlyCap;
  if (phase <= 1) return Math.min(base, 15);
  if (phase <= 2) return Math.min(base, 20);
  return base;
}

export function computeWarmupPhase(connectedAt: Date | null): number {
  if (!connectedAt) return 1;
  const days =
    (Date.now() - connectedAt.getTime()) / (1000 * 60 * 60 * 24);
  if (days < 3) return 1;
  if (days < 7) return 2;
  return 3;
}

export function randomJitterMs(): number {
  const { jitterMinMs, jitterMaxMs } = config.antiban;
  return (
    jitterMinMs + Math.floor(Math.random() * (jitterMaxMs - jitterMinMs + 1))
  );
}

async function ensureCounter(sessionId: string): Promise<SendCounter> {
  await query(
    `INSERT INTO send_counters (session_id)
     VALUES ($1)
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId]
  );

  const result = await query<SendCounter>(
    `SELECT * FROM send_counters WHERE session_id = $1`,
    [sessionId]
  );
  let counter = result.rows[0];

  const today = new Date().toISOString().slice(0, 10);
  const hourStart = new Date();
  hourStart.setMinutes(0, 0, 0);

  const dayValue = counter.day as unknown;
  const dayStr =
    dayValue instanceof Date
      ? dayValue.toISOString().slice(0, 10)
      : String(dayValue).slice(0, 10);

  let countDay = counter.count_day;
  let countHour = counter.count_hour;
  let day = dayStr;
  let hourBucket = counter.hour_bucket;

  if (dayStr !== today) {
    countDay = 0;
    countHour = 0;
    day = today;
    hourBucket = hourStart;
  } else if (new Date(counter.hour_bucket).getTime() < hourStart.getTime()) {
    countHour = 0;
    hourBucket = hourStart;
  }

  if (
    countDay !== counter.count_day ||
    countHour !== counter.count_hour ||
    day !== dayStr
  ) {
    await query(
      `UPDATE send_counters
       SET day = $2::date,
           hour_bucket = $3,
           count_day = $4,
           count_hour = $5,
           updated_at = NOW()
       WHERE session_id = $1`,
      [sessionId, day, hourBucket, countDay, countHour]
    );
    const refreshed = await query<SendCounter>(
      `SELECT * FROM send_counters WHERE session_id = $1`,
      [sessionId]
    );
    counter = refreshed.rows[0];
  }

  return counter;
}

export async function assertCanEnqueue(
  session: Session,
  toJid: string,
  text: string
): Promise<{ retryAfterSec: number }> {
  if (session.status === "restricted") {
    throw new AntibanError(
      "Session is restricted",
      "session_restricted",
      3600
    );
  }
  if (session.status !== "connected") {
    throw new AntibanError(
      "Session is not connected",
      "session_not_connected",
      30
    );
  }

  const phase = computeWarmupPhase(session.connected_at);
  if (phase !== session.warmup_phase) {
    await query(`UPDATE sessions SET warmup_phase = $2, updated_at = NOW() WHERE id = $1`, [
      session.id,
      phase,
    ]);
  }

  const counter = await ensureCounter(session.id);
  if (counter.next_allowed_at && new Date(counter.next_allowed_at) > new Date()) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil(
        (new Date(counter.next_allowed_at).getTime() - Date.now()) / 1000
      )
    );
    throw new AntibanError("Rate limited by jitter window", "rate_limited", retryAfterSec);
  }

  const dailyCap = dailyLimitForPhase(phase);
  if (counter.count_day >= dailyCap) {
    throw new AntibanError(
      `Daily warmup limit reached (${dailyCap})`,
      "daily_limit",
      3600
    );
  }

  const hourlyCap = hourlyLimitForPhase(phase);
  if (counter.count_hour >= hourlyCap) {
    throw new AntibanError(
      `Hourly limit reached (${hourlyCap})`,
      "hourly_limit",
      600
    );
  }

  const bodyHash = createHash("sha256").update(text).digest("hex");
  const blast = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM recent_outbound_texts
     WHERE session_id = $1
       AND body_hash = $2
       AND created_at > NOW() - ($3::text || ' milliseconds')::interval`,
    [session.id, bodyHash, String(config.antiban.blastWindowMs)]
  );
  if (Number(blast.rows[0].count) >= config.antiban.blastSameTextLimit) {
    throw new AntibanError(
      "Identical text blast detected",
      "blast_guard",
      300
    );
  }

  const known = await query(
    `SELECT 1 FROM known_contacts WHERE session_id = $1 AND remote_jid = $2`,
    [session.id, toJid]
  );
  const isCold = (known.rowCount ?? 0) === 0;
  if (isCold && phase <= 2 && counter.cold_streak >= config.antiban.coldContactStreak) {
    throw new AntibanError(
      "Too many cold contacts in a row during warmup",
      "cold_contact_guard",
      600
    );
  }

  return { retryAfterSec: 0 };
}

export async function recordSuccessfulSend(
  sessionId: string,
  toJid: string,
  text: string,
  wasCold: boolean
): Promise<void> {
  const jitter = randomJitterMs();
  const nextAllowed = new Date(Date.now() + jitter);
  const bodyHash = createHash("sha256").update(text).digest("hex");

  await query(
    `INSERT INTO send_counters (session_id, count_day, count_hour, next_allowed_at, cold_streak)
     VALUES ($1, 1, 1, $2, $3)
     ON CONFLICT (session_id) DO UPDATE SET
       count_day = send_counters.count_day + 1,
       count_hour = send_counters.count_hour + 1,
       next_allowed_at = EXCLUDED.next_allowed_at,
       cold_streak = CASE
         WHEN $4 THEN send_counters.cold_streak + 1
         ELSE 0
       END,
       updated_at = NOW()`,
    [sessionId, nextAllowed, wasCold ? 1 : 0, wasCold]
  );

  await query(
    `INSERT INTO known_contacts (session_id, remote_jid)
     VALUES ($1, $2)
     ON CONFLICT (session_id, remote_jid) DO UPDATE SET last_seen_at = NOW()`,
    [sessionId, toJid]
  );

  await query(
    `INSERT INTO recent_outbound_texts (session_id, body_hash, remote_jid)
     VALUES ($1, $2, $3)`,
    [sessionId, bodyHash, toJid]
  );

  await query(
    `DELETE FROM recent_outbound_texts
     WHERE session_id = $1
       AND created_at < NOW() - INTERVAL '1 day'`,
    [sessionId]
  );
}

export async function isColdContact(
  sessionId: string,
  remoteJid: string
): Promise<boolean> {
  const known = await query(
    `SELECT 1 FROM known_contacts WHERE session_id = $1 AND remote_jid = $2`,
    [sessionId, remoteJid]
  );
  return (known.rowCount ?? 0) === 0;
}

export function toWhatsAppJid(phoneOrJid: string): string {
  const trimmed = phoneOrJid.trim();
  if (trimmed.includes("@")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}
