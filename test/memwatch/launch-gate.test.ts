import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "../isolate-env.js";
import { spawnGuarded } from "../support/spawn-vlad.js";
import { makeHome } from "../helpers.js";

// `vlad task launch` bellek kapısı (T20261128-06): sahte memwatch durum dosyası (VLAD_MEMWATCH_STATE) ile; launcher noop (vitest env).
const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string, base: string;

function vlad(args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnGuarded("node", [cli, ...args], { encoding: "utf8", env: { ...isolatedEnv(), VLAD_HOME: home, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const GIB = 1024 ** 3;
function fakeState(level: "ok" | "warn" | "critical", reasons: string[], free: number): string {
  const p = join(base, `memwatch-${level}.json`);
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(p, JSON.stringify({ v: 1, updated: now, pid: 1, interval_secs: 10, rss_bytes: 1,
    last: { ts: now, level, reasons, system: { total_bytes: 16 * GIB, free_pct: free, pressure: "normal", swap_total_bytes: 2 * GIB, swap_used_bytes: GIB }, vlad_bytes: 5 * GIB, groups: [] },
    history: [], alerts: {} }));
  return p;
}

beforeEach(() => {
  home = makeHome();
  base = mkdtempSync(join(tmpdir(), "vlad-mw-launch-"));
  const repo = join(base, "alpha");
  mkdirSync(repo);
  const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
  g("init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  g("add", ".");
  g("commit", "-m", "first");
  const card = join(home, "card.md");
  writeFileSync(card, `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
  expect(vlad(["project", "write", "alpha", "--file", card, "--json"]).code).toBe(0);
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ worktreeDir: join(base, "wt") }));
});

const mkTask = (): string => {
  const body = join(home, "body.md");
  writeFileSync(body, "## Tanım\nx\n");
  return JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", body, "--json"]).out).id as string;
};
const stateOf = (id: string): string => JSON.parse(vlad(["kb", "get", id, "--json"]).out).data.state as string;

describe("task launch memory gate", { timeout: 60_000 }, () => {
  it("critical pressure rejects with exit 75 and a 'bellek:' message; the task stays queued", () => {
    const id = mkTask();
    const r = vlad(["task", "launch", id], { VLAD_MEMWATCH_STATE: fakeState("critical", ["boş %7 < %10"], 7) });
    expect(r.code, r.err).toBe(75);
    expect(r.err).toContain("bellek: kritik baskı");
    expect(r.err).toContain("boş %7 < %10");
    expect(r.err).toContain("--force");
    expect(stateOf(id)).toBe("queued");
  });

  it("--json rejection carries the message in the error object", () => {
    const id = mkTask();
    const r = vlad(["task", "launch", id, "--json"], { VLAD_MEMWATCH_STATE: fakeState("critical", ["boş %7 < %10"], 7) });
    expect(r.code).toBe(75);
    expect(JSON.parse(r.err.trim().split("\n").pop()!).error).toMatch(/^bellek: /);
  });

  it("--force launches despite critical pressure and still warns", () => {
    const id = mkTask();
    const r = vlad(["task", "launch", id, "--force", "--json"], { VLAD_MEMWATCH_STATE: fakeState("critical", ["boş %7 < %10"], 7) });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).state).toBe("running");
    expect(r.err).toContain("bellek: kritik baskı, --force ile geçildi");
  });

  it("warn launches with a warning line; ok is silent", () => {
    const w = vlad(["task", "launch", mkTask(), "--json"], { VLAD_MEMWATCH_STATE: fakeState("warn", ["boş %15 < %20"], 15) });
    expect(w.code, w.err).toBe(0);
    expect(w.err).toContain("uyarı: bellek: uyarı");
    expect(JSON.parse(w.out).warnings).toEqual([expect.stringContaining("bellek: uyarı")]);
    const ok = vlad(["task", "launch", mkTask(), "--json"], { VLAD_MEMWATCH_STATE: fakeState("ok", [], 60) });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.err).not.toContain("bellek");
  });

  it("no state file (daemon not running, no binary) does not block", () => {
    const r = vlad(["task", "launch", mkTask(), "--json"], { VLAD_MEMWATCH_STATE: join(base, "yok.json") });
    expect(r.code, r.err).toBe(0);
  });

  it("--dry-run is not gated", () => {
    const r = vlad(["task", "launch", mkTask(), "--dry-run", "--json"], { VLAD_MEMWATCH_STATE: fakeState("critical", ["boş %7 < %10"], 7) });
    expect(r.code, r.err).toBe(0);
  });
});
