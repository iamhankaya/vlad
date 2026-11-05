import type { ClipImageResult, ClipImageSink } from "../transfer/types.js";
import type { OpHandler } from "../agent/ops/index.js";

// Sözleşme (T20261105-05, plan T20261105-04): ortak pano tipleri. Çalışma zamanı kodu yalnız sabitlerdir.
export const CLIP_MAX_TEXT_BYTES = 1024 * 1024;
export const CLIP_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const CLIP_MAX_PIXELS = 64_000_000;
export const CLIP_POLL_MS = 500;

export type ClipKind = "text" | "image";
/** text: UTF-8; image: PNG */
export interface ClipContent { kind: ClipKind; bytes: Buffer }
export type OrderKey = readonly [eventTs: number, rank: 0 | 1, counter: number];

export interface ClipboardBackend {
  read(): Promise<{ seq: number; content: ClipContent | null }>;
  write(c: ClipContent, expectSeq: number): Promise<{ written: boolean; seqAfter: number; reason?: "local_changed" }>;
  changeCount(): Promise<number>;
  /** yardımcı süreçler dahil sonlandırır */
  close(): Promise<void>;
}
/** data: base64 UTF-8 */
export interface ClipPushArgs { kind: "text"; data: string; eventTs: number; rank: 0 | 1; counter: number }
export interface ClipSenders {
  pushText(a: ClipPushArgs): Promise<"applied" | "stale" | "disabled">;
  pushImage(png: Buffer, meta: { eventTs: number; rank: 0 | 1 }): Promise<ClipImageResult>;
}
export interface ClipDeps {
  backend: ClipboardBackend; send: ClipSenders; now(): number; sleep?(ms: number): Promise<void>; isEnabled(): boolean; log(m: string): void;
  rank: 0 | 1; peer: string | null; retryMaxAgeMs?: number; settleMs?: number; autoStart?: boolean;
}
export type ApplyResult = "applied" | "stale" | "disabled" | "too_large" | "bad_image" | "local_changed";
export interface ClipReceiver { ops: { "clip-push": OpHandler }; sink: ClipImageSink; sync: ClipSyncLike }
/** ClipSync'in dışarıya açık yüzü (sınıf src/clip/sync.ts'te). */
export interface ClipSyncLike {
  tick(): Promise<void>;
  applyRemote(m: { kind: ClipKind; bytes: Buffer; key: OrderKey; from: string }): Promise<ApplyResult>;
  start(): void;
  stop(): Promise<void>;
}

export interface ShellRunner { (file: string, args: string[], o?: { input?: Buffer; env?: Record<string, string> }): Promise<{ stdout: Buffer; stderr: string; code: number }> }
/** kalıcı PowerShell: satır isteği → yanıt eşleştirme, timeout, çöküşte yeniden başlatma üst sınırı 3 */
export interface PersistentHelper { send(line: string, timeoutMs: number): Promise<string>; close(): Promise<void> }
export type PersistentRunner = { run: ShellRunner; spawnHelper(file: string, args: string[]): PersistentHelper };
