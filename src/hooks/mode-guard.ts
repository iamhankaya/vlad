import { realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

/** F-vlad-287: çalışan oturumunda mod değişikliğini PreToolUse'ta keser (saf). Komut kalıbı env/cwd'den bağımsızdır: `env -u VLAD_TASK_ID` ya da worktree dışı cd işe yaramaz. */
export const MODE_GUARD_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"];
const WHY = "çalışan oturumu mod yazamaz: gece/bekçi modunu ve kb mode.json'u yalnız VLAD/kullanıcı değiştirir";

// Platform ayrımı: yol karşılaştırması küçük harfe çevrilip `\` → `/` yapılır (macOS/Windows büyük-küçük harf duyarsız).
const norm = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
function real(p: string): string {
  const abs = resolve(p);
  try { return join(realpathSync.native(dirname(abs)), basename(abs)); } catch { return abs; }
}

/** null = serbest, string = ret nedeni. `kbDir` null ise (çözülemedi) `mode.json` adlı her yazma reddedilir. shortcut: değişkenle/alt kabukla kurulan komut adı (`$V mode off`) görünmez; kesin sınır imzalı token (F-vlad-287 notu). */
export function checkWorkerMode(tool: string, input: Record<string, unknown> | undefined, kbDir: string | null): string | null {
  if (tool === "Bash") {
    const cmd = typeof input?.command === "string" ? input.command : "";
    const bare = cmd.replace(/\\\r?\n/g, "").replace(/["'\\]/g, ""); // `v"la"d`, `mo"de.j"son` ve satır devamı
    if (/mode\.json/i.test(bare)) return `${WHY} (komutta mode.json geçiyor)`;
    const m = /\b(?:vlad|cli(?:\.js)?)\s+mode\b\s*(\S*)/i.exec(bare);
    if (m && m[1]?.toLowerCase() !== "status") return `${WHY} (yalnız \`vlad mode status\` serbest)`;
    return null;
  }
  if (!MODE_GUARD_TOOLS.includes(tool)) return null;
  const f = input?.file_path ?? input?.notebook_path;
  if (typeof f !== "string" || basename(f.replace(/\\/g, "/")).toLowerCase() !== "mode.json") return null;
  if (kbDir === null) return `${WHY} (kb dizini çözülemedi: mode.json yazımı reddedildi)`;
  return norm(real(f)) === norm(real(join(kbDir, "mode.json"))) ? `${WHY} (${f})` : null; // kb dışındaki mode.json projenin kendi dosyasıdır
}
