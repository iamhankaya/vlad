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
  | "forward-write" | "queue-list" | "queue-flush" | "queue-drop";

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
export interface GateRunResult { exit: number; stdout: string; stderr: string; /** commit the gate ran on (F-vlad-139) */ head?: string }
/** `merge-preview`: log + diff --stat + merge-tree; yazmaz. */
export interface MergePreviewArgs { taskId: string; project: string; repoName: string; from: string; into: string }
export interface MergePreviewResult { log: string; diffStat: string; conflicts: string[] }
/** `merge`: faz → vlad/<çatı> ya da son kapıda ana dal; yalnız brain'den, görev/makine eşleşmeli. */
export interface MergeArgs { taskId: string; project: string; repoName: string; from: string; into: string; message?: string }
export interface MergeResult { head: string; merged: boolean }
