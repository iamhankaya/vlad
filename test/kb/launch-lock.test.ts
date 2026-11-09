// F-vlad-102: `task launch` terminal/launcher beklemesi boyunca kb kilidini tutmaz.
// Geçici kb + geçici git deposu; sahte yavaş launcher (VLAD_LAUNCHER=noop + VLAD_NOOP_LAUNCH_DELAY_MS).
import { execFileSync, spawn } from "node:child_process";
import { spawnGuarded } from "../support/spawn-vlad.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { isolatedEnv } from "../isolate-env.js";

const cli = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
let home: string;
let repo: string;
const env = (extra: Record<string, string> = {}) => ({ ...isolatedEnv(), VLAD_HOME: home, VLAD_LAUNCHER: "noop", ...extra });
const vlad = (args: string[], input = "", extra: Record<string, string> = {}) =>
  spawnGuarded("node", [cli, ...args], { encoding: "utf8", input, env: env(extra) });
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });

beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-launchlock-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git("init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git("add", ".");
  git("commit", "-m", "first");
  expect(realpathSync.native(repo).startsWith(realpathSync.native(tmpdir()))).toBe(true);
  writeFileSync(join(home, "card.md"), `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
  expect(vlad(["project", "write", "alpha", "--file", join(home, "card.md")]).status).toBe(0);
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ worktreeDir: join(base, "wt") }));
});

describe("task launch kb kilidi (F-vlad-102)", { timeout: 60_000 }, () => {
  it("launcher beklerken başka yazan komut kilit beklemeden biter; launch sonunda running yazılır", async () => {
    const r = vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n");
    const id = JSON.parse(r.stdout).id as string;
    const p = spawn("node", [cli, "task", "launch", id, "--json"], { env: env({ VLAD_NOOP_LAUNCH_DELAY_MS: "6000" }), stdio: "ignore" });
    let exited = false;
    const done = new Promise<number | null>((res) => p.on("close", (c) => { exited = true; res(c); }));
    // worktree + branch hazırlığı sürerken launcher'a girilir; 6 sn bekleme içinde 2.5 sn sonrası kesin launcher bölgesidir
    await new Promise((r) => setTimeout(r, 2500));
    expect(exited, "launch hâlâ launcher'da olmalı").toBe(false);
    const t0 = Date.now();
    const log = vlad(["task", "log", id, "paralel-yazi"], "", { VLAD_LOCK_TIMEOUT_MS: "1500" });
    expect(log.stderr.trim()).toBe("");
    expect(log.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(exited, "log, launch bitmeden tamamlanmalı").toBe(false);
    expect(await done).toBe(0);
    const f = JSON.parse(vlad(["task", "list", "--json"]).stdout).tasks.find((t: { id: string }) => t.id === id);
    expect(f.state).toBe("running");
    const body = readFileSync(join(home, "kb", "tasks", `${id}.md`), "utf8");
    expect(body).toContain("paralel-yazi");
    expect(existsSync(join(home, "kb", ".vlad.lock"))).toBe(false);
  });
});
