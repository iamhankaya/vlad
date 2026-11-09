import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "../fleet/state.js";
import { JOURNAL_RETENTION_DAYS, type AgentOp, type OpMeta, type OpRecord } from "../fleet/types.js";

/** Günlükte saklanan sonuç üst sınırı (bayt); ötesi kırpılır (F-vlad-127). Canlı yanıt tam sonucu taşır, yalnız replay kırpılmış kaydı görür. */
const MAX_RESULT_BYTES = 64 * 1024;

/** Yan etkili işlemler: sonucu kırpılıp "bilinmiyor" bırakılırsa tekrar uygulanabilir; bunlar kırpma yerine küçük sabit özet saklar (F-vlad-152). */
const SUMMARIZED_OPS: ReadonlySet<AgentOp> = new Set<AgentOp>(["launch", "merge", "apply-write", "script-run"]);
const SUMMARY_STR_MAX = 256;
/** Skaler alanlar (exit, branch, worktree…) korunur, uzun dizgiler kısaltılır, iç içe/büyük değerler düşer. */
function summarize(result: unknown, bytes: number): Record<string, unknown> {
  const out: Record<string, unknown> = { __journalSummary: true, bytes };
  if (result && typeof result === "object") {
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v.length > SUMMARY_STR_MAX ? v.slice(0, SUMMARY_STR_MAX) + "…" : v;
      else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
      else if (k === "integration" && v && typeof v === "object") out[k] = summarize(v, 0); // launch'ın pipeline entegrasyon worktree'si commit'te gerekir
      else if (k === "truncated" && v && typeof v === "object" && Object.values(v).every((x) => typeof x === "boolean")) out[k] = v; // script-run: {stdout, stderr} kırpıldı bayrakları (iki bool)
    }
  }
  return out;
}

/** Günlük kaydı; `meta` yalnız uzlaştırmanın bıraktığı notlar (recovered/uncertain). */
export interface JournalRecord extends OpRecord { meta?: OpMeta; /** yalnız uzlaştırması argüman isteyen işlemlerde, `started` süresince */ args?: unknown }

/** opId günlüğü: tek satır JSON ekleme + fsync; bellekte opId → son durum. Tek süreç (Agent) sahibidir. */
export class Journal {
  private recs = new Map<string, JournalRecord>();
  private waiters = new Map<string, ((r: JournalRecord) => void)[]>();

  constructor(private file: string, private now: () => number) {
    ensurePrivateDir(dirname(file));
    let dropped = false;
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line) as JournalRecord; this.recs.set(r.opId, r); } catch { dropped = true; /* yarım satır */ }
      }
    }
    const cutoff = now() - JOURNAL_RETENTION_DAYS * 86_400_000;
    for (const [k, r] of this.recs) if (r.ts < cutoff) { this.recs.delete(k); dropped = true; }
    if (dropped) writeFileSync(file, [...this.recs.values()].map((r) => JSON.stringify(r) + "\n").join(""));
  }

  get(opId: string): JournalRecord | undefined { return this.recs.get(opId); }
  startedList(): JournalRecord[] { return [...this.recs.values()].filter((r) => r.state === "started"); }

  start(opId: string, from: string, op: AgentOp, argsHash: string, args?: unknown): void {
    this.put({ opId, from, op, state: "started", ts: this.now(), argsHash, ...(args !== undefined ? { args } : {}) });
  }
  /** `started` kaydın argümanına alan ekler (ör. betik sınıfı: uzlaştırma çalışırken mevcut HEAD'e değil buna bakar). */
  annotate(opId: string, extra: Record<string, unknown>): void {
    const r = this.recs.get(opId);
    if (r?.state === "started") this.put({ ...r, args: { ...(r.args && typeof r.args === "object" ? r.args : {}), ...extra } });
  }
  finish(opId: string, state: "done" | "aborted", result?: unknown, meta?: OpMeta): void {
    const prev = this.recs.get(opId);
    if (!prev) throw new Error(`günlükte yok: ${opId}`);
    const { args: _args, ...rest } = prev; // sonuçlanınca argüman günlükte tutulmaz
    const size = result === undefined ? 0 : Buffer.byteLength(JSON.stringify(result));
    const kept = size <= MAX_RESULT_BYTES ? result : SUMMARIZED_OPS.has(prev.op) ? summarize(result, size) : { __journalTruncated: true, bytes: size };
    const rec: JournalRecord = { ...rest, state, ts: this.now(), ...(kept !== undefined ? { result: kept } : {}), ...(meta ? { meta } : {}) };
    this.put(rec);
    for (const w of this.waiters.get(opId)?.splice(0) ?? []) w(rec);
  }
  /** Hiç görülmemiş opId'yi iptal edilmiş işaretler; sonradan gelen aynı opId reddedilir. */
  tombstone(opId: string, from: string): void {
    this.put({ opId, from, op: "launch", state: "aborted-cancelled", ts: this.now(), argsHash: "" });
  }
  /** Süreç içinde `started` olan işlemin bitmesini bekler. */
  waitFor(opId: string): Promise<JournalRecord> {
    const cur = this.recs.get(opId);
    if (cur && cur.state !== "started") return Promise.resolve(cur);
    return new Promise((res) => { const l = this.waiters.get(opId) ?? []; l.push(res); this.waiters.set(opId, l); });
  }

  private put(r: JournalRecord): void {
    this.recs.set(r.opId, r);
    const fd = openSync(this.file, "a");
    try { writeSync(fd, JSON.stringify(r) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  }
}
