// Cevaplardan `vlad.config.local.json` katmanı (T20261110-05). Saf: dosya/ağ yok. Kural: yalnız cevaplanan anahtarlar yazılır;
// tracked dosyadaki kişisel değerler yalnız ilk kurulumda (yerel katman yokken) ve yalnız cevap vermeyen anahtarlar için nötrlenir.
import { resolve } from "node:path";
import { readLocal } from "../fleet/state.js";
import { expandHome } from "./io.js";
import type { SetupContext } from "./types.js";

type Obj = Record<string, any>;
export interface MachineEntry { name: string; os: string; agent: { host?: string; port: number; bind?: string } }
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Bu makinenin machines girdisi (cevaplardan). */
export function selfEntry(c: SetupContext): MachineEntry | null {
  const m = c.answers.machine;
  if (!m?.name) return null;
  const a = m.agent ?? {};
  return { name: m.name, os: c.platform, agent: { ...(a.host ? { host: a.host } : {}), port: a.port as number, ...(a.bind ? { bind: a.bind } : {}) } };
}
/** kb dizini: cevap > varsayılan `<VLAD_HOME>/../vlad-kb` (kb cevabı varsa) > null. Tek yer: overlay ve kb parçası aynı yolu kullanır. */
export function kbDirFromAnswers(c: SetupContext): string | null {
  const kb = c.answers.kb;
  if (!kb || (kb.mode === undefined && kb.dir === undefined)) return null;
  return resolve(c.vladHome, kb.dir ? expandHome(kb.dir, c.home) : resolve(c.vladHome, "..", "vlad-kb"));
}

export function buildOverlay(c: SetupContext, cur: Obj, tracked: Obj, localExists: boolean): { overlay: Obj; conflicts: string[]; warnings: string[] } {
  const a = c.answers, o: Obj = {}, warnings: string[] = [];
  if (a.roots) o.roots = a.roots.map((r) => resolve(expandHome(r, c.home)));
  const kbDir = kbDirFromAnswers(c);
  if (kbDir) o.kbDir = kbDir;
  if (a.kb?.remote) o.kbRepo = a.kb.remote;
  if (a.cloud?.kb) o.cloudKb = a.cloud.kb;
  if (a.worktreeDir) o.worktreeDir = a.worktreeDir;
  if (a.ignore) o.ignore = a.ignore;
  if (a.launcher) o.launcher = a.launcher;
  if (a.autonomy) o.defaultAutonomy = a.autonomy;
  if (a.ctx?.worker) o.workerAutoCompact = a.ctx.worker;
  if (a.limits?.maxParallel) o.maxParallel = a.limits.maxParallel;
  if (a.experiments?.ponytail) o.experiments = { ponytail: a.experiments.ponytail };

  if (a.machines === "single") {
    // Sahibin çok makineli tracked filosu yalnız açık `fresh: true` ile kapatılır; sihirbaz varsayılanı ("single") filoyu sessizce düşüremez.
    const trackedFleet = (tracked.machines?.length ?? 0) > 0;
    if (trackedFleet && a.fresh !== true) warnings.push("machines: 'single' cevabı tracked config'teki çok makineli filoyu kapatmaz (machines/brain/consoles yerel katmana null yazılmadı); arkadaş kurulumu için 'fresh': true verin");
    else {
      const nulled = ["machines", "brain", "consoles"].filter((k) => (cur[k] ?? tracked[k]) !== undefined);
      for (const k of nulled) o[k] = null;
      if (nulled.length) warnings.push(`UYARI: ${nulled.join("/")} yerel katmanda null'landı (bu makine tek makine olarak çalışır; çok makineli filodan çıkıldı)`);
    }
  }
  // Tracked dosyadaki kişisel değerler (experiments/workerAutoCompact/projects) yalnız açık `fresh: true` ile nötrlenir (sezgi yok).
  const friend = a.fresh === true && !localExists;
  if (a.machines === undefined && !localExists && (tracked.machines?.length ?? 0) > 0) {
    const self = process.env.VLAD_MACHINE || readLocal().self;
    if (!self || !tracked.machines.some((m: MachineEntry) => m.name === self)) throw new Error("tracked config çok makineli ve bu makine onda tanımlı değil: 'machines' cevabını (single|multi) açıkça ver");
  }
  if (a.machines === "multi") {
    const me = selfEntry(c);
    if (me) {
      const inTracked = (tracked.machines ?? []).some((m: MachineEntry) => m.name === me.name);
      let base: MachineEntry[] = cur.machines ?? (inTracked ? tracked.machines : []);
      const i = base.findIndex((m) => m.name === me.name);
      const mine = { ...me, agent: Object.fromEntries(Object.entries(me.agent).filter(([, v]) => v !== undefined)) as MachineEntry["agent"] };
      // Başkasının makinesi: adres farklıysa ya da fresh ise sahibin kişisel alanları (roots/kbDir/bind/host) kopyalanmaz (F-vlad-294).
      const foreign = i >= 0 && inTracked && cur.machines === undefined && a.fresh === true;
      const oldHost = i >= 0 ? base[i]!.agent?.host : undefined;
      if (!foreign && oldHost && mine.agent.host && oldHost !== mine.agent.host) warnings.push(`${me.name}: agent.host ${oldHost} → ${mine.agent.host} (adres değişti; roots/kbDir/bind korundu; beyin/işçi config'lerindeki adresi de güncelleyin)`);
      base = i >= 0 ? base.map((m, n) => (n === i ? (foreign ? { ...mine, agent: { ...mine.agent, port: mine.agent.port ?? 7437 } } : { ...m, ...mine, agent: { ...m.agent, ...mine.agent } }) : m)) : [...base, { ...mine, agent: { ...mine.agent, port: mine.agent.port ?? 7437 } }];
      o.machines = base;
      if (a.role === "brain") o.brain = me.name;
      else {
        // işçi: config beyni machines içinde ister; beyin girdisi sonradan `--join` ile değişir. Şimdilik kayıtlı beyin girdisini taşı.
        const bn = cur.brain ?? tracked.brain;
        const bm = (tracked.machines ?? []).find((m: MachineEntry) => m.name === bn);
        if (bn && base.some((m) => m.name === bn)) { /* beyin zaten var */ }
        else if (bn && bm) o.machines = [bm, ...base];
        else throw new Error("role=worker: beyin makinesi config'te yok (vlad setup --join <beyin> --brain-host ...)");
      }
    }
  }
  if (friend) for (const k of ["experiments", "workerAutoCompact", "projects"]) if (!(k in o) && tracked[k] !== undefined) o[k] = null;

  for (const k of ["machines", "brain"]) if (o[k] !== null && k in o && eq(o[k], tracked[k])) delete o[k]; // tracked ile birebir aynıysa yerel katmana yazma
  const conflicts = Object.keys(o).filter((k) => k in cur && !eq(cur[k], o[k]));
  return { overlay: o, conflicts, warnings };
}
