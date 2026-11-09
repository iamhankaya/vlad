// Sözleşme (T20261101-21, plan T20261101-20): çoklu makine tipleri. Davranış yok; A/B/C fazları bu şekle bağlanır.
// Değişiklik gerekirse `vlad task ask` ile sor.

export type Os = "win32" | "darwin" | "linux";

export interface MachineDef {
  /** ^[a-z][a-z0-9-]*$ */
  name: string;
  os: Os;
  /** host: IP ya da ad ^[A-Za-z0-9.-]+$ ('-' ile başlamaz); port 1024-65535 (varsayılan 7437). */
  agent: { host?: string; port: number; bind?: string }; // host brain dışındaki makinelerde zorunlu (config doğrular), IPv6 yok; port zorunlu, DEFAULT_AGENT_PORT yalnız önerilen değer
  /** Yoksa genel maxParallel. */
  maxParallel?: number;
  /** İşçinin kendi `{repo}-wt` kalıbı; yoksa genel worktreeDir. */
  worktreeDir?: string;
  /** İşçide repo arama kökleri. */
  roots?: string[];
  /** İşçide kb klonu (yoksa VLAD_HOME/kb). */
  kbDir?: string;
}
/** Kullanıcının kendisi (vlad-desktop/telefon); ayrı kimlik ve anahtar. */
export interface ConsoleDef { name: string }

export const DEFAULT_AGENT_PORT = 7437;
export const PROTO_VERSION = 1;

/** izinli saat farkı (ms) ve replay penceresi (gün) — sözleşme sabitleri */
export const CLOCK_SKEW_MS = 120_000;
export const JOURNAL_RETENTION_DAYS = 14;
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_CONNECTIONS = 16;

export interface LocalSettings {
  /** Bu makinenin kimliği (VLAD_MACHINE önceliklidir). */
  self?: string;
  /** kimlik adı -> 64 hex anahtar */
  keys: Record<string, string>;
}

export type IdentityRole = "brain" | "worker" | "console";

export type AgentOp =
  | "ping" | "op-status" | "kb-sync" | "launch" | "resume" | "close" | "cleanup" | "liveness" | "probe-window"
  | "gate-run" | "merge-preview" | "merge"
  | "apply-write" | "exec" | "kb-head"
  | "forward-write" | "queue-list" | "queue-flush" | "queue-drop"
  | "xfer-begin" | "xfer-chunk" | "xfer-commit" | "xfer-abort" | "clip-push" // aktarım (T20261105-03 sözleşmesi)
  | "script-list" | "script-run"; // kayıtlı bakım betikleri (T20261109-03 sözleşmesi, T20261109-05)

export type AgentCode =
  | "ok" | "bad_request" | "auth" | "clock_skew" | "proto_mismatch" | "forbidden" | "not_found" | "conflict"
  | "busy" | "failed" | "uncertain" | "too_large" | "unreachable" | "timeout";

/** Telde `unreachable|timeout` yalnız istemcide üretilir. */
export type WireCode = Exclude<AgentCode, "unreachable" | "timeout">;

export interface AgentRequest {
  v: number;
  from: string;
  to: string;
  /** UUID, istemci üretir */
  opId: string;
  /** istemci epoch ms */
  ts: number;
  op: AgentOp;
  args: unknown;
  sig: string;
}
export interface AgentResponse {
  v: number;
  opId: string;
  ok: boolean;
  code: WireCode;
  result?: unknown;
  error?: string;
  serverTs: number;
  build: string;
  sig: string;
}

export interface OpRecord {
  opId: string;
  from: string;
  op: AgentOp;
  state: "started" | "done" | "aborted" | "aborted-cancelled";
  ts: number;
  argsHash: string;
  result?: unknown;
}

export type WriteCmd = "task.log" | "task.ask" | "task.report" | "task.session";
export interface WriteArgs { cmd: WriteCmd; id: string; text?: string; sessionId?: string; json?: boolean }
export interface ExecResult { stdout: string; stderr: string; exit: number }

