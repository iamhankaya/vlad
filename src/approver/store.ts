import { closeSync, constants, lstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { NAME_RE, assertSecureDir, readSecureFile, writeAtomic } from "../mode/secure-fs.js";
import { LIMITS, type AckRecord, type ChannelConfig, type Op, type PendingRecord, type PendingStatus, type RateState, type ResultRecord, type ResultStatus } from "./types.js";

/**
 * `<secretDir>/approver/` altında: channel.json, inbox/, claimed/, ack/, pending.json, claims/, results/, rate.json, approver.log, service.lock.
 * Tüm yol/izin/sembolik bağ denetimi `src/mode/secure-fs.ts` üzerinden; kimlikler `NAME_RE` ile doğrulanır (traversal). Bozuk dosyada fail-closed.
 * Yöntem adları ve anlamları sözleşmenin parçasıdır (U4 servisi bunlara yazar); değişiklik `vlad task ask` ile.
 */
export interface Store {
  readonly dir: string;
  readChannel(): ChannelConfig | null;
  /** inbox/ içindeki cid'ler; kota (≤ maxInboxFiles, ≤ maxInboxBytes) aşımı fazlasını siler ve `oversize` loglar. `.tmp-*` ve yabancı adlar sayılmaz. */
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

const OPS: readonly Op[] = ["mode night", "mode watch", "mode off", "install", "setup"];
const PENDING_STATUS: readonly PendingStatus[] = ["pending", "approved", "denied", "expired", "executing"];
const RESULT_STATUS: readonly ResultStatus[] = ["done", "failed", "interrupted", "denied", "expired"];
const LOG_MAX = 262_144, LOG_LINE_MAX = 1000, RESULT_TTL_MS = 7 * 86_400_000, REQUEST_MAX = 8192;

const obj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): x is string => typeof x === "string";
const strs = (x: unknown): x is string[] => Array.isArray(x) && x.every(str);
const bad = (what: string): never => { throw new Error(`${what} geçersiz (bozuk/şekilsiz): fail-closed`); };
const errno = (e: unknown, code: string): boolean => (e as NodeJS.ErrnoException).code === code;

function validChannel(x: unknown): ChannelConfig { if (!obj(x) || x.v !== 1 || !str(x.server) || !str(x.requestTopic) || !str(x.createdAt)) bad("channel.json"); return x as unknown as ChannelConfig; }
function validPending(x: unknown): PendingRecord {
  if (!obj(x) || x.v !== 1 || !str(x.id) || !NAME_RE.id.test(x.id) || !str(x.cid) || !NAME_RE.cid.test(x.cid) || !OPS.includes(x.op as Op) || !strs(x.argv) || !PENDING_STATUS.includes(x.status as PendingStatus)
    || !["shortId", "requestedAt", "expiresAt", "nonce", "respTopic", "digest", "keyGen", "requester"].every((k) => str(x[k])) || !obj(x.ctx) || !["home", "kb", "cli"].every((k) => str((x.ctx as Record<string, unknown>)[k]))) bad("pending.json");
  return x as unknown as PendingRecord;
}
function validResult(x: unknown): ResultRecord {
  if (!obj(x) || x.v !== 1 || !str(x.id) || !NAME_RE.id.test(x.id) || !RESULT_STATUS.includes(x.status as ResultStatus) || !str(x.stdout) || !str(x.stderr) || !str(x.finishedAt) || !(x.exitCode === null || typeof x.exitCode === "number")
    || (x.op !== undefined && !OPS.includes(x.op as Op)) || (x.argv !== undefined && !strs(x.argv)) || (x.requester !== undefined && !str(x.requester))) bad("sonuç kaydı");
  return x as unknown as ResultRecord;
}
function validRate(x: unknown): RateState {
  if (!obj(x) || x.v !== 1 || !strs(x.decisions) || !Number.isInteger(x.consecutiveDenied) || (x.consecutiveDenied as number) < 0 || !(x.lockedUntil === null || str(x.lockedUntil))) bad("rate.json");
  return x as unknown as RateState;
}
const checkId = (id: string): string => { if (!NAME_RE.id.test(id)) throw new Error("geçersiz kimlik"); return id; };

const REDACT: Array<[RegExp, string]> = [
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi, "[gizli]"], [/VMT[12]\.\S+/g, "[gizli]"], [/VLAD_MODE_TOKEN=\S*/g, "[gizli]"], [/--answers|SECRET-SENTINEL-[\w-]+/g, "[gizli]"], [/vlad-[qr]-[a-z2-7]{26}/g, "[gizli]"],
];
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return !errno(e, "ESRCH"); } };

