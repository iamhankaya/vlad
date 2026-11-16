/**
 * Uzaktan onay (vlad approver) SÖZLEŞMESİ: tipler ve sabitler. Tasarım: T20261116-03 planı (kb görev kapanış raporu).
 * Bu dosya sözleşme fazının (T20261116-04) çıktısıdır; sonradan değişiklik yalnız `vlad task ask` + sözleşme düzeltmesi ile.
 * GÜVENLİK SINIRI: telefon onayı kimlik doğrulaması değildir; aynı UID'deki kötü niyetli süreç kapsam dışıdır (plan "Önce okuyun").
 */
export type Op = "mode night" | "mode watch" | "mode off" | "install" | "setup";

/** İstemcinin `inbox/<cid>.json`'a yazdığı istek. Servis bu dosyadaki hiçbir alanı nonce/tag/konu/id olarak KULLANMAZ. */
export interface ApprovalRequestFile { v: 1; cid: string /* ^[a-z2-7]{26}$ */; op: Op; argv: string[]; requestedAt: string; requester: string }
/** Servisin çözdüğü bağlam: digest'e girer, yürütmede yeniden doğrulanır. */
export interface Ctx { home: string; kb: string; cli: string }
export type PendingStatus = "pending" | "approved" | "denied" | "expired" | "executing";
export interface PendingRecord {
  v: 1; id: string /* 26 b32 */; shortId: string /* ilk 8 */; cid: string; op: Op; argv: string[]; requestedAt: string; expiresAt: string;
  nonce: string /* 32 hex */; respTopic: string; digest: string /* 64 hex */; ctx: Ctx; keyGen: string /* 16 hex */; status: PendingStatus; requester: string;
}
export type AckStatus = "pending" | "busy" | "rate_limited" | "locked" | "invalid";
export interface AckRecord { v: 1; cid: string; status: AckStatus; id?: string; expiresAt?: string; reason?: RejectReason }
export type ResultStatus = "done" | "failed" | "interrupted" | "denied" | "expired";
export interface ResultRecord { v: 1; id: string; status: ResultStatus; exitCode: number | null; stdout: string; stderr: string; reason?: string; finishedAt: string }
export type RejectReason =
  | "not_allowlisted" | "bad_flag" | "bad_value" | "too_large" | "control_char" | "duplicate_flag" | "conflicting"
  | "setup_answers_unsupported" | "key_disabled" | "key_changed" | "ctx_changed" | "rate_state_corrupt" | "oversize";
export type DropReason = "bad_format" | "bad_json" | "unknown_id" | "not_pending" | "expired" | "bad_tag" | "oversize";
export interface ChannelConfig { v: 1; server: string; requestTopic: string; createdAt: string }
/** Hız sınırı durumu (`rate.json`): bozuk/okunamaz ise fail-closed (`locked: rate_state_corrupt`), sayaç sıfırlanmaz. */
export interface RateState { v: 1; decisions: string[] /* ISO zamanları: soğuma/saatlik/günlük */; consecutiveDenied: number; lockedUntil: string | null }

export const LIMITS = {
  approveTtlMs: 300_000, tokenTtlMs: 60_000, maxTokenTtlMs: 120_000, maxArgvBytes: 8192, maxValueBytes: 200,
  cooldownMs: 30_000, perHour: 6, perDay: 20, lockAfterDenied: 3, lockMs: 3_600_000, execTimeoutMs: 300_000,
  ackWaitMs: 15_000, waitSlackMs: 10_000, maxInboxFiles: 20, maxInboxBytes: 160_000, maxOutputBytes: 65_536,
} as const;
