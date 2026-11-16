import type { AckRecord, ChannelConfig, PendingRecord, RateState, ResultRecord } from "./types.js";

/**
 * SÖZLEŞME iskeleti (gövde U2'de). `<secretDir>/approver/` altında: channel.json, inbox/, claimed/, ack/, pending.json, claims/, results/, rate.json, approver.log, service.lock.
 * Tüm yol/izin/sembolik bağ denetimi `src/mode/secure-fs.ts` üzerinden; kimlikler `NAME_RE` ile doğrulanır (traversal). Bozuk dosyada fail-closed.
 * Yöntem adları ve anlamları sözleşmenin parçasıdır (U4 servisi bunlara yazar); değişiklik `vlad task ask` ile.
 */
export interface Store {
  readonly dir: string;
  readChannel(): ChannelConfig | null;
  /** inbox/ içindeki cid'ler; kota (≤ maxInboxFiles, ≤ maxInboxBytes) aşımı fazlasını siler ve `oversize` loglar. */
  listInbox(): string[];
  /** inbox/<cid>.json → claimed/<cid>.json `rename` (atomik; kaybeden null) sonra readSecureFile (≤ 8 KB). */
  claimInbox(cid: string): Buffer | null;
  writeAck(a: AckRecord): void;
  /** Bozuk/kesik/sembolik bağ/yanlış izin: fırlatır (çağıran fail-closed davranır). */
  readPending(): PendingRecord | null;
  writePending(p: PendingRecord): void;
  clearPending(): void;
  /** claims/<id> (karar) ya da claims/<id>.exec işaretçisi, `wx`; false = zaten var. */
  markClaim(id: string, kind: "decision" | "exec"): boolean;
  hasClaim(id: string, kind: "decision" | "exec"): boolean;
  writeResult(r: ResultRecord): void;
  readResult(id: string): ResultRecord | null;
  listResults(limit?: number): ResultRecord[];
  /** Bozuk/okunamaz rate.json fırlatır (servis `locked: rate_state_corrupt`; sayaç sıfırlanmaz). */
  readRate(): RateState;
  writeRate(s: RateState): void;
  /** approver.log (256 KB'de `.1`'e döner); satırda sır/gövde yok. */
  log(line: string): void;
  /** service.lock (`O_EXCL`, `{pid, startedAt}`); ölü pid devralınır; canlıysa "busy". */
  acquireLock(pid: number, now: Date): "acquired" | "busy";
  releaseLock(): void;
}

/** `dir` = approverDir() (üretim) ya da test dizini. */
export function createStore(dir: string): Store { void dir; throw new Error("not implemented"); }
