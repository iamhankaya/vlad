import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, readDoc } from "../../src/kb/index.js";
import type { ProjectCard } from "../../src/kb/index.js";
import type { Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, launchTask } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
let base: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });

const vlad = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home, VLAD_MACHINE: "srv", ...env } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const cardMd = (extra: string, path = "C:\\dev\\alpha") => `---
slug: alpha
name: Alpha
path: ${JSON.stringify(path)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
${extra}---

## Özet
x
`;
const card = () => readDoc<ProjectCard>(join(home, "kb", "projects", "alpha.md")).data;

beforeEach(() => {
  home = makeHome();
  base = mkdtempSync(join(tmpdir(), "vlad-s1b-"));
});

describe("records: project path per machine", () => {
  it("records: project path per machine", () => {
    writeProject("alpha", cardMd(""));
    // first machine entry: the legacy path must be kept under a named machine
    const refused = vlad(["project", "path", "alpha", "/srv/alpha", "--json"]);
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.err).error).toMatch(/--keep/);
    expect(card().paths).toBeUndefined();

    const ok = vlad(["project", "path", "alpha", "/srv/alpha", "--keep", "win", "--json"]);
    expect(ok.code).toBe(0);
    expect(card().paths).toEqual({ win: "C:\\dev\\alpha", srv: "/srv/alpha" });
    expect(card().path).toBe("C:\\dev\\alpha");

    expect(vlad(["project", "path", "alpha", "--json"]).out).toContain("/srv/alpha");
    expect(JSON.parse(vlad(["project", "path", "alpha", "--machine", "win", "--json"]).out).path).toBe("C:\\dev\\alpha");
    expect(vlad(["project", "path", "alpha", "D:\\x", "--machine", "pc2", "--json"]).code).toBe(0);
    expect(card().paths?.pc2).toBe("D:\\x");
  });

  it("records: project path rejects bad machine name and missing machine suggests clone", () => {
    writeProject("alpha", cardMd("paths: { win: 'C:\\\\dev\\\\alpha' }\n"));
    expect(vlad(["project", "path", "alpha", "/x", "--machine", "bad name"]).code).toBe(1);
    const r = vlad(["project", "path", "alpha", "--json"]);
    expect(r.code).toBe(1);
    const e = JSON.parse(r.err);
    expect(e.error).toContain("bu makinede klon yok: alpha");
    expect(e.error).toContain("vlad project clone alpha");
  });

  it("records: launch missing clone suggests project clone", async () => {
    writeProject("alpha", cardMd("paths: { win: 'C:\\\\dev\\\\alpha' }\n"));
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
    const l: Launcher = { launch: async () => ({ ok: true, method: "fake" }) };
    await expect(launchTask(t.data.id, { launcher: l, cfg: defaultConfig() })).rejects.toThrow("vlad project clone alpha");
  });
});

