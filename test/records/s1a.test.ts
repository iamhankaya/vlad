import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ValidationError, checkMinCliVersion, cliVersion, compareVersions, currentMachine, loadConfig, resolveProjectPath, validate } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => { home = makeHome(); });

const vlad = (args: string[], extraEnv: Record<string, string> = {}) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home, ...extraEnv } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const task = (extra: object = {}) => ({
  id: "T20261024-97", project: "vlad", title: "t", kind: "dev", state: "queued", autonomy: "commit",
  created: "2026-10-24T10:00:00Z", updated: "2026-10-24T10:00:00Z", ...extra,
});
const card = (extra: object = {}) => ({
  slug: "vlad", name: "VLAD", path: "C:\\dev\\vlad", stack: ["ts"], status: "active", autonomy: "commit",
  last_activity: null, last_scanned: null, ...extra,
});
const config = (extra: object = {}) => ({
  roots: ["C:\\dev"], ignore: [], defaultAutonomy: "commit", staleAfterHours: 6, launcher: "auto", worktreeDir: "{repo}-wt", projects: {}, ...extra,
});
const rejects = (kind: "task" | "project" | "config", data: unknown) => expect(() => validate(kind, data)).toThrow(ValidationError);

describe("records: task", () => {
  it("records: task accepts progress/pr/host", () => {
    validate("task", task());
    validate("task", task({
      host: "vlad-server",
      progress: { pct: 40, label: "testler", at: "2026-10-24T10:05:00Z" },
      pr: { number: 12, repo: "iamhankaya/vlad", base: "vlad/T20261024-94", url: "https://github.com/iamhankaya/vlad/pull/12" },
    }));
    validate("task", task({ host: null, progress: { pct: null, label: "x", at: "2026-10-24T10:05:00Z" }, pr: null }));
    validate("task", task({ pr: { number: 1, repo: "o/r", base: "main" } }));
  });

  it("records: task rejects progress.pct 101", () => {
    rejects("task", task({ progress: { pct: 101, label: "x", at: "2026-10-24T10:05:00Z" } }));
    rejects("task", task({ progress: { pct: -1, label: "x", at: "2026-10-24T10:05:00Z" } }));
    rejects("task", task({ progress: { pct: 1.5, label: "x", at: "2026-10-24T10:05:00Z" } }));
    validate("task", task({ progress: { pct: 100, label: "x", at: "2026-10-24T10:05:00Z" } }));
  });

  it("records: task rejects malformed pr and progress", () => {
    rejects("task", task({ pr: { number: 0, repo: "o/r", base: "main" } }));
    rejects("task", task({ pr: { number: 3, repo: "not a repo", base: "main" } }));
    rejects("task", task({ pr: { number: 3, repo: "o/r" } }));
    rejects("task", task({ pr: { number: 3, repo: "o/r", base: "main", extra: 1 } }));
    rejects("task", task({ progress: { pct: 5, at: "2026-10-24T10:05:00Z" } }));
    rejects("task", task({ progress: { pct: 5, label: "x", at: "dün" } }));
    rejects("task", task({ host: 7 }));
  });
});

describe("records: project paths", () => {
  it("records: project accepts paths per machine, path stays required", () => {
    validate("project", card({ paths: { "vlad-server": "/srv/vlad/repos/vlad", "win-pc_1.local": "C:\\dev\\vlad" } }));
    const { path: _p, ...noPath } = card({ paths: { a: "/x" } });
    rejects("project", noPath);
    rejects("project", card({ paths: { "bad key": "/x" } }));
    rejects("project", card({ paths: { a: "" } }));
    rejects("project", card({ paths: { a: 3 } }));
  });

  it("records: resolveProjectPath picks the machine entry", () => {
    const c = card({ paths: { srv: "/srv/vlad" } });
    expect(resolveProjectPath(c, "srv")).toBe("/srv/vlad");
    expect(() => resolveProjectPath(c, "pc")).toThrow("bu makinede klon yok: vlad");
    // a card without paths is single-machine
    expect(resolveProjectPath(card(), "anything")).toBe("C:\\dev\\vlad");
    expect(resolveProjectPath(card({ paths: {} }), "anything")).toBe("C:\\dev\\vlad");
  });
});

describe("records: machine", () => {
  it("records: currentMachine prefers VLAD_MACHINE, else lower-cased hostname", () => {
    expect(currentMachine({ VLAD_MACHINE: "Vlad-Server" }, () => "x")).toBe("vlad-server");
    expect(currentMachine({}, () => "DESKTOP-ABC")).toBe("desktop-abc");
    expect(currentMachine({ VLAD_MACHINE: "  " }, () => "Host.Local")).toBe("host.local");
    expect(() => currentMachine({ VLAD_MACHINE: "a b" }, () => "x")).toThrow(/geçersiz makine adı/);
    expect(() => currentMachine({}, () => "çay")).toThrow(/geçersiz makine adı/);
  });
});