export interface QueueEntry {
  seq: number;
  opId: string;
  cmd: WriteCmd;
  id: string;
  state: "pending" | "inflight" | "failed";
}

export interface OpMeta { replayed?: boolean; recovered?: boolean; uncertain?: boolean }

export interface RemoteTransport {
  /** Başarısızlıkta RemoteError fırlatır. `as`: kimlik adı (varsayılan self). */
  call<T = unknown>(
    to: string, op: AgentOp, args: unknown,
    o?: { opId?: string; timeoutMs?: number; as?: string },
  ): Promise<{ opId: string; result: T; meta?: OpMeta }>;
}

export class RemoteError extends Error {
  constructor(public code: AgentCode, message: string, public machine: string = "") {
    super(message);
    this.name = "RemoteError";
  }
  /** Geçici: yeniden denenebilir (CLI çıkış kodu 75). */
  get transient(): boolean {
    return TRANSIENT_CODES.has(this.code);
  }
}
export const TRANSIENT_CODES: ReadonlySet<AgentCode> = new Set<AgentCode>(["unreachable", "timeout", "busy", "clock_skew"]);

export interface Placement { id: string; machine: string }
export type HoldReason = "dolu" | "erişilemez" | "tanımsız";
export interface HeldByLimit { id: string; reasons: { machine: string; reason: HoldReason }[] }

// Kapı işlemleri (brain → worker Agent; push YOK). Gövdeleri sonraki fazlar bağlar; şekil sözleşmedir.
/** `gate-run`: kartın gate komutunu entegrasyon worktree'sinde koşar (yolu işçi kendi hesaplar). */
export interface GateRunArgs { taskId: string; project: string; repoName: string; target: "integration" | "task" }
export interface GateRunResult { exit: number; stdout: string; stderr: string; /** commit the gate ran on (F-vlad-139) */ head?: string; /** HEAD before the gate, set only when the gate moved HEAD (F-vlad-154) */ headBefore?: string }
/** `merge-preview`: log + diff --stat + merge-tree; yazmaz. */
export interface MergePreviewArgs { taskId: string; project: string; repoName: string; from: string; into: string }
export interface MergePreviewResult { log: string; diffStat: string; conflicts: string[] }
/** `merge`: faz → vlad/<çatı> ya da son kapıda ana dal; yalnız brain'den, görev/makine eşleşmeli. */
export interface MergeArgs { taskId: string; project: string; repoName: string; from: string; into: string; message?: string }
export interface MergeResult { head: string; merged: boolean }

// Kayıtlı bakım betikleri (T20261109-03 çatısı, sözleşme T20261109-05). Davranış yok; uygulama fazları bu şekle bağlanır.
// Yeni AgentCode eklenmez: neden, hata mesajında köşeli parantezle taşınır (`forbidden [dirty]`); istemci tanımadığı kodu geçersiz sayar.
export type ScriptPlatform = Os;
export type ScriptClass = "read" | "write";

export const SCRIPT_PARAM_TYPES = ["string", "enum", "int", "bool", "root"] as const;
export type ScriptParamType = (typeof SCRIPT_PARAM_TYPES)[number];

/** Hata mesajındaki makine okunur neden: `<AgentCode> [<neden>]`; `bad_param` için `[bad_param:<ad>]`. */
export const SCRIPT_REASONS = [
  "bad_name", "bad_param", "unregistered", "no_variant",
  "dirty", "hash_mismatch", "not_regular", "not_in_head", "unpushed", "no_upstream", "approval",
  "bad_manifest", "no_repo",
] as const;
export type ScriptReason = (typeof SCRIPT_REASONS)[number];

