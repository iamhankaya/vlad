import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeJsonPath, trustKey, trustWorktree, untrustWorktree } from "../../src/tasks/trust.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vlad-trust-"));
  file = join(dir, "claude.json");
});
const read = () => JSON.parse(readFileSync(file, "utf8"));

describe("trustKey", () => {
  it("uses forward slashes, as Claude Code does", () => {
    expect(trustKey("C:\\dev\\vlad-wt\\T1")).toBe("C:/dev/vlad-wt/T1");
  });
});

describe("claudeJsonPath", () => {
  it("VLAD_CLAUDE_JSON overrides the home default", () => {
    process.env.VLAD_CLAUDE_JSON = "x.json";
    expect(claudeJsonPath()).toBe("x.json");
    delete process.env.VLAD_CLAUDE_JSON;
    expect(claudeJsonPath()).toMatch(/\.claude\.json$/);
  });
});

describe("trustWorktree", () => {
  it("adds a trusted record and keeps every other field", () => {
    writeFileSync(file, JSON.stringify({ numStartups: 7, projects: { "C:/dev": { hasTrustDialogAccepted: true, lastCost: 1 } } }));
    expect(trustWorktree("C:\\dev\\a-wt\\T1", file)).toBeNull();
    const j = read();
    expect(j.numStartups).toBe(7);
    expect(j.projects["C:/dev"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 1 });
    expect(j.projects["C:/dev/a-wt/T1"].hasTrustDialogAccepted).toBe(true);
  });

  it("creates the file and the projects map when missing", () => {
    expect(trustWorktree("C:\\dev\\a-wt\\T1", file)).toBeNull();
    expect(read().projects["C:/dev/a-wt/T1"]).toMatchObject({ hasTrustDialogAccepted: true });
  });

  it("flips an existing untrusted record without dropping its fields", () => {
    writeFileSync(file, JSON.stringify({ projects: { "C:/dev/a-wt/T1": { hasTrustDialogAccepted: false, lastCost: 2 } } }));
    trustWorktree("C:\\dev\\a-wt\\T1", file);
    expect(read().projects["C:/dev/a-wt/T1"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 2 });
  });

  it("leaves no temp file behind", () => {
    trustWorktree("C:\\dev\\a-wt\\T1", file);
    expect(readdirSync(dir)).toEqual(["claude.json"]);
  });

  it("corrupt JSON: warns, does not throw and does not overwrite", () => {
    writeFileSync(file, "{not json");
    const w = trustWorktree("C:\\dev\\a-wt\\T1", file);
    expect(w).toMatch(/bozuk/);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("unwritable location: warns instead of throwing", () => {
    const w = trustWorktree("C:\\dev\\a-wt\\T1", join(dir, "nope", "deeper", "x", "\0bad"));
    expect(w).toMatch(/yazılamadı/);
  });
});

describe("untrustWorktree", () => {
  it("removes only that record", () => {
    writeFileSync(file, JSON.stringify({ a: 1, projects: { "C:/dev/a-wt/T1": { hasTrustDialogAccepted: true }, "C:/dev": {} } }));
    expect(untrustWorktree("C:\\dev\\a-wt\\T1", file)).toBeNull();
    expect(read()).toEqual({ a: 1, projects: { "C:/dev": {} } });
  });

  it("missing file or record: no-op, no file created", () => {
    expect(untrustWorktree("C:\\dev\\a-wt\\T1", file)).toBeNull();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ projects: {} }));
    expect(untrustWorktree("C:\\dev\\a-wt\\T1", file)).toBeNull();
  });

  it("corrupt JSON: warns", () => {
    writeFileSync(file, "][");
    expect(untrustWorktree("C:\\dev\\a-wt\\T1", file)).toMatch(/bozuk/);
  });
});
