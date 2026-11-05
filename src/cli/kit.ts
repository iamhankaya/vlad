import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { probeRemoteWorkers } from "../tasks/liveness.js";
import type { RemoteStallPlan } from "../tasks/liveness.js";
import { kbPaths, loadConfig, withKbLock, KbLockTimeout } from "../kb/index.js";
import { execKindOf, lockPolicyFor } from "../commands/accessors.js";
import { forwardIfWorker, workerState } from "../agent/forward.js";
import { readLocal, selfName } from "../agent/state.js";
import { AgentClient } from "../agent/client.js";
import { refreshProject } from "../projects/derived.js";
import { integrationWorktrees, modelInfo } from "../tasks/index.js";
import type { Task } from "../tasks/index.js";
import { failWith } from "./ctx.js";
import type { CliCtx, Opts } from "./ctx.js";
import { REFRESH_KEYS, targetsOf } from "./policy.js";

export function createKit(ctx: CliCtx) {
  const fail = (e: unknown): never => failWith(ctx, e);

  function out(o: Opts, data: unknown, text: string): void {
    ctx.stdout.write((o.json ? JSON.stringify(data) : text) + "\n");
  }

  // --- machines:A --- `@<makine>` eki: yalnız görevde machine varsa ve brain değilse
  let brainName: string | null | undefined; // config bir kez okunur (liste satırı başına değil)
  const machineTag = (t: Task): string => {
    if (!t.data.machine) return "";
    if (brainName === undefined) { try { brainName = loadConfig().brain ?? null; } catch { brainName = null; } }
    return brainName && t.data.machine !== brainName ? ` @${t.data.machine}` : "";
  };
  // --- /machines:A ---
  const taskLine = (t: Task) => `${t.data.id}  ${t.data.state.padEnd(17)} ${t.data.project}  ${t.data.title}${machineTag(t)}`;
  /** Pipeline tasks carry their per-project integration worktrees (F-vlad-063); a missing project card must not break listing. */
  const integrationInfo = (t: Task, all?: Task[]) => {
    if (t.data.kind !== "pipeline") return {};
    try { return { integration_worktrees: integrationWorktrees(t.data.id, loadConfig(), all) }; } catch { return {}; }
  };
  /** Task data plus the model it runs on (task `model` ?? role `model`), for --json consumers. */
  const withModel = (t: Task, all?: Task[]) => ({ ...t.data, ...modelInfo(t.data), ...integrationInfo(t, all) });
  /** Fields `task list --fields` can pick: the task frontmatter plus derived ones (computed only when asked for). */
  const TASK_FIELDS = ["id", "project", "title", "kind", "state", "autonomy", "branch", "worktree", "session_id", "created", "updated", "error", "digested", "role", "parent", "depends_on", "phase", "report_file", "model", "model_reason", "machine", "machine_reserved", "launch_op"];
  const DERIVED_FIELDS = ["role_model", "effective_model", "integration_worktrees"];
  /** Detailed status line: shows the model only when the task's own model deviates from its role's. */
  const statusLine = (t: Task) => {
    const m = t.data.model && t.data.model !== modelInfo(t.data).role_model ? `  [model: ${t.data.model}]` : "";
    return taskLine(t) + m;
  };


  // --- machines:S --- kancalar; varsayılan = mevcut davranış. B `before`'ı (iletim), C `lockPolicy`'yi (resume/cleanup iç kilit) doldurur.
  /** true → komut başka makineye iletildi (çıktı yazıldı), yerel handler çalışmaz. */
  const before = (key: string, args: any[]): Promise<boolean> => forwardIfWorker(key, args);
  /** "outer": tüm callback kilitli (bugünkü KB_WRITES); "inner": handler kendi evrelerinde kilitler; "none". */
  const lockPolicy = (key: string): "outer" | "inner" | "none" => lockPolicyFor(key, loadConfig); // C1: resume/cleanup lock in phases once `machines` is set (config read only for those)
  // --- /machines:S ---
  // --- machines:C3 --- uzak stalled: ağ çağrıları kilit DIŞINDA (status'un kilitli gövdesi yalnız sonucu uygular); --no-mark ve --hook yolunda hiç bağlantı yok
  async function remoteStallPlans(): Promise<RemoteStallPlan[]> {
    try {
      const cfg = loadConfig();
      if (!cfg.machines || !cfg.brain || selfName() !== cfg.brain) return [];
      return await probeRemoteWorkers(cfg, new AgentClient({ self: cfg.brain, keys: readLocal().keys, config: () => cfg }), new Date());
    } catch (e) { ctx.stderr.write(`uyarı: uzak stalled denetimi atlandı: ${(e as Error).message}\n`); return []; } // a broken probe must never take status down
  }
  // --- /machines:C3 ---

  async function runAndRefresh(key: string, args: any[], fn: (...a: any[]) => void | Promise<void>): Promise<void> {
    await fn(...args);
    if (!REFRESH_KEYS.has(key)) return;
    try {
      const t = targetsOf(key, args);
      for (const slug of new Set(t?.slugs)) {
        if (slug && /^[a-z0-9-]+$/.test(slug) && existsSync(join(kbPaths().projects, `${slug}.md`))) refreshProject(slug, { create: false, only: t!.only, fast: t!.fast });
      }
    } catch (e) { ctx.stderr.write(`uyarı: kart blokları tazelenemedi: ${(e as Error).message}\n`); }
  }

  function def(parent: Command, spec: string, desc: string, fn: (...a: any[]) => void | Promise<void>): Command {
    const c = parent.command(spec).description(desc).option("--json", "makine okunur çıktı");
    const key = `${parent.name()} ${spec.split(" ")[0]}`;
    c.action(async (...args: any[]) => {
      try {
        const opts = args[args.length - 2] as Opts;
        if (execKindOf(key) === "status" && ["worker", "unknown"].includes(workerState().kind)) opts.mark = false; // kimlik belirsizken de yazma (F-vlad-144); // işçinin kb klonu salt okunur: işaretleme/mod temizliği yazmaz (kb-sync kirli ağaçta reddeder)
        if (execKindOf(key) === "status" && opts.mark !== false) {
          if (!opts.hook) opts.remotePlans = await remoteStallPlans(); // C3
          // SessionStart hook runs this: never block it behind a long writer; fall back to the side-effect-free read
          try { await withKbLock(() => fn(...args), { timeoutMs: 2000 }); } catch (e) {
            if (!(e instanceof KbLockTimeout)) throw e;
            opts.mark = false;
            await fn(...args);
          }
        } else if (await before(key, args)) return;
        else await (lockPolicy(key) === "outer" ? withKbLock(() => runAndRefresh(key, args, fn)) : fn(...args));
      } catch (e) {
        if (key === "vlad send") await (await import("../transfer/cli.js")).notifySendFailure(e, { notify: !!(args[args.length - 2] as Opts).notify }).catch(() => {}); // F-vlad-237: forward/yol doğrulama hataları da bildirilsin
        fail(e);
      }
    });
    return c;
  }
  return { ctx, fail, out, def, taskLine, statusLine, withModel, integrationInfo, TASK_FIELDS, DERIVED_FIELDS, before, lockPolicy, runAndRefresh };
}
export type Kit = ReturnType<typeof createKit>;