describe("records: config", () => {
  const write = (extra: object) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(config(extra)));

  it("records: config machines overlay", () => {
    write({
      maxParallel: 4, kbPushBranch: "kb-main",
      machines: { srv: { roots: ["/srv/repos"], launcher: "cloud", maxParallel: 2, worktreeDir: "/srv/wt/{repo}", kbPushBranch: "kb-srv" } },
    });
    const srv = loadConfig(home, "srv");
    expect(srv).toMatchObject({ roots: ["/srv/repos"], launcher: "cloud", maxParallel: 2, worktreeDir: "/srv/wt/{repo}", kbPushBranch: "kb-srv" });
    expect(srv.machines?.srv).toBeDefined();
    // another machine keeps the top-level values
    expect(loadConfig(home, "pc")).toMatchObject({ roots: ["C:\\dev"], launcher: "auto", maxParallel: 4, worktreeDir: "{repo}-wt", kbPushBranch: "kb-main" });
  });

  it("records: config machines overlay is partial and validated", () => {
    write({ machines: { srv: { maxParallel: 3 } } });
    expect(loadConfig(home, "srv")).toMatchObject({ roots: ["C:\\dev"], maxParallel: 3 });
    write({ machines: { srv: { maxParallel: 0 } } });
    expect(() => loadConfig(home, "srv")).toThrow(ValidationError);
    write({ machines: { srv: { projects: {} } } });
    expect(() => loadConfig(home, "srv")).toThrow(ValidationError);
    write({ machines: { "bad name": {} } });
    expect(() => loadConfig(home, "srv")).toThrow(ValidationError);
  });

  it("records: loadConfig defaults the machine to this one", () => {
    write({ machines: { "m-x": { maxParallel: 9 } } });
    const saved = process.env.VLAD_MACHINE;
    process.env.VLAD_MACHINE = "m-x";
    try { expect(loadConfig(home).maxParallel).toBe(9); } finally {
      if (saved === undefined) delete process.env.VLAD_MACHINE; else process.env.VLAD_MACHINE = saved;
    }
  });

  it("records: minCliVersion must be x.y.z", () => {
    write({ minCliVersion: "0.2.0" });
    expect(loadConfig(home).minCliVersion).toBe("0.2.0");
    write({ minCliVersion: "latest" });
    expect(() => loadConfig(home)).toThrow(ValidationError);
  });
});

describe("records: minCliVersion", () => {
  it("records: compareVersions orders numerically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.9", "0.2.0")).toBeLessThan(0);
  });

  it("records: checkMinCliVersion throws only when the CLI is older", () => {
    const set = (v: string) => writeFileSync(join(home, "vlad.config.json"), JSON.stringify(config({ minCliVersion: v })));
    set("0.2.0");
    expect(() => checkMinCliVersion(home, "0.1.0")).toThrow("VLAD CLI çok eski: 0.2.0");
    expect(() => checkMinCliVersion(home, "0.2.0")).not.toThrow();
    expect(() => checkMinCliVersion(home, "1.0.0")).not.toThrow();
    // no config, broken config, no field: not this check's business
    writeFileSync(join(home, "vlad.config.json"), "{ nope");
    expect(() => checkMinCliVersion(home, "0.0.1")).not.toThrow();
    writeFileSync(join(home, "vlad.config.json"), "{}");
    expect(() => checkMinCliVersion(home, "0.0.1")).not.toThrow();
  });

  it("records: old cli rejected by minCliVersion", () => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(config({ minCliVersion: "999.0.0" })));
    for (const args of [["inbox", "count"], ["task", "list"], ["status"]]) {
      const r = vlad([...args, "--json"]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.err).error).toContain("VLAD CLI çok eski: 999.0.0");
      expect(r.out).toBe("");
    }
    const plain = vlad(["inbox", "count"]);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("hata: VLAD CLI çok eski: 999.0.0");
  });

  it("records: cli at or above minCliVersion runs", () => {
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify(config({ minCliVersion: cliVersion() })));
    expect(vlad(["inbox", "count", "--json"]).code).toBe(0);
  });
});

describe("launcher: linux task launch --dry-run", () => {
  it.skipIf(process.platform === "win32")("launcher: dry-run worktree is absolute, backslash-free, under worktreeDir", () => {
    const base = mkdtempSync(join(tmpdir(), "vlad-s1a-"));
    const repo = join(base, "alpha");
    mkdirSync(repo);
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd: repo, stdio: "pipe" });
    g("init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1");
    g("add", ".");
    g("commit", "-m", "first");
    writeFileSync(join(home, "card.md"), `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    const run = (args: string[]) => { const r = vlad(args); expect(r.err).toBe(""); return r.out; };
    run(["project", "write", "alpha", "--file", join(home, "card.md")]);
    writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ worktreeDir: join(base, "wt") }));
    writeFileSync(join(home, "body.md"), "## Tanım\nx\n");
    const id = JSON.parse(run(["task", "new", "--project", "alpha", "--title", "T", "--body-file", join(home, "body.md"), "--json"])).id;
    const l = JSON.parse(run(["task", "launch", id, "--dry-run", "--json"]));
    expect(l.worktree).toBe(join(base, "wt", id));
    expect(l.worktree.startsWith("/")).toBe(true);
    expect(l.worktree).not.toContain("\\");
  });
});
