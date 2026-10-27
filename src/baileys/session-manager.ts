import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import pino from "pino";
import { Boom } from "@hapi/boom";
import { config } from "../config.js";
import { query } from "../db/client.js";
import type { Session, SessionStatus } from "../db/types.js";
import { dispatchWebhook } from "../webhook/dispatcher.js";
import { computeWarmupPhase } from "../anti-ban/limits.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

interface LiveSession {
  sock: WASocket;
  qrDataUrl: string | null;
  tenantId: string;
}

export class SessionManager {
  private live = new Map<string, LiveSession>();
  private starting = new Set<string>();
  private onInbound?: (
    sessionId: string,
    tenantId: string,
    msg: WAMessage
  ) => Promise<void>;
  private onAck?: (
    sessionId: string,
    tenantId: string,
    waMessageId: string,
    status: number
  ) => Promise<void>;
  private onRestricted?: (sessionId: string) => void;

  setHandlers(handlers: {
    onInbound?: SessionManager["onInbound"];
    onAck?: SessionManager["onAck"];
    onRestricted?: SessionManager["onRestricted"];
  }) {
    this.onInbound = handlers.onInbound;
    this.onAck = handlers.onAck;
    this.onRestricted = handlers.onRestricted;
  }

  getQr(sessionId: string): string | null {
    return this.live.get(sessionId)?.qrDataUrl ?? null;
  }

  getSocket(sessionId: string): WASocket | undefined {
    return this.live.get(sessionId)?.sock;
  }

  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  private authDir(sessionId: string): string {
    return path.join(config.sessionsPath, sessionId);
  }

  private async setStatus(
    sessionId: string,
    status: SessionStatus,
    extra: Partial<{
      phone: string | null;
      risk_reason: string | null;
      connected_at: Date | null;
    }> = {}
  ): Promise<Session> {
    const result = await query<Session>(
      `UPDATE sessions
       SET status = $2,
           phone = COALESCE($3, phone),
           risk_reason = $4,
           connected_at = COALESCE($5, connected_at),
           last_seen_at = NOW(),
           warmup_phase = CASE
             WHEN $5 IS NOT NULL THEN $6
             ELSE warmup_phase
           END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        sessionId,
        status,
        extra.phone ?? null,
        extra.risk_reason ?? null,
        extra.connected_at ?? null,
        extra.connected_at ? computeWarmupPhase(extra.connected_at) : 1,
      ]
    );
    return result.rows[0];
  }

  async startSession(sessionId: string, tenantId: string): Promise<void> {
    if (this.live.has(sessionId) || this.starting.has(sessionId)) return;
    this.starting.add(sessionId);

    try {
      await mkdir(this.authDir(sessionId), { recursive: true });
      const { state, saveCreds } = await useMultiFileAuthState(
        this.authDir(sessionId)
      );
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      this.live.set(sessionId, { sock, qrDataUrl: null, tenantId });

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          const qrDataUrl = await qrcode.toDataURL(qr);
          const live = this.live.get(sessionId);
          if (live) live.qrDataUrl = qrDataUrl;
          await this.setStatus(sessionId, "qr");
          void dispatchWebhook(tenantId, "session.qr", sessionId, {
            qr: qrDataUrl,
          });
        }

        if (connection === "connecting") {
          await this.setStatus(sessionId, "connecting");
        }

        if (connection === "open") {
          const live = this.live.get(sessionId);
          if (live) live.qrDataUrl = null;
          const phone = sock.user?.id?.split(":")[0] ?? null;
          const connectedAt = new Date();
          await this.setStatus(sessionId, "connected", {
            phone,
            connected_at: connectedAt,
            risk_reason: null,
          });
          void dispatchWebhook(tenantId, "session.connected", sessionId, {
            phone,
          });
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error as Boom | undefined)?.output
            ?.statusCode;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          const bannedLike =
            statusCode === DisconnectReason.connectionReplaced ||
            statusCode === 403 ||
            statusCode === 401;

          this.live.delete(sessionId);

          if (loggedOut || bannedLike) {
            const reason =
              loggedOut ? "logged_out" : `disconnect_${statusCode ?? "unknown"}`;
            await this.setStatus(sessionId, "restricted", {
              risk_reason: reason,
            });
            this.onRestricted?.(sessionId);
            void dispatchWebhook(tenantId, "session.risk", sessionId, {
              reason,
              statusCode,
            });
            void dispatchWebhook(tenantId, "session.disconnected", sessionId, {
              reason,
            });
            return;
          }

          await this.setStatus(sessionId, "disconnected", {
            risk_reason: `disconnect_${statusCode ?? "unknown"}`,
          });
          void dispatchWebhook(tenantId, "session.disconnected", sessionId, {
            statusCode,
          });

          // Auto-reconnect for transient closes
          setTimeout(() => {
            void this.startSession(sessionId, tenantId);
          }, 3000);
        }
      });

      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;
        for (const msg of messages) {
          if (!msg.message || msg.key.fromMe) continue;
          if (this.onInbound) {
            await this.onInbound(sessionId, tenantId, msg);
          }
        }
      });

      sock.ev.on("messages.update", async (updates) => {
        for (const u of updates) {
          const waId = u.key?.id;
          if (!waId || u.update.status == null) continue;
          if (this.onAck) {
            await this.onAck(sessionId, tenantId, waId, u.update.status);
          }
        }
      });
    } finally {
      this.starting.delete(sessionId);
    }
  }

  async stopSession(sessionId: string, logout = false): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) {
      try {
        if (logout) await live.sock.logout();
        else live.sock.end(undefined);
      } catch {
        // ignore
      }
      this.live.delete(sessionId);
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    await this.stopSession(sessionId, true);
    await rm(this.authDir(sessionId), { recursive: true, force: true });
  }

  async restoreConnectedSessions(): Promise<void> {
    const result = await query<Session>(
      `SELECT * FROM sessions
       WHERE status IN ('connected', 'connecting', 'qr', 'disconnected')`
    );
    for (const session of result.rows) {
      void this.startSession(session.id, session.tenant_id);
    }
  }

  extractText(msg: WAMessage): string | null {
    const m = msg.message;
    if (!m) return null;
    if (m.conversation) return m.conversation;
    if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
    if (m.imageMessage?.caption) return m.imageMessage.caption;
    if (m.videoMessage?.caption) return m.videoMessage.caption;
    return null;
  }
}

export const sessionManager = new SessionManager();
