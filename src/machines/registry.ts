import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getVladHome } from "../kb/home.js";
import type { VladConfig } from "../kb/types.js";
import type { IdentityRole, LocalSettings, MachineDef } from "./types.js";

/** İzlenmeyen yerel ayar: `VLAD_LOCAL_FILE` ya da `<VLAD_HOME>/vlad.local.json`; dosya yoksa boş. */
export function readLocalSettings(): LocalSettings {
  const file = process.env.VLAD_LOCAL_FILE || join(getVladHome(), "vlad.local.json");
  if (!existsSync(file)) return { keys: {} };
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as Partial<LocalSettings>;
    return { ...s, keys: s.keys ?? {} };
  } catch (e) {
    throw new Error(`yerel ayar okunamadı (${file}): ${(e as Error).message}`);
  }
}

/** Bu makinenin adı; `machines` tanımlı değilse null (yerleştirme/iletim tamamen kapalı). */
export function resolveSelf(cfg: VladConfig): string | null {
  if (!cfg.machines) return null;
  const self = process.env.VLAD_MACHINE || readLocalSettings().self;
  if (!self) throw new Error("bu makinenin kimliği belirsiz: VLAD_MACHINE ya da vlad.local.json self");
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
