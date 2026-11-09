// Bakım bayrağı + uçuştaki op sayımı (T20261109-10, spec S23/S24). `selfUpdate` betiği sürerken (ve yeniden başlatma beklenirken) Agent yeni op almaz:
// `npm ci` node_modules'ı siler, yarım dist'te çocuk süreç op'ları (launch/gate/merge/exec) çöker. Süreç içi durumdur; Agent yeniden başlayınca sıfırlanır.

/** Bakım sırasında da yanıtlanan, yan etkisiz op'lar: sağlık, uçuştaki sonucu sorgulama, betik listesi. */
export const MAINT_FREE_OPS: ReadonlySet<string> = new Set(["ping", "op-status", "script-list"]);

const flight = new Map<string, number>();
let on = false;

export const maint = {
  get on(): boolean { return on; },
  enter(): void { on = true; },
  leave(): void { on = false; },
  /** sunucu: bakımdan muaf olmayan her op işlenirken (aynı opId yinelenen istekte sayaç) */
  begin(opId: string): void { flight.set(opId, (flight.get(opId) ?? 0) + 1); },
  end(opId: string): void { const n = (flight.get(opId) ?? 0) - 1; if (n > 0) flight.set(opId, n); else flight.delete(opId); },
  /** kendi opId'si dışındaki uçuştaki op sayısı (opId başına bir) */
  others(opId: string): number { return flight.size - (flight.has(opId) ? 1 : 0); },
  inflight(): number { let n = 0; for (const c of flight.values()) n += c; return n; },
  reset(): void { on = false; flight.clear(); },
};