/** ad: `^[a-z][a-z0-9-]{0,47}$`; manifest araması `Map` ile yapılır (`__proto__` anahtar olmaz). */
export const SCRIPT_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/;
/** Düz `agent-scripts/` dizini; yorumlayıcı uzantıdan türer (`.ps1` yalnız win32, `.sh` yalnız darwin|linux). */
export const SCRIPT_FILE_RE = /^agent-scripts\/[a-z0-9][a-z0-9._-]{0,63}\.(ps1|sh)$/;
/** Yapılandırılmış sonuç satırı: stdout'un son 20 satırında, sondan ilk eşleşme `@@VLAD-RESULT@@ {json}`. */
export const SCRIPT_RESULT_SENTINEL = "@@VLAD-RESULT@@";
/** Toplam sonuç journal tavanının (64 KiB, journal.ts) altında kalır: stdout 32 + stderr 16 + sonuç JSON'u 16. */
export const SCRIPT_LIMITS = {
  manifestMaxBytes: 64 * 1024, stdoutKb: 32, stderrKb: 16, resultJsonKb: 16, timeoutSecMax: 3600, outputMaxKbMax: 32, paramMaxLen: 256,
} as const;

export type ScriptParamSpec =
  | { name: string; type: "string"; required?: boolean; default?: string; /** zorunlu; varsayılan ^[A-Za-z0-9._-]+$ */ pattern?: string; maxLen?: number }
  | { name: string; type: "enum"; required?: boolean; default?: string; values: string[] }
  | { name: string; type: "int"; required?: boolean; default?: number; min?: number; max?: number }
  | { name: string; type: "bool"; required?: boolean; default?: boolean }
  /** değer işçinin config'indeki `machines[].roots` girişlerinden biri; yol Agent'ta çözülür */
  | { name: string; type: "root"; required?: boolean; default?: string };

/** `agent-scripts/manifest.json` giriş satırı; (name, platform) tekil. */
export interface ScriptEntry {
  name: string;
  /** yalnız gösterim */
  title: string;
  platform: ScriptPlatform;
  file: string;
  /** blob baytlarının (git cat-file, filtresiz) küçük harf hex SHA-256'sı */
  sha256: string;
  class: ScriptClass;
  /** 1..SCRIPT_LIMITS.timeoutSecMax */
  timeoutSec: number;
  /** 1..SCRIPT_LIMITS.outputMaxKbMax */
  outputMaxKb: number;
  selfUpdate: boolean;
  params: ScriptParamSpec[];
}
export interface ScriptManifest { version: 1; scripts: ScriptEntry[] }

export type ScriptIntegrity = "ok" | "hash_mismatch" | "dirty" | "not_regular" | "not_in_head";
/** `script-list` sonucundaki giriş: manifest satırı + bütünlük durumu. */
export interface ScriptInfo extends ScriptEntry { integrity: ScriptIntegrity }
/** `script-list`: args `{}`; salt okuma, günlüksüz. */
export interface ScriptListResult { head: string; platform: ScriptPlatform; scripts: ScriptInfo[] }

/** `script-run`: write sınıfı için `approval.planId` zorunlu (plan-id bağlı onay; Agent kendi manifestinden hesaplayıp karşılaştırır). */
export interface ScriptRunArgs { name: string; params?: Record<string, string>; approval?: { planId: string } }
/**
 * Betik başladıktan sonra hiçbir yol fırlatmaz (journal `aborted` olup aynı opId yeniden koşmasın): zaman aşımı, exit≠0,
 * sentinel eksikliği ve yeniden başlatma isteği sonuç alanıdır. `restart` yalnız Agent koyar (betiğin JSON'undaki yok sayılır).
 */
export interface ScriptRunResult {
  name: string; platform: ScriptPlatform; head: string; sha256: string;
  /** zaman aşımında 124 */
  exit: number; timedOut: boolean; durationMs: number;
  stdout: string; stderr: string; truncated: { stdout: boolean; stderr: boolean };
  /** sentinel satırındaki JSON nesnesi (≤ resultJsonKb) ya da null */
  data: Record<string, unknown> | null;
  dataError?: "no_result_line" | "bad_json" | "too_large";
  /** yalnız selfUpdate && exit==0 && data.ok==true iken */
  restart?: "scheduled";
}
