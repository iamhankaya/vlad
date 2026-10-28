import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { auditSkills } from "../../src/audit/skills.js";
import { defaultConfig, kbPaths } from "../../src/kb/index.js";
import { worktreePath } from "../../src/git/git.js";
import { claudeProjectDir } from "../../src/tasks/liveness.js";
import { createTask, setState } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

beforeEach(() => { makeHome(); });

describe("auditSkills: cleaned-up tasks", () => {
  it("derives the worktree from the card path + worktreeDir when cleanup nulled the field", () => {
    const repo = join(tmpdir(), "vlad-derive-repo");
    writeFileSync(join(kbPaths().projects, "alpha.md"), `---\nslug: alpha\nname: A\npath: ${JSON.stringify(repo)}\nstack: []\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n`);
    const id = createTask({ project: "alpha", title: "t", kind: "dev", body: "" }).data.id;
    setState(id, "running"); // worktree stays null, as after `task cleanup`
    const cfgDir = mkdtempSync(join(tmpdir(), "vlad-audit-"));
    const dir = join(cfgDir, "projects", claudeProjectDir(worktreePath(defaultConfig(), repo, id)));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "vlad-worker" } }] } }) + "\n");
    expect(auditSkills({ configDir: cfgDir }).tasks).toMatchObject([{ id, transcript: true, missing: [] }]);
  });
});
