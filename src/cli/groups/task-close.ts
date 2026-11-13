import type { Command } from "commander";
import { closeTask } from "../../machines/close.js";
import { assertNotWorker } from "../../mode/guard.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerTaskClose(task: Command, k: Kit): void {
  const { out, def } = k;
  def(task, "close <id>", "Kapıyı tek komutta yürütür: ön kontrol, gate, çakışma, onay sınırı, merge --no-ff, done, cleanup, Kapatılan bulgular, kb commit --push (push yalnız kb; kod push'u yok). Durursa kalan adımlar yapılmaz; çıkış 1", async (id: string, o: Opts) => {
    if (o.skipMachine !== undefined || o.reason !== undefined) assertNotWorker(); // çalışan kendi görevinde çok makine kanıtını atlayamaz (VLAD/kullanıcı yetkisi)
    const r = await closeTask(id, { yes: !!o.yes, allMachines: !!o.allMachines, ...(o.skipMachine ? { skipMachines: String(o.skipMachine).split(",") } : {}), ...(o.reason !== undefined ? { skipReason: String(o.reason) } : {}), ...(o.into ? { into: o.into as string } : {}), ...(o.head ? { head: String(o.head) } : {}) });
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
    .option("--head <sha>", "onaylanan head (confirm durağında basılan); gate'lenen head farklıysa merge öncesi durur")
    .option("--all-machines", "kart ≥2 makineliyse her makinenin bu commit için yeşil gate satırını zorunlu kıl (son kapıda (pipeline) zaten zorunlu; aksi halde uyarı)")
    .option("--skip-machine <ad,...>", "kullanıcı onaylı atlama: bu makinelerin yeşil gate satırı aranmaz (--reason zorunlu; --all-machines ile birlikte reddedilir; görev günlüğüne `Gate <makine>: ATLANDI @ <sha> — kullanıcı onayı: …` yazılır)")
    .option("--reason <metin>", "--skip-machine için kullanıcının açık onay metni")
    .option("--into <dal>", "hedef dal (varsayılan: faz için vlad/<çatı>, değilse kartın default_branch'i)");
}
