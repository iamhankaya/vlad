import type { AgentKind, OpHandler } from "../agent/ops/index.js";
import type { AgentEnv } from "../agent/ops/env.js";
import type { ClipDeps } from "../clip/types.js";
import type { VladConfig } from "../kb/types.js";
import type { Os } from "../fleet/types.js";
import type { Notifier } from "../platform/notify.js";
import type { OriginMarker } from "../platform/origin.js";

// Sözleşme (T20261105-05, plan T20261105-04): dosya aktarımı tipleri. Çalışma zamanı kodu yalnız sabitlerdir.
// Değişiklik gerekirse `vlad task ask` ile sor.
//
// XferEntry kuralları: `path` "/" ayraçlı göreli yoldur; ilk bileşen üst düzey addır. "dir" girdisi yalnız BOŞ dizin içindir
// (size 0); dosya yolunun ebeveynleri örtüktür. chunk "dir" girdisine yapılamaz. Aynı normalleştirilmiş yol (harf duyarsız)
// iki kez, "a" ile "a/b" birlikte ve boş bileşen reddedilir. Sıra anlamlıdır (entry indeksi).

export const XFER_CHUNK_BYTES = 3 * 1024 * 1024;
export const XFER_MAX_TOTAL_BYTES = 4 * 1024 ** 3;
export const XFER_MAX_ENTRIES = 10_000;
export const XFER_MAX_ACTIVE = 4;
export const XFER_MAX_INFLIGHT_CHUNKS = 4;
export const XFER_STAGING_QUOTA_BYTES = 8 * 1024 ** 3;
export const XFER_MIN_FREE_BYTES = 1024 ** 3;
export const XFER_IDLE_MS = 5 * 60_000;
export const XFER_STALE_MS = 24 * 3600_000;
export const XFER_STAGING_DIR = ".vlad-incoming";
export const XFER_ID_RE = /^[0-9a-f]{32}$/;

export type XferPurpose = "file" | "clip-image";
export interface XferEntry { path: string; kind: "file" | "dir"; size: number }
export interface XferBeginArgs { id: string; purpose: XferPurpose; entries: XferEntry[]; meta?: Record<string, string | number> }
export interface XferBeginResult { id: string; chunkBytes: number; state: "new" | "receiving" | "committed"; received?: number[]; items?: XferItem[] }
export interface XferChunkArgs { id: string; entry: number; offset: number; data: string }
export interface XferChunkResult { received: number }
export interface XferCommitArgs { id: string; sha256: (string | null)[] }
export interface XferItem { name: string; kind: "file" | "dir"; size: number; path: string }
export interface XferCommitResult { items: XferItem[]; failed?: { name: string; error: string }; clip?: "applied" | "stale" | "disabled" | "invalid" }
export interface XferAbortArgs { id: string }
export type ClipImageResult = "applied" | "stale" | "disabled" | "invalid";
export interface ClipImageSink { enabled(): boolean; apply(png: Buffer, meta: { eventTs: number; rank: 0 | 1 }, from: string): Promise<ClipImageResult> }

/** K'daki latch/ENOSPC enjeksiyonu için test kancaları. */
export interface XferTestHooks { beforePublish?(item: string): Promise<void>; afterChunk?(id: string, offset: number): Promise<void> }
export interface XferFs {
  statfs(p: string): Promise<{ bavail: number; bsize: number }>;
  link: typeof import("node:fs/promises").link;
  rename: typeof import("node:fs/promises").rename;
  copyFile: typeof import("node:fs/promises").copyFile;
}
export interface XferDeps {
  downloads(): string; stateDir(): string; os: Os; notifier: Notifier; now(): number; sleep?(ms: number): Promise<void>;
  clipImage?: ClipImageSink; fs?: Partial<XferFs>; hooks?: XferTestHooks;
  /** Yayımlanan her dosyaya köken işareti (MotW/quarantine); yoksa işaret yazılmaz. Hata teslimi bozmaz. */
  markOrigin?: OriginMarker;
  /** false: testte zamanlayıcı kurulmaz. */
  idleTimers?: boolean;
}

export interface AktarimDeps { self: string; kind: AgentKind; cfg(): VladConfig; now(): number; env(): AgentEnv; xfer: XferDeps; clip: ClipDeps }

export interface XferReceiver {
  ops: { "xfer-begin": OpHandler; "xfer-chunk": OpHandler; "xfer-commit": OpHandler; "xfer-abort": OpHandler };
  sweep(): Promise<number>;
  close(): Promise<void>;
}
export type LedgerRecord =
  | { state: "committing"; planned: string[]; published: string[] }
  | { state: "committed"; items: XferItem[]; manifestHash?: string }
  | { state: "aborted" };
export interface Ledger { get(key: string): Promise<LedgerRecord | undefined>; put(key: string, r: LedgerRecord): Promise<void> }
