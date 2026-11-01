import { scanRoots } from "../../scan/scan.js";
import { worktreePath } from "../../git/git.js";
import { machineDef } from "../../machines/registry.js";
import { pickRepoDir, repoNameOf } from "../../machines/paths.js";
import { defaultProbe, type LivenessProbe } from "../../tasks/liveness.js";
import { agentEnv } from "./env.js";

export interface LivenessTask { id: string; project: string; repoName: string }
export interface LivenessResult { ageMs: number | null; hasProcess: boolean }

interface Deps {
  /** worker clock (ms); only differences against worker-side mtimes leave this machine */
  now: number;
  probe: LivenessProbe;
  worktreeOf(t: LivenessTask): string | null;
}

/** Pure core: per task `ageMs = now - newest transcript write` (null: none) and whether a process mentions the task id. */
export function livenessResults(tasks: LivenessTask[], d: Deps): Record<string, LivenessResult> {
  const out: Record<string, LivenessResult> = {};
  for (const t of tasks) {
    const wt = d.worktreeOf(t);
    const m = wt ? d.probe.transcriptMtime(wt) : null;
    const alive = d.probe.alive(t.id);
    // a missing process list must not read as "no process": the brain would mark a live worker stalled
    if (alive === null) throw new Error("süreç listesi alınamadı (liveness yalnız Windows işçide desteklenir)");
    out[t.id] = { ageMs: m === null ? null : Math.max(0, d.now - m), hasProcess: alive };
  }
  return out;
}

const ID = /^[A-Za-z0-9._-]{1,64}$/;
function parse(args: unknown): LivenessTask[] {
  const a = (args as { tasks?: unknown } | null)?.tasks;
  if (!Array.isArray(a) || a.length > 500) throw new Error("bad_request: tasks dizisi bekleniyor");
  return a.map((t) => {
    const o = t as Partial<LivenessTask>;
    if (typeof o?.id !== "string" || !ID.test(o.id) || typeof o.project !== "string" || typeof o.repoName !== "string") throw new Error("bad_request: geçersiz görev kaydı");
    return { id: o.id, project: o.project, repoName: o.repoName };
  });
}

/** Op `liveness` (worker Agent): the worktree is resolved here (roots + the machine's own worktreeDir), never taken from the caller. */
export async function liveness(args: unknown): Promise<{ results: Record<string, LivenessResult> }> {
  const tasks = parse(args);
  const e = agentEnv();
  const def = machineDef(e.cfg, e.self);
  const cfg = { ...e.cfg, roots: def?.roots ?? e.cfg.roots, worktreeDir: def?.worktreeDir ?? e.cfg.worktreeDir };
  const repos = scanRoots(cfg);
  const worktreeOf = (t: LivenessTask): string | null => {
    const pick = pickRepoDir(repos.map((r) => r.path).filter((p) => repoNameOf(p) === t.repoName));
    return pick.ok ? worktreePath(cfg, pick.dir, t.id, def?.os ?? "win32") : null;
  };
  return { results: livenessResults(tasks, { now: e.now(), probe: defaultProbe(), worktreeOf }) };
}
