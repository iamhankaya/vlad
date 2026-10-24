import type { Command } from "commander";
import { def, out, type Opts } from "../cli-util.js";
import { currentMachine, resolveProjectPath } from "../kb/index.js";
import { cloneProject, getProjectCard, setProjectPath } from "../projects/paths.js";
import { setPr, setProgress } from "../tasks/progress.js";

/** S1b: `task progress|pr` and `project path|clone`, added to the groups registerTask/registerProject create. */
export function registerExt(program: Command): void {
  const sub = (name: string): Command => {
    const c = program.commands.find((x) => x.name() === name);
    if (!c) throw new Error(`komut grubu yok: ${name}`);
    return c;
  };

  const task = sub("task");
  def(task, "progress <id>", "Görevin son ilerlemesini yazar (yüzde yoksa belirsiz)", (id: string, o: Opts) => {
    let pct: number | null = null;
    if (o.pct !== undefined) {
      if (!/^\d+$/.test(String(o.pct))) throw new Error(`--pct 0-100 arası tam sayı olmalı: ${o.pct}`);
      pct = Number(o.pct);
    }
    const t = setProgress(id, pct, o.label as string);
    out(o, { id, progress: t.data.progress }, `${id} ilerleme: ${pct === null ? "" : `%${pct} `}${t.data.progress!.label}`);
  })
    .option("--pct <n>", "yüzde, 0-100 tam sayı")
    .requiredOption("--label <metin>", "ne yapıyor");
  def(task, "pr <id>", "Görevin branch'inin pull request'ini kaydeder", (id: string, o: Opts) => {
    const number = String(o.number);
    if (!/^\d+$/.test(number) || Number(number) < 1) throw new Error(`--number 1 veya büyük tam sayı olmalı: ${number}`);
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo as string)) throw new Error(`--repo owner/name biçiminde olmalı: ${o.repo}`);
    const t = setPr(id, { number: Number(number), repo: o.repo as string, base: o.base as string, ...(o.url ? { url: o.url as string } : {}) });
    out(o, { id, pr: t.data.pr }, `${id} PR #${number} (${o.repo})`);
  })
    .requiredOption("--number <n>", "PR numarası")
    .requiredOption("--repo <owner/name>", "GitHub reposu")
    .requiredOption("--base <branch>", "PR tabanı")
    .option("--url <url>", "PR adresi");

  const project = sub("project");
  def(project, "path <slug> [yol]", "Bu makinedeki klon yolunu gösterir; yol verilirse kaydeder", (slug: string, path: string | undefined, o: Opts) => {
    const machine = (o.machine as string | undefined) ?? currentMachine();
    if (path === undefined) {
      const p = resolveProjectPath(getProjectCard(slug), machine);
      out(o, { slug, machine, path: p }, p);
      return;
    }
    setProjectPath(slug, machine, path, o.keep as string | undefined);
    out(o, { slug, machine, path }, `yazıldı: ${slug}.paths.${machine}=${path}`);
  })
    .option("--machine <ad>", "makine adı (varsayılan: bu makine)")
    .option("--keep <makine>", "ilk kayıtta mevcut `path`'in ait olduğu makine adı");
  def(project, "clone <slug>", "Projeyi bu makineye klonlar ve yolunu kartın paths alanına yazar", (slug: string, o: Opts) => {
    const r = cloneProject(slug, { from: o.from as string | undefined, to: o.to as string | undefined, keep: o.keep as string | undefined });
    out(o, r, `klonlandı: ${slug} -> ${r.path}`);
  })
    .option("--from <url>", "kaynak (varsayılan: github.com/<kart repo'su>)")
    .option("--to <yol>", "hedef klasör (varsayılan: <roots[0]>/<slug>)")
    .option("--keep <makine>", "ilk kayıtta mevcut `path`'in ait olduğu makine adı");
}
