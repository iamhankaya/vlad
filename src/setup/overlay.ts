// Cevaplardan `vlad.config.local.json` katmanı (T20261110-05). Saf: dosya/ağ yok. Kural: yalnız cevaplanan anahtarlar yazılır;
// tracked dosyadaki kişisel değerler yalnız ilk kurulumda (yerel katman yokken) ve yalnız cevap vermeyen anahtarlar için nötrlenir.
import { resolve } from "node:path";
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

export function buildOverlay(c: SetupContext, cur: Obj, tracked: Obj, localExists: boolean): { overlay: Obj; conflicts: string[] } {
  const a = c.answers, o: Obj = {};
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

  if (a.machines === "single") for (const k of ["machines", "brain", "consoles"]) if ((cur[k] ?? tracked[k]) !== undefined) o[k] = null;
  let friend = false; // ilk kurulumda tracked dosyadaki kişisel değerler yalnız bu makine açıkça başka bir kuruluma geçiyorsa nötrlenir
  if (a.machines === "single") friend = !localExists && tracked.machines !== undefined;
  if (a.machines === "multi") {
    const me = selfEntry(c);
    if (me) {
      const inTracked = (tracked.machines ?? []).some((m: MachineEntry) => m.name === me.name);
      friend = !localExists && !inTracked;
      let base: MachineEntry[] = cur.machines ?? (inTracked ? tracked.machines : []);
      const i = base.findIndex((m) => m.name === me.name);
      const mine = { ...me, agent: Object.fromEntries(Object.entries(me.agent).filter(([, v]) => v !== undefined)) as MachineEntry["agent"] };
      base = i >= 0 ? base.map((m, n) => (n === i ? { ...m, ...mine, agent: { ...m.agent, ...mine.agent } } : m)) : [...base, { ...mine, agent: { ...mine.agent, port: mine.agent.port ?? 7437 } }];
      o.machines = base;
      if (a.role === "brain") o.brain = me.name;
      else if (!base.some((m) => m.name === (cur.brain ?? tracked.brain))) throw new Error("role=worker: beyin makinesi config'te yok (vlad setup --join <beyin> --brain-host ...)");
    }
  }
  if (friend) for (const k of ["experiments", "workerAutoCompact", "projects"]) if (!(k in o) && tracked[k] !== undefined) o[k] = null;

  const conflicts = Object.keys(o).filter((k) => k in cur && !eq(cur[k], o[k]));
  return { overlay: o, conflicts };
}
