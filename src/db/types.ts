export type SessionStatus =
  | "pending"
  | "qr"
  | "connecting"
  | "connected"
  | "disconnected"
  | "restricted";

export type MessageDirection = "in" | "out";

export type MessageStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed"
  | "received";

export interface Tenant {
  id: string;
  name: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  created_at: Date;
}

export interface ApiKey {
  id: string;
  tenant_id: string;
  key_hash: string;
  key_prefix: string;
  label: string;
  created_at: Date;
}

export interface Session {
  id: string;
  tenant_id: string;
  phone: string | null;
  status: SessionStatus;
  warmup_phase: number;
  connected_at: Date | null;
  last_seen_at: Date | null;
  risk_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Message {
  id: string;
  session_id: string;
  direction: MessageDirection;
  remote_jid: string;
  body: string;
  status: MessageStatus;
  wa_message_id: string | null;
  error: string | null;
  queued_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
}

export interface SendCounter {
  session_id: string;
  day: string;
  hour_bucket: Date;
  count_day: number;
  count_hour: number;
  next_allowed_at: Date | null;
  cold_streak: number;
  updated_at: Date;
}
