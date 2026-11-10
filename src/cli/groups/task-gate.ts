import type { Command } from "commander";
import { join } from "node:path";
import { loadConfig, withKbLock } from "../../kb/index.js";
import { brainTransport, gateMachineOf, syncKb, recordGreenGate, defaultGateTarget, remoteGateRun, baseBranchOf, remoteMerge, remoteMergePreview } from "../../machines/remote.js";
import { selfName } from "../../fleet/state.js";
import { getTask } from "../../tasks/index.js";
import { listProjects } from "../../projects/store.js";
import { compareBase, fileBaseCache } from "../../tasks/gate-compare.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTaskGate(task: Command, k: Kit): void {
  const { out, def } = k;
  // --- machines:C4 --- uzak makinedeki görev/çatı için kapı işlemleri (push yok); yerel görevde /integrate akışı geçerli
  async function gateRoute(id: string): Promise<{ machine: string; transport: ReturnType<typeof brainTransport> }> {
    const cfg0 = loadConfig();
    const machine = gateMachineOf(getTask(id), cfg0);
    if (!machine) throw new Error(`${id} uzak makinede değil; kapı işlemleri yerelde /integrate akışıyla yapılır`);
    const transport = brainTransport(cfg0, selfName());
    await syncKb(transport, machine); // işçi kartın gate'ini ve görev dosyasını kendi kb klonundan okur
    return { machine, transport };
  }
  def(task, "gate <id>", "Uzak makinede kartın gate komutunu koşar (--target integration: çatı worktree'si, task: görevin kendisi); gate kırmızıysa çıkış 1", async (id: string, o: Opts) => {
    const target = (o.target ?? defaultGateTarget(getTask(id))) as string;
    if (target !== "integration" && target !== "task") throw new Error("--target integration | task olmalı");
    const { machine, transport } = await gateRoute(id);
    if (o.compareBase) {
      // taban karşılaştırması: yalnız tabanda yeşil olup görevde kırmızı olan testler "yeni kırmızı"; ham yeşil kaydı yine ham sonuca bağlı
      const t = getTask(id);
      const base = baseBranchOf(t);
      const c = await compareBase({
        runTask: () => remoteGateRun(transport, machine, t, target),
        runBase: (cachedHead) => remoteGateRun(transport, machine, t, "base", cachedHead),
        ...fileBaseCache(machine, t.data.project, base, listProjects().find((p) => p.slug === t.data.project)?.gate ?? ""),
      });
      await withKbLock(() => recordGreenGate(id, c.task, target));
      const { task: r, ...cmp } = c;
      out(o, { id, machine, target, baseBranch: base, ...cmp, stdout: r.stdout, stderr: r.stderr, ...(r.head ? { head: r.head } : {}) },
        `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}\n[gate çıkış kodu ${cmp.gateExit}] yeni kırmızı: ${cmp.newRed.length}, taban kırmızısı: ${cmp.baselineRed.length}` +
        `${cmp.baselineSha ? ` (taban ${base}@${cmp.baselineSha.slice(0, 7)}${cmp.baselineCached ? ", önbellekli" : ""})` : ""}` +
        `${cmp.newRed.length ? `\n${cmp.newRed.map((x) => `  yeni kırmızı: ${x}`).join("\n")}` : ""}`);
      if (cmp.exit !== 0) process.exitCode = 1;
      return;
    }
    const r = await remoteGateRun(transport, machine, getTask(id), target);
    await withKbLock(() => recordGreenGate(id, r, target));
    out(o, { id, machine, target, ...r }, `${r.stdout}${r.stderr ? `
${r.stderr}` : ""}
[gate çıkış kodu ${r.exit}]`);
    if (r.exit !== 0) process.exitCode = 1;
  }).option("--target <hedef>", "integration (çatı için varsayılan) | task (dev görevi için varsayılan)")
    .option("--compare-base", "kırmızıyı aynı makinede hedef dalın (master / vlad/<çatı>) gate sonucuyla karşılaştır: yalnız tabanda yeşil olup görevde kırmızı olanlar yeni kırmızı (taban sha önbellekli, dal ilerlediyse yeniden koşulur); JSON: newRed, baselineRed, baselineSha");
  def(task, "merge-preview <id>", "Uzak makinede merge önizlemesi: log, diff --stat, çakışmalar (yazmaz)", async (id: string, o: Opts) => {
    const { machine, transport } = await gateRoute(id);
    const r = await remoteMergePreview(transport, machine, getTask(id), { ...(o.into ? { into: o.into as string } : {}) });
    out(o, { id, machine, ...r }, `${r.log}${r.diffStat}${r.conflicts.length ? `çakışma: ${r.conflicts.join(", ")}` : "çakışma yok"}`);
  }).option("--into <dal>", "hedef dal (varsayılan: vlad/<çatı> ya da kartın default_branch'i)");
  def(task, "merge <id>", "Uzak makinede görev dalını hedefe --no-ff merge eder (push yok; çakışmada geri alınır)", async (id: string, o: Opts) => {
    const { machine, transport } = await gateRoute(id);
    const r = await remoteMerge(transport, machine, getTask(id), { ...(o.into ? { into: o.into as string } : {}), ...(o.message ? { message: o.message as string } : {}) });
    out(o, { id, machine, ...r }, r.merged ? `${id} merge edildi -> ${r.head}` : `${id} zaten içeride (${r.head})`);
  }).option("--into <dal>", "hedef dal (varsayılan: vlad/<çatı> ya da kartın default_branch'i)").option("--message <metin>", "merge commit mesajı");
  // --- /machines:C4 ---
}
