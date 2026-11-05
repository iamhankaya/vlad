// F-248 kabulü (T20261105-62; plan "F-248 arayüzü"): adopt (launchCore adopt:true) kararları:
//  (a) dal taban dalın gerisindeyse UYARI basar ve devam eder; (b) dal başka bir worktree'de checkout'luysa NET HATAYLA reddeder;
//  (c) kirli worktree uyarıyla kabul edilir (önceki işçinin işi olabilir; ret bunu kırar).
// Uyarı kanalı console.error (launchCore'daki trust uyarısıyla aynı). Gerçek git, geçici dizin, sahte launcher; ~/.claude.json geçici dosyaya yönlendirilir.
// U4a'ya kadar KIRMIZI: (a) ve (c) uyarısı yok, (b) ham git hatası verir.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { worktreePath } from "../../src/git/git.js";
import { launchCore } from "../../src/tasks/launch-core.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" }).trim();
const ID = "T20261101-91";
let base: string, repo: string, cfg: VladConfig, home: string, wt: string, claudeJson: string | undefined;
beforeEach(() => {
  home = makeHome();
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-u4f248-")));
  repo = join(base, "alpha"); mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a"), "1"); git(repo, "add", "."); git(repo, "commit", "-qm", "c1");
  cfg = defaultConfig(); cfg.worktreeDir = join(base, "wt");
  wt = worktreePath(cfg, repo, ID);
  claudeJson = process.env.VLAD_CLAUDE_JSON;
  process.env.VLAD_CLAUDE_JSON = join(base, "claude.json"); // gerçek ~/.claude.json'a dokunma
});
afterEach(() => { process.env.VLAD_CLAUDE_JSON = claudeJson; vi.restoreAllMocks(); rmTemp(base); rmTemp(home); });

const launcher = (): Launcher & { reqs: LaunchRequest[] } => { const reqs: LaunchRequest[] = []; return { reqs, async launch(r) { reqs.push(r); return { ok: true, method: "fake" }; } }; };
const req = (over: Record<string, unknown> = {}) => ({ taskId: ID, repo, worktree: wt, branch: `vlad/${ID}`, prompt: "p", env: { VLAD_TASK_ID: ID, VLAD_HOME: home }, title: "t", base: "main", adopt: true, ...over });
const warnings = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c.join(" ")).join("\n");

describe("F-248 adopt kararları", () => {
  it("(a) dal taban dalın gerisinde (yalnız dal var, worktree yok) ⇒ uyarı basar, yine de devam eder", async () => {
    git(repo, "branch", `vlad/${ID}`);
    writeFileSync(join(repo, "b"), "2"); git(repo, "add", "."); git(repo, "commit", "-qm", "main ilerledi");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = launcher();
    const r = await launchCore(req(), l);
    expect(r).toMatchObject({ reused: true, branch: `vlad/${ID}` });
    expect(l.reqs).toHaveLength(1);
    expect(warnings(err)).toMatch(/uyarı|geride|taban/i);
  });
  it("(b) dal başka bir worktree'de checkout'lu ⇒ net hatayla reddeder (launcher çağrılmaz)", async () => {
    git(repo, "branch", `vlad/${ID}`);
    const other = join(base, "baska-wt");
    git(repo, "worktree", "add", other, `vlad/${ID}`);
    const l = launcher();
    await expect(launchCore(req(), l)).rejects.toThrow(/başka worktree/i);
    expect(l.reqs).toHaveLength(0);
    expect(existsSync(other)).toBe(true); // başkasının worktree'si silinmedi
  });
  it("(c) kirli worktree (önceki işçinin işi) ⇒ uyarıyla kabul edilir, dosyalar korunur", async () => {
    await launchCore(req(), launcher());
    writeFileSync(join(wt, "yarim.txt"), "yarım iş");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const l = launcher();
    const r = await launchCore(req(), l);
    expect(r).toMatchObject({ reused: true });
    expect(l.reqs).toHaveLength(1);
    expect(existsSync(join(wt, "yarim.txt"))).toBe(true);
    expect(warnings(err)).toMatch(/kirli|değişiklik|uyarı/i);
  });
  it("kontrol: temiz ve güncel adopt uyarı basmaz", async () => {
    await launchCore(req(), launcher());
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await launchCore(req(), launcher());
    expect(r).toMatchObject({ reused: true });
    expect(warnings(err)).not.toMatch(/geride|kirli/i);
  });
});
