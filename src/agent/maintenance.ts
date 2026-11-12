// Bakım bayrağı + uçuştaki op sayımı (T20261109-10, spec S23/S24). `selfUpdate` betiği sürerken (ve yeniden başlatma beklenirken) Agent yeni op almaz:
// `npm ci` node_modules'ı siler, yarım dist'te çocuk süreç op'ları (launch/gate/merge/exec) çöker. Süreç içi durumdur; Agent yeniden başlayınca sıfırlanır.

/** Bakım sırasında da yanıtlanan, yan etkisiz op'lar: sağlık, uçuştaki sonucu sorgulama, betik listesi. */
export const MAINT_FREE_OPS: ReadonlySet<string> = new Set(["ping", "op-status", "script-list"]);

export type MaintReason = "selfUpdate" | "recovery";
export interface InflightOp { opId: string; op: string; ageMs: number }
export interface MaintSnapshot { on: boolean; reason: MaintReason | null; sinceMs: number | null; attempts: number; stuck: boolean }

const flight = new Map<string, { n: number; op: string; since: number }>();
let on = false;
let reason: MaintReason | null = null, since = 0, attempts = 0, stuck = false;

export const maint = {
  get on(): boolean { return on; },
  enter(r: MaintReason = "selfUpdate"): void { on = true; reason = r; since = Date.now(); attempts = 0; stuck = false; },
  leave(): void { on = false; reason = null; attempts = 0; stuck = false; },
  /** kurtarma yeniden denemesi sayacı (F-vlad-274: ping'te görünür) */
  attempt(n: number): void { attempts = n; },
  /** kurtarma tavanı aşıldı: bayrak açık kalır (yarım node_modules ile op kabul edilmez) ama ping `stuck:true` gösterir */
  markStuck(): void { stuck = true; },
  snapshot(): MaintSnapshot { return { on, reason, sinceMs: on ? Date.now() - since : null, attempts, stuck }; },
  /** sunucu: bakımdan muaf olmayan her op işlenirken (aynı opId yinelenen istekte sayaç); `op` adı ping/busy mesajında görünür (F-vlad-278) */
  begin(opId: string, op = "?"): void { const c = flight.get(opId); if (c) c.n++; else flight.set(opId, { n: 1, op, since: Date.now() }); },
  end(opId: string): void { const c = flight.get(opId); if (!c) return; if (c.n > 1) c.n--; else flight.delete(opId); },
  /** kendi opId'si dışındaki uçuştaki op sayısı (opId başına bir) */
  others(opId: string): number { return flight.size - (flight.has(opId) ? 1 : 0); },
  /** uçuştaki op'ların listesi (opId, op adı, yaş); `except` hariç */
  list(except?: string): InflightOp[] { const t = Date.now(); return [...flight].filter(([id]) => id !== except).map(([opId, c]) => ({ opId, op: c.op, ageMs: t - c.since })); },
  inflight(): number { let n = 0; for (const c of flight.values()) n += c.n; return n; },
  reset(): void { on = false; reason = null; attempts = 0; stuck = false; flight.clear(); },
};
