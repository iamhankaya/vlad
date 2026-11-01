import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditSkills } from "../../src/audit/skills.js";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import { createTask, getTask, setState } from "../../src/tasks/index.js";
import { markSilentWorkers, type LivenessProbe } from "../../src/tasks/liveness.js";
import { makeHome } from "../helpers.js";

let cfg: VladConfig;
let ids: { remote: string; local: string };
beforeEach(() => {
  const home = makeHome();
  cfg = { ...defaultConfig(), brain: "mac", machines: [
    { name: "mac", os: "darwin", agent: { port: 7437 } },
    { name: "windows", os: "win32", agent: { host: "10.0.0.2", port: 7437 } },
  ] };
  writeFileSync(join(home, "vlad.config.json"), JSON.stringify(cfg));
  const mk = () => createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }).data.id;
  ids = { remote: mk(), local: mk() };
  setState(ids.remote, "running", { worktree: "W:\\wt\\uzak", machine: "windows" });
  setState(ids.local, "running", { worktree: "M:/wt/yerel", machine: "mac" });
});

describe("machines:C1 worktree okuyan tüketiciler uzak görevi atlar", () => {
  it("markSilentWorkers: uzak makinedeki görev yerel probe ile stalled yapılmaz; yerel olan yapılır", () => {
    const probe: LivenessProbe = { alive: () => false, transcriptMtime: () => null };
    const future = new Date(Date.now() + 3 * 3_600_000);
    const out = markSilentWorkers(future, cfg, probe, "win32").map((t) => t.data.id);
    expect(out).toEqual([ids.local]);
    expect(getTask(ids.remote).data.state).toBe("running");
  });

  it("auditSkills: uzak görev yerel transkript taramasına girmez", () => {
    const r = auditSkills({ configDir: mkdtempSync(join(tmpdir(), "vlad-c1a-")) });
    const audited = r.tasks.map((t) => t.id);
    expect(audited).toContain(ids.local);
    expect(audited).not.toContain(ids.remote);
  });
});