/** `dir` = approverDir() (üretim) ya da test dizini. `o.now`: yalnız test için saat (budama/log damgası). */
export function createStore(dir: string, o: { now?: () => Date } = {}): Store {
  const now = o.now ?? (() => new Date());
  const sub = (name: string): string => { assertSecureDir(dir); const p = join(dir, name); assertSecureDir(p); return p; };
  const file = (name: string): string => { assertSecureDir(dir); return join(dir, name); };
  assertSecureDir(dir);
  for (const d of ["inbox", "claimed", "ack", "claims", "results"]) sub(d);
  let held: number | null = null;

  const readJson = <T>(path: string, max: number, valid: (x: unknown) => T): T | null => {
    let buf: Buffer;
    try { buf = readSecureFile(path, max); } catch (e) { if (errno(e, "ENOENT")) return null; throw e; }
    return valid(JSON.parse(buf.toString("utf8")));
  };
  const log = (line: string): void => {
    try {
      let text = line.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ");
      for (const [re, to] of REDACT) text = text.replace(re, to);
      const path = file("approver.log");
      try { if (lstatSync(path).size >= LOG_MAX) renameSync(path, `${path}.1`); } catch (e) { if (!errno(e, "ENOENT")) throw e; }
      const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, `${now().toISOString()} ${text.slice(0, LOG_LINE_MAX)}\n`); } finally { closeSync(fd); }
    } catch { /* log yazılamazsa servis çökmez */ }
  };
  const resultFiles = (): string[] => readdirSync(sub("results")).filter((f) => f.endsWith(".json") && NAME_RE.id.test(f.slice(0, -5)));
  const readResultFile = (name: string): ResultRecord | null => readJson(join(sub("results"), name), LIMITS.maxOutputBytes * 2 + 4096, validResult);
  const prune = (): void => {
    for (const f of resultFiles()) {
      try { const r = readResultFile(f); if (r && now().getTime() - Date.parse(r.finishedAt) > RESULT_TTL_MS) unlinkSync(join(sub("results"), f)); } catch { /* bozuk dosya listede loglanır; budama en iyi çaba */ }
    }
  };
  const claimPath = (id: string, kind: "decision" | "exec"): string => join(sub("claims"), checkId(id) + (kind === "exec" ? ".exec" : ""));

  return {
    dir,
    readChannel: () => readJson(file("channel.json"), 4096, validChannel),
    listInbox() {
      const d = sub("inbox");
      const ents = readdirSync(d).filter((f) => /^[a-z2-7]{26}\.json$/.test(f)).flatMap((f) => {
        const s = lstatSync(join(d, f));
        return s.isFile() ? [{ cid: f.slice(0, -5), size: s.size, t: s.mtimeMs }] : [];
      }).sort((a, b) => a.t - b.t || (a.cid < b.cid ? -1 : 1));
      const kept: string[] = []; let total = 0;
      for (const e of ents) {
        if (kept.length < LIMITS.maxInboxFiles && total + e.size <= LIMITS.maxInboxBytes) { kept.push(e.cid); total += e.size; continue; }
        try { unlinkSync(join(d, `${e.cid}.json`)); } catch { /* başkası aldı */ }
        log(`inbox oversize: ${e.cid} silindi (${e.size} bayt)`);
      }
      return kept;
    },
    claimInbox(cid) {
      checkId(cid);
      const to = join(sub("claimed"), `${cid}.json`);
      try { renameSync(join(sub("inbox"), `${cid}.json`), to); } catch (e) { if (errno(e, "ENOENT")) return null; throw e; }
      return readSecureFile(to, REQUEST_MAX);
    },
    writeAck(a) { writeAtomic(join(sub("ack"), `${checkId(a.cid)}.json`), JSON.stringify(a), { overwrite: true }); },
    readPending: () => readJson(file("pending.json"), 16_384, validPending),
    writePending(p) { checkId(p.id); writeAtomic(file("pending.json"), JSON.stringify(p), { overwrite: true }); },
    clearPending() { try { unlinkSync(file("pending.json")); } catch (e) { if (!errno(e, "ENOENT")) throw e; } },
    markClaim(id, kind) {
      try { closeSync(openSync(claimPath(id, kind), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)); return true; } catch (e) { if (errno(e, "EEXIST")) return false; throw e; }
    },
    hasClaim(id, kind) { try { lstatSync(claimPath(id, kind)); return true; } catch (e) { if (errno(e, "ENOENT")) return false; throw e; } },
    writeResult(r) {
      writeAtomic(join(sub("results"), `${checkId(r.id)}.json`), JSON.stringify(r), { overwrite: false });
      prune();
    },
    readResult(id) { return readResultFile(`${checkId(id)}.json`); },
    listResults(limit) {
      prune();
      const out: ResultRecord[] = [];
      for (const f of resultFiles()) { try { const r = readResultFile(f); if (r) out.push(r); } catch (e) { log(`results: ${f} okunamadı (${(e as Error).message})`); } }
      out.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt) || (a.id < b.id ? -1 : 1));
      return limit === undefined ? out : out.slice(0, limit);
    },
    readRate: () => readJson(file("rate.json"), 16_384, validRate) ?? { v: 1, decisions: [], consecutiveDenied: 0, lockedUntil: null },
    writeRate(s) { writeAtomic(file("rate.json"), JSON.stringify(s), { overwrite: true }); },
    log,
    acquireLock(pid, at) {
      const path = file("service.lock");
      const mine = JSON.stringify({ pid, startedAt: at.toISOString() });
      for (let i = 0; i < 2; i++) {
        try { writeAtomic(path, mine, { overwrite: false }); held = pid; return "acquired"; } catch (e) { if (!errno(e, "EEXIST")) throw e; }
        let rec: unknown, raw: string;
        try { raw = readSecureFile(path, 1024).toString("utf8"); rec = JSON.parse(raw); } catch (e) { if (errno(e, "ENOENT")) continue; throw e; }
        if (!obj(rec) || !Number.isInteger(rec.pid) || (rec.pid as number) < 1 || !str(rec.startedAt)) bad("service.lock");
        if (alive((rec as { pid: number }).pid)) return "busy";
        try { if (readSecureFile(path, 1024).toString("utf8") === raw) unlinkSync(path); } catch (e) { if (!errno(e, "ENOENT")) throw e; } // bayat kilit: yalnız değişmediyse sil
      }
      return "busy";
    },
    releaseLock() {
      if (held === null) return;
      const path = file("service.lock");
      try {
        const rec = JSON.parse(readSecureFile(path, 1024).toString("utf8")) as { pid?: number };
        if (rec.pid === held) unlinkSync(path);
      } catch { /* yok ya da bozuk: silinecek kendi kilidimiz yok */ }
      held = null;
    },
  };
}
