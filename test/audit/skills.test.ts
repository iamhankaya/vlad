import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { kbPaths } from "../../src/kb/index.js";
import { auditSkills, claudeProjectDir, scanTranscript } from "../../src/audit/skills.js";
import { createTask, setState } from "../../src/tasks/index.js";
import { makeHome } from "../helpers.js";

const w = (...parts: string[]) => parts.join(String.fromCharCode(92)); // Windows path without escape noise
let cfgDir: string;
beforeEach(() => {
  writeFileSync(join(makeHome(), "vlad.config.json"), JSON.stringify({ defaultAutonomy: "pr" }));
  cfgDir = mkdtempSync(join(tmpdir(), "vlad-audit-"));
});

const use = (name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const skill = (s: string) => use("Skill", { skill: s });
const read = (p: string) => use("Read", { file_path: p });
const bash = (c: string) => use("Bash", { command: c });
const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Skill dedim ama çağırmadım" }] } });

function transcript(worktree: string, lines: string[], file = "s1.jsonl") {
  const dir = join(cfgDir, "projects", claudeProjectDir(worktree));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), lines.join("\n") + "\n");
}
function role(slug: string, skills: string[]) {
  mkdirSync(kbPaths().roles, { recursive: true });
  writeFileSync(join(kbPaths().roles, `${slug}.md`), `---\nslug: ${slug}\ntitle: T\nkind: executor\nsummary: s\nskills:\n${skills.map((s) => `  - ${s}`).join("\n")}\n---\n`);
}
function task(wt: string, o: { role?: string; autonomy?: "commit" | "pr" } = {}) {
  const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "", role: o.role });
  setState(t.data.id, "running", { worktree: wt, branch: `vlad/${t.data.id}` });
  return t.data.id;
}

describe("claudeProjectDir", () => {
  it("maps every non-alphanumeric char to '-' (claude's project dir naming)", () => {
    expect(claudeProjectDir(w("C:", "dev", "x-wt", "T1"))).toBe("C--dev-x-wt-T1");
  });
});

describe("scanTranscript", () => {
  it("counts Skill calls and SKILL.md reads (incl. vendored) by bare name; ignores prose; tolerates broken lines", () => {
    const r = scanTranscript([
      skill("vlad-worker"), skill("superpowers:test-driven-development"), skill("superpowers:test-driven-development"),
      read(w("C:", "dev", "vlad", "vendor", "skills", "ponytail", "SKILL.md")), read(w("C:", "dev", "x", "src", "main.ts")), text, "{broken",
      bash("git -C wt push -u origin vlad/T1"),
    ].join("\n"));
    expect(r.loaded).toEqual({ "vlad-worker": 1, "test-driven-development": 2, ponytail: 1 });
    expect(r.pushed).toBe(true);
  });
  it("a plain 'git push' mention in prose is not a push", () => {
    expect(scanTranscript([text, bash("git status")].join("\n")).pushed).toBe(false);
  });
});

describe("auditSkills", () => {
  it("expected = vlad-worker + role skills (+ ci-triage when pushed); reports loaded/missing and rates", () => {
    role("developer", ["superpowers:test-driven-development", "ponytail"]);
    const a = task(w("C:", "w", "a"), { role: "developer" });
    transcript(w("C:", "w", "a"), [skill("vlad-worker"), skill("superpowers:test-driven-development")]);
    const b = task(w("C:", "w", "b"), { role: "developer" });
    transcript(w("C:", "w", "b"), [skill("vlad-worker"), read("/r/vendor/skills/ponytail/SKILL.md"), skill("superpowers:test-driven-development"), bash("git push -u origin vlad/x")]);
    const c = task(w("C:", "w", "c")); // no transcript
    const r = auditSkills({ configDir: cfgDir });
    const by = Object.fromEntries(r.tasks.map((t) => [t.id, t]));
    expect(by[a].expected.sort()).toEqual(["ponytail", "test-driven-development", "vlad-worker"]);
    expect(by[a].missing).toEqual(["ponytail"]);
    expect(by[b].expected).toContain("ci-triage");
    expect(by[b].missing).toEqual(["ci-triage"]);
    expect(by[c]).toMatchObject({ transcript: false, missing: [] });
    expect(r.summary).toMatchObject({ tasks: 3, audited: 2, expected: 7, loaded: 5 });
    expect(r.summary.rate).toBeCloseTo(5 / 7);
  });

  it("project card skills are expected too", () => {
    writeFileSync(join(kbPaths().projects, "alpha.md"), `---
slug: alpha
name: A
path: x
stack: []
status: active
autonomy: commit
skills: [ab-test-ve-kapi]
last_activity: null
last_scanned: null
---
`);
    const id = task(w("C:", "w", "e"));
    transcript(w("C:", "w", "e"), [skill("vlad-worker")]);
    expect(auditSkills({ configDir: cfgDir }).tasks.find((t) => t.id === id)).toMatchObject({ expected: ["vlad-worker", "ab-test-ve-kapi"], missing: ["ab-test-ve-kapi"] });
  });

  it("filters by --since (task created) and --project", () => {
    const t = task(w("C:", "w", "d"));
    transcript(w("C:", "w", "d"), [skill("vlad-worker")]);
    expect(auditSkills({ configDir: cfgDir, since: "2999-01-01" }).tasks).toEqual([]);
    expect(auditSkills({ configDir: cfgDir, project: "zzz" }).tasks).toEqual([]);
    expect(auditSkills({ configDir: cfgDir, since: "2000-01-01", project: "alpha" }).tasks.map((x) => x.id)).toEqual([t]);
  });

  it("VLAD session: counts final-gate skills; second-opinion/integrate expected only after a closed pipeline", () => {
    const home = process.env.VLAD_HOME!;
    transcript(home, [skill("integrate"), skill("vlad-worker")], "vlad.jsonl");
    let r = auditSkills({ configDir: cfgDir });
    expect(r.vlad).toMatchObject({ loaded: { integrate: 1 }, expected: [], missing: [] });
    const p = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "" }).data.id;
    setState(p, "running");
    setState(p, "awaiting_approval");
    setState(p, "done");
    r = auditSkills({ configDir: cfgDir });
    expect(r.vlad.expected.sort()).toEqual(["integrate", "second-opinion"]);
    expect(r.vlad.missing).toEqual(["second-opinion"]);
  });
});
