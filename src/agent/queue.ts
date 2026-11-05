import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../fleet/state.js";
import { RemoteError, type QueueEntry, type WriteArgs } from "../fleet/types.js";

export const QUEUE_MAX_ENTRIES = 1000;
export const QUEUE_MAX_BYTES = 64 * 1024 * 1024;

export interface QueueItem extends WriteArgs {
  seq: number;
  opId: string;
  state: QueueEntry["state"];
  ts: number;
  /** Son durdurma/başarısızlık gerekçesi (kuyrukta kalan ya da failed/ altındaki giriş için). */
  reason?: string;
}

/** Kalıcı hata: girdi failed/ altına gider ve aynı görevin sonraki girdileri de onu izler. auth/proto_mismatch/geçici hatalar kuyruğu durdurur, girdi kalır. */
const PERMANENT: ReadonlySet<string> = new Set(["forbidden", "failed", "bad_request", "not_found", "conflict", "too_large"]);

const name = (seq: number, opId: string) => `${String(seq).padStart(8, "0")}-${opId}.json`;

/**
 * İşçi tarafı sıralı kuyruk: tek süreç (yerel Agent) sahibidir, dosya kilidi gerekmez.
 * Her girdi atomik yazılan (tmp + rename) tek dosyadır: `<dir>/NNNNNNNN-<opId>.json`; kalıcı hatalılar `<dir>/failed/`.
 */
export class AgentQueue {
  private flushing: Promise<unknown> | null = null;
  private count = 0;
  private bytes = 0;
  private seqNo = 0;
  /** Açılışta geçici hatayla (EBUSY/EPERM) okunamayan dosyalar: inflight olabilirler, drain öncesi yeniden denenir (F-vlad-155). */
  private unrecovered = new Set<string>();
  constructor(private dir: string, private now: () => number) {
    ensurePrivateDir(join(dir, "failed"));
    for (const d of [dir, join(dir, "failed")]) for (const f of readdirSync(d)) if (f.endsWith(".tmp")) rmSync(join(d, f), { force: true });
    for (const f of readdirSync(dir)) if (f.endsWith(".json") && this.read(join(dir, f)) === null) renameSync(join(dir, f), join(dir, "failed", f)); // bozuk JSON → failed (geçici okuma hatası: yerinde kalır)
    for (const f of this.files()) this.unrecovered.add(f);
    this.recover();
    for (const f of this.files()) { this.count++; this.bytes += statSync(join(dir, f)).size; }
    const seqFile = join(dir, ".seq");
    const saved = existsSync(seqFile) ? parseInt(readFileSync(seqFile, "utf8"), 10) || 0 : 0;
    const onDisk = [...this.files(), ...readdirSync(join(dir, "failed")).filter((f) => f.endsWith(".json"))].reduce((m, f) => Math.max(m, parseInt(f, 10) || 0), 0);
    this.seqNo = Math.max(saved, onDisk);
  }
  /** Çökme kalıntısı inflight girdileri pending'e çevirir (aynı opId beyinde idempotent); okunamayanlar sonraki denemeye kalır. */
  private recover(): void {
    for (const f of [...this.unrecovered]) {
      const p = this.read(join(this.dir, f));
      if (p === undefined) continue;
      if (p?.state === "inflight") this.write(join(this.dir, f), { ...p, state: "pending" });
      this.unrecovered.delete(f);
    }
  }
  private unlink(file: string): void { // sayaçları tutarlı tutan tek silme noktası
    this.bytes -= statSync(file).size; this.count--; rmSync(file);
  }

