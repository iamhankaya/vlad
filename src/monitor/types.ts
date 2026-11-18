import type { Severity } from "./contract.js";

/**
 * SÖZLEŞME (T20261119-20, çatı T20261119-18): `vlad monitor` tipleri, sabitleri, imza ve JSON şekilleri. Gövdeler uygulama fazında.
 * Konum: `src/monitor/` (L2). Değişmemesi gerekenler: MONITOR_LIMITS değerleri, `--json` çıktı şekli, işaret satırı biçimi,
 * hata kodları ve çıkış kodu eşlemesi, durum dosyası şeması (v1). Sonradan değişiklik: `vlad task ask`.
 */

/** Sunucu kimliği: spc `servers/health.json` `id` kuralıyla aynı. */
export const MONITOR_SERVER_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface MonitorServerConfig {
  id: string;
  /** Ajan kök adresi (http/https); `/spc/v1/alerts` istemci tarafından eklenir. */
  agent_url: string;
  /** Görevlerin açılacağı proje slug'ı (kb'de kartı olmalı). Varsayılan projeye düşülmez. */
  project: string;
}
/** `vlad.config.json` → `monitor` bölümü (sır yok; belirteç Keychain'de). */
export interface MonitorConfig { servers: MonitorServerConfig[] }

export const MONITOR_LIMITS = {
  /** Sunucu başına çekişte açılabilecek en çok yeni görev (görev seli sınırı); aşımda `task_limit` hatası. */
  maxNewTasksPerPull: 5,
  /** Ardışık erişilemezlikte `monitor status` uyarısı eşiği. */
  failStreakWarn: 3,
  requestTimeoutMs: 10_000,
  /** `limit` sorgu parametresi (spc üst sınırı 500). */
  pageLimit: 500,
  /** Sayfa tavanı; aşılırsa hata (`page_limit`), imleç ilerlemez. */
  maxPages: 20,
  titleMax: 120,
  launchdIntervalSec: 300,
} as const;

/** Hata kodları (`--json` `errors[].code`). */
export type MonitorErrorCode =
  | "unreachable" | "unauthorized" | "schema_mismatch" | "keychain" | "task_limit" | "page_limit"
  | "config" | "kb_busy" | "unsupported_platform";
export const MONITOR_ERROR_CODES: readonly MonitorErrorCode[] = [
  "unreachable", "unauthorized", "schema_mismatch", "keychain", "task_limit", "page_limit", "config", "kb_busy", "unsupported_platform",
];
export interface MonitorError { server: string | null; code: MonitorErrorCode; message: string }

/** Çıkış kodu: 0 tamam; 1 en az bir sunucu hatası/şema uyumsuzluğu; 2 yapılandırma/altyapı (config, keychain, kb_busy, unsupported_platform). En kötüsü kazanır. */
export const MONITOR_EXIT = { ok: 0, serverError: 1, infra: 2 } as const;
export const EXIT_BY_CODE: Readonly<Record<MonitorErrorCode, 0 | 1 | 2>> = {
  unreachable: 1, unauthorized: 1, schema_mismatch: 1, task_limit: 1, page_limit: 1,
  config: 2, keychain: 2, kb_busy: 2, unsupported_platform: 2,
};

export interface PullOptions {
  /** Yalnız bu sunucu; bilinmeyen ad `config` hatası. */
  server?: string;
  /** Yazma yok (görev, not, durum dosyası); ne yapacağını döker. */
  dryRun?: boolean;
}

export interface ServerPullResult {
  id: string;
  ok: boolean;
  fetched: number;
  opened: { alert_id: string; task: string }[];
  noted: { alert_id: string; task: string }[];
  logged: { alert_id: string; severity: Severity }[];
  skipped: number;
}
/** `vlad monitor pull --json` çıktısı. Belirteç alanı yok. */
export interface PullResult { servers: ServerPullResult[]; errors: MonitorError[] }

/** Makineye yerel durum (`~/.vlad-monitor/state.json`, dizin 0700, dosya 0600, atomik yazma). Sır içermez. */
export interface AlertTaskEntry { task: string; firing_noted: boolean; resolved_noted: boolean }
export interface ServerState {
  epoch: string | null;
  /** Opak spc imleci; yalnız görev/not yazıldıktan SONRA ilerler (at-least-once + işaretle idempotent). */
  cursor: string | null;
  last_ok: number | null;
  fail_streak: number;
  /** alert_id → görev eşlemesi. */
  tasks: Record<string, AlertTaskEntry>;
}
export interface MonitorState { v: 1; servers: Record<string, ServerState> }
export const EMPTY_STATE: MonitorState = { v: 1, servers: {} };

/** Belirteç okuyucu (Keychain); testte sahte. Dönen değer yalnız bellekte tutulur, hiçbir çıktıya girmez. Kayıt yoksa null. */
export interface SecretReader { read(service: string): Promise<string | null> }

export interface PullDeps {
  home: string;
  config: MonitorConfig;
  secrets: SecretReader;
  /** Varsayılan global fetch (testte yerel sahte sunucuya). */
  fetch?: typeof fetch;
  now?: () => number;
  /** Durum dosyası dizini (varsayılan `~/.vlad-monitor`; testte geçici dizin). */
  stateDir?: string;
  platform?: NodeJS.Platform;
  /** İstek zaman aşımı (ms); varsayılan MONITOR_LIMITS.requestTimeoutMs (testte kısaltılır). */
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ServerStatus {
  id: string;
  project: string;
  cursor: string | null;
  last_ok: number | null;
  fail_streak: number;
  /** fail_streak ≥ failStreakWarn → "erişilemez ×N" gösterilir. */
  unreachable: boolean;
  open_tasks: { alert_id: string; task: string }[];
}
export interface MonitorStatus {
  servers: ServerStatus[];
  service: { installed: boolean; running: boolean; detail: string } | null;
}

/** Görev başlığı/gövdesi (şablon `task-text.ts`'te): işaret satırı `spc-alert: <server>/<alert_id>` gövdede tek başına satırdır. */
export interface AlertTaskText { title: string; description: string }
