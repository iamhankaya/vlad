import type { Command } from "commander";
import { closeTask } from "../../machines/close.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTaskClose(task: Command, k: Kit): void {
  const { out, def } = k;
  def(task, "close <id>", "Kapıyı tek komutta yürütür: ön kontrol, gate, çakışma, onay sınırı, merge --no-ff, done, cleanup, Kapatılan bulgular, kb commit --push (push yalnız kb; kod push'u yok). Durursa kalan adımlar yapılmaz; çıkış 1", async (id: string, o: Opts) => {
    const r = await closeTask(id, { yes: !!o.yes, ...(o.into ? { into: o.into as string } : {}) });
    const mark = { ok: "✓", skipped: "-", stopped: "■", failed: "✗" } as const;
    const lines = [
      `${id}: ${r.ok ? "kapandı" : `durdu (${r.stopped_at})`}${r.target ? ` → ${r.target}` : ""}`,
      ...r.steps.map((s) => `  ${mark[s.status]} ${s.step}${s.detail ? `: ${s.detail.split("\n")[0]}` : ""}`),
      ...(r.reason ? [r.reason] : []),
      ...(r.stopped_at === "confirm" && r.summary ? [r.summary.trimEnd()] : []),
      ...r.warnings.map((w) => `uyarı: ${w}`),
    ];
    out(o, r, lines.join("\n"));
    if (!r.ok) process.exitCode = 1;
  })
    .option("--yes", "merge onayı verildi (yoksa merge öncesi durur; açık gece modu penceresi, yeşil gate ve açık P1 yoksa sormadan sürer)")
    .option("--into <dal>", "hedef dal (varsayılan: faz için vlad/<çatı>, değilse kartın default_branch'i)");
}
