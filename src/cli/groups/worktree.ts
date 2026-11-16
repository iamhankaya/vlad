import type { Command } from "commander";
import { loadConfig } from "../../kb/index.js";
import { pruneOrphanWorktrees } from "../../tasks/worktree-prune.js";
import type { Kit } from "../kit.js";
import type { Opts } from "../ctx.js";

export function registerWorktree(program: Command, k: Kit): void {
  const { out, def } = k;
  const worktree = program.command("worktree").description("worktree klasörü bakımı");
  def(worktree, "prune", "git'te kayıtlı olmayan, done/cancelled göreve ait artık worktree klasörlerini listeler (silme için --yes)", (o: Opts & { yes?: boolean; dryRun?: boolean }) => {
    // --dry-run always wins: with both flags nothing on disk is touched
    const r = pruneOrphanWorktrees(loadConfig(), { yes: !!o.yes && !o.dryRun });
    const del = r.items.filter((i) => i.action === "delete");
    const skipped = r.items.filter((i) => i.action !== "delete");
    const lines = [
      ...del.map((i) => `${i.removed ? "silindi" : i.error ? `HATA (${i.error})` : "silinecek"}: ${i.dir} (${i.id}, ${i.state})`),
      ...skipped.map((i) => `atlandı: ${i.dir} (${i.id}): ${i.reason}`),
      r.dryRun
        ? `${del.length} klasör silinecek, ${skipped.length} atlandı (dry-run; silmek için --yes)`
        : `${r.removed} klasör silindi, ${r.errors} hata, ${skipped.length} atlandı`,
    ];
    out(o, r, lines.join("\n"));
    if (r.errors) process.exitCode = 1;
  }).option("--dry-run", "yalnız listele (varsayılan)").option("--yes", "listelenen klasörleri sil");
}
