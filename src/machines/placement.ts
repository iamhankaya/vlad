import type { VladConfig } from "../kb/types.js";
import type { Task } from "../tasks/store.js";
import { machinesOf } from "./registry.js";
import type { HeldByLimit, HoldReason, Placement } from "./types.js";

export const RESERVATION_TTL_MS = 10 * 60_000;

export interface Load { load: Record<string, number>; expired: string[] }

/**
 * Makine yükü = `running` dev görevler (machine ?? brain) + rezervasyonlar. Süresi dolan rezervasyon yalnız brain'de
 * düşer; uzak makinede (belirsiz launch) iptal onayına kadar sayılır. Süresi dolanların kimlikleri `expired`'da.
 */
export function machineLoad(tasks: Task[], brain: string, now: number): Load {
  const load: Record<string, number> = {};
  const expired: string[] = [];
  for (const { data: d } of tasks) {
    if (d.kind !== "dev") continue;
    const m = d.machine ?? brain;
    let counts = d.state === "running";
    // yalnız bekleyen (queued) görevin rezervasyonu sayılır; running zaten sayıldı, terminal durumlardaki artık yok sayılır
    if (d.state === "queued" && d.machine && d.machine_reserved) {
      const stale = !(now - Date.parse(d.machine_reserved) <= RESERVATION_TTL_MS); // geçersiz tarih = süresi dolmuş
      if (stale) expired.push(d.id);
      counts = !stale || m !== brain;
    }
    if (counts) load[m] = (load[m] ?? 0) + 1;
  }
  return { load, expired };
}

/** Makine başına üst sınır: kendi `maxParallel`ı, yoksa genel; ikisi de yoksa sınırsız (undefined). */
export const capsOf = (cfg: VladConfig): Record<string, number | undefined> =>
  Object.fromEntries((cfg.machines ?? []).map((m) => [m.name, m.maxParallel ?? cfg.maxParallel]));

export type Pick = { machine: string } | { machine: null; reasons: { machine: string; reason: HoldReason }[] };

/** Sırayla: kapasite -> erişilebilirlik. Dolu aday için `reach` çağrılmaz; ilk uygun aday kazanır. */
export async function pickMachine(
  candidates: string[], load: Record<string, number>, caps: Record<string, number | undefined>,
  reach?: (m: string) => boolean | Promise<boolean>,
): Promise<Pick> {
  const reasons: { machine: string; reason: HoldReason }[] = [];
  for (const m of candidates) {
    if (isFull(m, load, caps)) reasons.push({ machine: m, reason: "dolu" });
    else if (reach && !(await reach(m))) reasons.push({ machine: m, reason: "erişilemez" });
    else return { machine: m };
  }
  return { machine: null, reasons };
}
const isFull = (m: string, load: Record<string, number>, caps: Record<string, number | undefined>) => {
  const cap = caps[m];
  return cap !== undefined && (load[m] ?? 0) >= cap;
};

export interface Simulated { placements: Placement[]; held: HeldByLimit[]; warnings: string[] }

/**
 * `task ready` önizlemesi (ağsız): hazır görevleri sırayla yerleştirir, yuvaları parti içinde tüketir.
 * Pipeline fazı yalnız çatının sabitlendiği makineye gider; çatı henüz sabit değilse ilk yerleşen faz sabitler.
 */
export function simulateReady(
  ready: Task[], all: Task[], cfg: VladConfig, cardOf: (project: string) => { machines?: string[] }, now: number,
): Simulated {
  const { load } = machineLoad(all, cfg.brain!, now);
  const caps = capsOf(cfg);
  const pinned = new Map(all.filter((t) => t.data.kind === "pipeline" && t.data.machine).map((t) => [t.data.id, t.data.machine!]));
  const out: Simulated = { placements: [], held: [], warnings: [] };
  for (const t of ready) {
    const { names, unknown } = machinesOf(cfg, cardOf(t.data.project));
    if (unknown.length) out.warnings.push(`${t.data.id}: kartta config'te olmayan makine atlandı: ${unknown.join(", ")}`);
    const pin = t.data.parent ? pinned.get(t.data.parent) : undefined;
    const cands = pin ? names.filter((n) => n === pin) : names;
    const free = cands.find((m) => !isFull(m, load, caps));
    if (free !== undefined) {
      load[free] = (load[free] ?? 0) + 1;
      out.placements.push({ id: t.data.id, machine: free });
      if (t.data.parent && !pinned.has(t.data.parent)) pinned.set(t.data.parent, free);
      continue;
    }
    const reasons: { machine: string; reason: HoldReason }[] = [
      ...(pin && !cands.length ? [{ machine: pin, reason: "tanımsız" as const }] : unknown.map((machine) => ({ machine, reason: "tanımsız" as const }))),
      ...cands.map((machine) => ({ machine, reason: "dolu" as const })),
    ];
    out.held.push({ id: t.data.id, reasons });
  }
  return out;
}