  /** null = girdi bozuk (ayrıştırılamaz/biçim yanlış); undefined = geçici okuma hatası (EBUSY/EPERM…): girdi sağlam olabilir, yerinde bırakılır (F-vlad-136). */
  private read(file: string): QueueItem | null | undefined {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined; }
    try {
      const it = JSON.parse(text) as QueueItem;
      return typeof it.seq === "number" && typeof it.opId === "string" ? it : null;
    } catch { return null; }
  }
  private write(file: string, it: QueueItem): void {
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(it));
    renameSync(tmp, file);
  }
  private files(): string[] { return readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort(); }
  private nextSeq(): number {
    this.seqNo++;
    writeFileSync(join(this.dir, ".seq"), String(this.seqNo)); // silinen/failed numaralar tekrar kullanılmaz
    return this.seqNo;
  }

  /** Bekleyen + devam eden girdiler (sıralı). */
  pending(): QueueItem[] { return this.files().map((f) => this.read(join(this.dir, f))).filter((x): x is QueueItem => !!x); }
  isEmpty(): boolean { return this.count === 0; }

  enqueue(w: WriteArgs & { opId: string }, state: "pending" | "inflight" = "pending"): QueueItem {
    if (this.count >= QUEUE_MAX_ENTRIES || this.bytes >= QUEUE_MAX_BYTES) throw new RemoteError("busy", "busy: kuyruk dolu", "");
    const it: QueueItem = { ...w, seq: this.nextSeq(), state, ts: this.now() };
    const file = join(this.dir, name(it.seq, it.opId));
    this.write(file, it);
    this.count++; this.bytes += statSync(file).size;
    return it;
  }
  /** `known`: çağıranın elindeki girdi; dosya okunamıyorsa/bozuksa geçiş onunla yazılır (okuma hatası başarı sayılmaz). */
  setState(seq: number, state: "pending" | "inflight", reason?: string, known?: QueueItem): void {
    const f = this.files().find((x) => parseInt(x, 10) === seq);
    if (!f) return;
    const it = known ?? this.read(join(this.dir, f));
    if (!it) throw new Error(`kuyruk girdisi okunamadı (seq ${seq}); durum ${state} yapılamadı`);
    this.write(join(this.dir, f), { ...it, state, ...(reason ? { reason } : {}) });
  }
  remove(seq: number): boolean {
    for (const d of [this.dir, join(this.dir, "failed")]) {
      const f = readdirSync(d).find((x) => x.endsWith(".json") && parseInt(x, 10) === seq);
      if (f) { if (d === this.dir) this.unlink(join(d, f)); else rmSync(join(d, f)); return true; }
    }
    return false;
  }
  private fail(file: string, it: QueueItem, reason: string): void {
    this.write(join(this.dir, "failed", name(it.seq, it.opId)), { ...it, state: "failed", reason });
    this.unlink(join(this.dir, file));
  }

  list(): QueueEntry[] {
    const failedDir = join(this.dir, "failed");
    const failed = readdirSync(failedDir).filter((f) => f.endsWith(".json")).sort().map((f) => this.read(join(failedDir, f))).filter((x): x is QueueItem => !!x);
    return [...this.pending(), ...failed].map((i) => ({ seq: i.seq, opId: i.opId, cmd: i.cmd, id: i.id, state: i.state }));
  }

  /**
   * Sıradan gönderir. `send` başarıyla döner → silinir; RemoteError: kalıcı → failed/ (+ aynı görevin kalanı), diğer → durur.
   * Süren bir boşaltma varsa bitmesini bekler, kalanı kendisi boşaltır; inflight (doğrudan gönderim) girdide durur.
   */
  async flush(send: (it: QueueItem) => Promise<unknown>): Promise<{ sent: number; failed: number; remaining: number }> {
    while (this.flushing) await this.flushing.catch(() => undefined); // süren boşaltma bitsin; kalanı bu çağrı boşaltır
    const run = this.drain(send);
    this.flushing = run;
    try { return await run; } finally { this.flushing = null; }
  }
  private async drain(send: (it: QueueItem) => Promise<unknown>): Promise<{ sent: number; failed: number; remaining: number }> {
    const r = { sent: 0, failed: 0, remaining: 0 };
    this.recover();
    {
      const poisoned = new Map<string, number>(); // görev id → başarısız ilk seq
      for (const f of this.files()) {
        const it = this.read(join(this.dir, f));
        if (it === undefined) break; // geçici okuma hatası: sırayı durdur, girdi kalır, sonraki turda denenir
        if (!it) { if (existsSync(join(this.dir, f))) renameSync(join(this.dir, f), join(this.dir, "failed", f)); continue; } // çalışırken yazılmış bozuk girdi (sayaçta yok)
        if (it.state === "inflight") break;
        const prev = poisoned.get(it.id);
        if (prev !== undefined) { this.fail(f, it, `önceki başarısız: ${prev}`); r.failed++; continue; }
        try { await send(it); this.unlink(join(this.dir, f)); r.sent++; } catch (e) {
          const code = e instanceof RemoteError ? e.code : "failed";
          if (PERMANENT.has(code)) { this.fail(f, it, `${code}: ${(e as Error).message}`); poisoned.set(it.id, it.seq); r.failed++; continue; }
          this.write(join(this.dir, f), { ...it, reason: (e as Error).message });
          break;
        }
      }
    }
    r.remaining = this.count;
    return r;
  }
  exists(): boolean { return existsSync(this.dir); }
}
