import { readLocal, selfName } from "../agent/state.js";
import type { VladConfig } from "../kb/types.js";
import type { IdentityRole, MachineDef } from "./types.js";

/** Tek kaynak: kimlik/anahtar okuması `agent/state.ts`'te (F-vlad-144); burada yalnız eski ad. */
export const readLocalSettings = readLocal;

/** Bu makinenin adı; `machines` tanımlı değilse null (yerleştirme/iletim tamamen kapalı). */
export function resolveSelf(cfg: VladConfig): string | null {
  if (!cfg.machines) return null;
  const self = selfName();
  if (!cfg.machines.some((m) => m.name === self)) throw new Error(`bu makine config'te tanımlı değil: ${self}`);
  return self;
}
export const currentMachine = resolveSelf;

export const isBrain = (cfg: VladConfig): boolean => !cfg.machines || resolveSelf(cfg) === cfg.brain;

export const machineDef = (cfg: VladConfig, name: string): MachineDef | undefined => cfg.machines?.find((m) => m.name === name);

export function roleOf(cfg: VladConfig, name: string): IdentityRole | null {
  if (name === cfg.brain) return "brain";
  if (machineDef(cfg, name)) return "worker";
  return cfg.consoles?.some((c) => c.name === name) ? "console" : null;
}

/** Kartın aday makineleri (sıra = tercih; kartta yoksa [brain]); config'te olmayan adlar `unknown`'a ayrılır. `machines` yoksa aday yok. */
export function machinesOf(cfg: VladConfig, card: { machines?: string[] }): { names: string[]; unknown: string[] } {
  if (!cfg.machines || !cfg.brain) return { names: [], unknown: [] };
  const want = card.machines ?? [cfg.brain];
  return { names: want.filter((n) => machineDef(cfg, n)), unknown: want.filter((n) => !machineDef(cfg, n)) };
}
