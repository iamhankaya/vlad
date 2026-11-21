import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nudgeWorker, type NudgeDeps } from "../../src/tasks/nudge.js";

// T20261121-28: gerçek tmux (özel soket, geçici dizin; kullanıcının tmux sunucusuna dokunulmaz) + sahte çalışan penceresi (`> ` istemi basıp satırı okuyan döngü).
// Sahte çalışan her satır için yankı basıp yeni boş istem çizer: tire ile başlayan metin `--` sayesinde gönderilir ve teslim doğrulanır.
const FAKE_WORKER = `sh -c 'printf "> "; while IFS= read -r l; do echo "got: $l"; printf "> "; done'`;
let hasTmux = true;
try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); } catch { hasTmux = false; }

const dir = realpathSync(mkdtempSync(join(tmpdir(), "vlad-nudge-")));
const sock = join(dir, "t.sock");
const tmux = (args: string[]): string => execFileSync("tmux", ["-S", sock, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });

afterAll(() => {
  try { tmux(["kill-server"]); } catch { /* sunucu yok */ }
  if (dir.startsWith(realpathSync(tmpdir()))) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasTmux)("nudge gerçek tmux", () => {
  it("tire ile başlayan metin pencereye ulaşır ve teslim edilmiş sayılır", async () => {
    tmux(["new-session", "-d", "-s", "vlad-TX", "-x", "100", "-y", "20", FAKE_WORKER]);
    const deps: NudgeDeps = { tmux, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
    const r = await nudgeWorker("TX", "- önce testleri çalıştır", deps, { settleMs: 300 });
    expect(r.delivered).toBe(true);
    expect(tmux(["capture-pane", "-p", "-t", "vlad-TX"])).toContain("got: - önce testleri çalıştır");
  });
});