describe("records: project clone from local bare repo", () => {
  function bare(): string {
    const work = join(base, "work");
    mkdirSync(work);
    git(work, "init", "-b", "main");
    writeFileSync(join(work, "a.txt"), "1");
    git(work, "add", ".");
    git(work, "commit", "-m", "first");
    const b = join(base, "origin.git");
    git(base, "clone", "--bare", work, b);
    return b;
  }

  it("records: project clone from local bare repo", () => {
    const remote = bare();
    writeProject("alpha", cardMd("repo: o/alpha\n"));
    const to = join(base, "clones", "alpha");
    const r = vlad(["project", "clone", "alpha", "--from", remote, "--to", to, "--keep", "win", "--json"]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(existsSync(join(to, "a.txt"))).toBe(true);
    expect(card().paths).toEqual({ win: "C:\\dev\\alpha", srv: to });
    // a second run must not clobber the existing clone
    const again = vlad(["project", "clone", "alpha", "--from", remote, "--to", to, "--json"]);
    expect(again.code).toBe(1);
    expect(JSON.parse(again.err).error).toMatch(/zaten var/);
  });

  it("records: project clone needs repo or --from, and a failed clone leaves the card alone", () => {
    writeProject("alpha", cardMd(""));
    const noRepo = vlad(["project", "clone", "alpha", "--to", join(base, "c1"), "--keep", "win", "--json"]);
    expect(noRepo.code).toBe(1);
    expect(JSON.parse(noRepo.err).error).toMatch(/repo/);
    const bad = vlad(["project", "clone", "alpha", "--from", join(base, "yok.git"), "--to", join(base, "c2"), "--keep", "win", "--json"]);
    expect(bad.code).toBe(1);
    expect(card().paths).toBeUndefined();
  });
});

describe("records: task progress / pr", () => {
  beforeEach(() => {
    writeProject("alpha", cardMd(""));
  });

  it("records: task progress writes pct and label", () => {
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
    const id = t.data.id;
    expect(vlad(["task", "progress", id, "--pct", "40", "--label", "testler", "--json"]).code).toBe(0);
    const p = getTask(id).data.progress!;
    expect(p).toMatchObject({ pct: 40, label: "testler" });
    expect(Date.parse(p.at)).not.toBeNaN();
    // no --pct → indeterminate
    vlad(["task", "progress", id, "--label", "okuyorum"]);
    expect(getTask(id).data.progress).toMatchObject({ pct: null, label: "okuyorum" });
    expect(vlad(["task", "progress", id, "--pct", "101", "--label", "x"]).code).toBe(1);
    expect(vlad(["task", "progress", id, "--pct", "1.5", "--label", "x"]).code).toBe(1);
    expect(vlad(["task", "progress", id, "--pct", "abc", "--label", "x"]).code).toBe(1);
    expect(vlad(["task", "progress", id, "--label", "  "]).code).toBe(1);
    expect(getTask(id).data.progress).toMatchObject({ label: "okuyorum" });
  });

  it("records: task pr writes number repo base url", () => {
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
    const id = t.data.id;
    const r = vlad(["task", "pr", id, "--number", "12", "--repo", "iamhankaya/vlad", "--base", "vlad/T20261024-94", "--url", "https://github.com/iamhankaya/vlad/pull/12", "--json"]);
    expect(r.code).toBe(0);
    expect(getTask(id).data.pr).toEqual({ number: 12, repo: "iamhankaya/vlad", base: "vlad/T20261024-94", url: "https://github.com/iamhankaya/vlad/pull/12" });
    vlad(["task", "pr", id, "--number", "13", "--repo", "o/r", "--base", "main"]);
    expect(getTask(id).data.pr).toEqual({ number: 13, repo: "o/r", base: "main" });
    expect(vlad(["task", "pr", id, "--number", "0", "--repo", "o/r", "--base", "main"]).code).toBe(1);
    expect(vlad(["task", "pr", id, "--number", "2", "--repo", "bad", "--base", "main"]).code).toBe(1);
    expect(getTask(id).data.pr?.number).toBe(13);
  });

  it("records: task progress on unknown task fails", () => {
    expect(vlad(["task", "progress", "T20990101-01", "--label", "x"]).code).toBe(1);
  });
});

describe("records: launch writes host", () => {
  it("records: launch writes host", async () => {
    const repo = join(base, "alpha");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "first");
    // paths names this machine only; `path` is a Windows leftover that must not be used
    writeProject("alpha", cardMd(`paths: { win: 'C:\\\\dev\\\\alpha', box: ${JSON.stringify(repo)} }\n`));
    const cfg = { ...defaultConfig(), worktreeDir: join(base, "wt") };
    const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "## Tanım\nx\n" });
    const l: Launcher = { launch: async () => ({ ok: true, method: "fake" }) };
    process.env.VLAD_MACHINE = "box";
    try {
      const r = await launchTask(t.data.id, { launcher: l, cfg });
      expect(r.data.host).toBe("box");
      expect(getTask(t.data.id).data.host).toBe("box");
      expect(existsSync(r.data.worktree!)).toBe(true);
    } finally {
      delete process.env.VLAD_MACHINE;
    }
  });
});
