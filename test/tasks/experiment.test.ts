import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { LaunchRequest, Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { launchTask } from "../../src/tasks/launch.js";
import { PONYTAIL_OFF_NOTE, ponytailArm, stripPonytailParagraph, withoutPonytail } from "../../src/tasks/experiment.js";
import { createTask, getTask } from "../../src/tasks/index.js";
import type { RemoteTransport } from "../../src/machines/index.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...a], { cwd, stdio: "pipe", encoding: "utf8" });
const withAb = (cfg: VladConfig): VladConfig => ({ ...cfg, experiments: { ponytail: "ab" } });
const dev = { skills: ["superpowers:test-driven-development", "ponytail"] };

describe("ponytailArm", () => {
  it("is undefined unless experiments.ponytail is 'ab' and the role names ponytail", () => {
    const cfg = defaultConfig();
    expect(ponytailArm("T20261015-02", dev, cfg)).toBeUndefined();
    expect(ponytailArm("T20261015-02", { skills: ["x"] }, withAb(cfg))).toBeUndefined();
    expect(ponytailArm("T20261015-02", undefined, withAb(cfg))).toBeUndefined();
  });
  it("odd last digit -> off, even -> on", () => {
    const cfg = withAb(defaultConfig());
    expect(ponytailArm("T20261015-01", dev, cfg)).toBe("off");
    expect(ponytailArm("T20261015-02", dev, cfg)).toBe("on");
    expect(ponytailArm("T20261015-10", dev, cfg)).toBe("on");
    expect(ponytailArm("T20261015-19", dev, cfg)).toBe("off");
  });
  it("withoutPonytail drops only ponytail", () => {
    expect(withoutPonytail({ title: "t", skills: ["a", "ponytail", "b"] }).skills).toEqual(["a", "b"]);
  });
});

describe("stripPonytailParagraph", () => {
  it("removes only the ponytail rule bullet from a role body", () => {
    const body = ["- a", "- **ponytail (deneme):** x y z", "- b", ""].join("\n");
    expect(stripPonytailParagraph(body)).toBe(["- a", "- b", ""].join("\n"));
  });
});

describe("launch: ponytail A/B", () => {
  let repo: string; let cfg: VladConfig; let home: string;
  afterEach(() => { rmTemp(dirname(repo)); rmTemp(home); });
  beforeEach(() => {
    home = makeHome();
    const base = mkdtempSync(join(tmpdir(), "vlad-exp-"));
    repo = join(base, "alpha");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "1");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "first");
    cfg = defaultConfig();
    cfg.worktreeDir = join(base, "wt");
    writeProject("alpha", `---\nslug: alpha\nname: Alpha\npath: ${JSON.stringify(repo)}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
    mkdirSync(join(home, "roles"), { recursive: true });
    writeFileSync(join(home, "roles", "developer.md"), `---\nslug: developer\ntitle: Dev\nkind: executor\nsummary: s\nskills:\n  - superpowers:test-driven-development\n  - ponytail\n---\n`);
  });
  const fake = (): Launcher & { reqs: LaunchRequest[] } => {
    const reqs: LaunchRequest[] = [];
    return { reqs, async launch(r) { reqs.push(r); return { ok: true, method: "fake" }; } };
  };
  const mk = () => createTask({ project: "alpha", title: "x", kind: "dev", body: "", role: "developer" }, new Date(2026, 9, 15));

  it("odd id: ponytail left out of the prompt and experiment.ponytail=off recorded; even id: kept and on", async () => {
    const odd = mk(); const even = mk();
    expect([odd.data.id, even.data.id]).toEqual(["T20261015-01", "T20261015-02"]);
    const l = fake();
    await launchTask(odd.data.id, { launcher: l, cfg: withAb(cfg) });
    await launchTask(even.data.id, { launcher: l, cfg: withAb(cfg) });
    expect(l.reqs[0].prompt).not.toContain("SKILL.md"); // vendored ponytail file is not offered
    expect(l.reqs[0].prompt).toContain(PONYTAIL_OFF_NOTE);
    expect(l.reqs[0].prompt).toContain("superpowers:test-driven-development");
    expect(getTask(odd.data.id).data.experiment).toEqual({ ponytail: "off" });
    expect(l.reqs[1].prompt).toContain("ponytail");
    expect(l.reqs[1].prompt).not.toContain(PONYTAIL_OFF_NOTE);
    expect(getTask(even.data.id).data.experiment).toEqual({ ponytail: "on" });
  });


  it("remote launch: the prompt template drops ponytail on the off arm and experiment is recorded on the running task", async () => {
    const c: VladConfig = { ...withAb(cfg), brain: "mac", machines: [
      { name: "mac", os: "darwin", agent: { port: 7437 } },
      { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 } },
    ] };
    writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
machines: [windows]
---

## Özet
x
`);
    const odd = mk(); const even = mk();
    const prompts: string[] = [];
    const transport: RemoteTransport = {
      async call(to, op, args, o) {
        const result = op === "launch" ? (prompts.push(args.promptTemplate), { branch: args.branch, worktree: "W:\wt\X", method: "wt" }) : { machine: to };
        return { opId: o?.opId ?? "x", result: result as never };
      },
    };
    await launchTask(odd.data.id, { launcher: fake(), cfg: c, remote: { transport } });
    await launchTask(even.data.id, { launcher: fake(), cfg: c, remote: { transport } });
    expect(prompts[0]).toContain(PONYTAIL_OFF_NOTE);
    expect(prompts[0]).not.toContain("VENDOR_SKILL:ponytail");
    expect(prompts[1]).toContain("VENDOR_SKILL:ponytail");
    expect(prompts[1]).not.toContain(PONYTAIL_OFF_NOTE);
    expect(getTask(odd.data.id).data).toMatchObject({ machine: "windows", experiment: { ponytail: "off" } });
    expect(getTask(even.data.id).data).toMatchObject({ machine: "windows", experiment: { ponytail: "on" } });
  });

  it("default (no experiments): ponytail always in the prompt, no experiment field", async () => {
    const odd = mk();
    const l = fake();
    await launchTask(odd.data.id, { launcher: l, cfg });
    expect(l.reqs[0].prompt).toContain("ponytail");
    expect(getTask(odd.data.id).data.experiment).toBeUndefined();
  });
});
