import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { installGlobal, mergeSessionEndHook } from "../src/install.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cmd = 'node "C:/dev/vlad/dist/hooks/session-report.js"';

describe("mergeSessionEndHook", () => {
  it("adds the hook to an empty settings object", () => {
    const s = mergeSessionEndHook({}, cmd);
    expect(s.hooks.SessionEnd[0].hooks[0]).toEqual({ type: "command", command: cmd, timeout: 10 });
  });
  it("is idempotent: applying twice keeps a single entry", () => {
    const s = mergeSessionEndHook(mergeSessionEndHook({}, cmd), cmd);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].hooks).toHaveLength(1);
  });
  it("preserves other hooks, existing SessionEnd entries and fields", () => {
    const start = [{ hooks: [{ type: "command", command: "echo hi" }] }];
    const other = { hooks: [{ type: "command", command: "other-end" }] };
    const input = { permissions: { allow: ["Bash(git:*)"] }, hooks: { SessionStart: start, SessionEnd: [other] } };
    const s = mergeSessionEndHook(input, cmd);
    expect(s.permissions).toEqual({ allow: ["Bash(git:*)"] });
    expect(s.hooks.SessionStart).toEqual(start);
    expect(s.hooks.SessionEnd).toHaveLength(2);
    expect(s.hooks.SessionEnd[0]).toEqual(other);
    expect(s.hooks.SessionEnd[1].hooks[0].command).toBe(cmd);
  });
  it("does not mutate its input", () => {
    const input = { hooks: { SessionStart: [] } };
    mergeSessionEndHook(input, cmd);
    expect(input).toEqual({ hooks: { SessionStart: [] } });
  });
  it("upgrades an existing entry without a timeout in place, then is a no-op", () => {
    const input = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: cmd }] }] } };
    const s = mergeSessionEndHook(input, cmd);
    expect(s.hooks.SessionEnd).toHaveLength(1);
    expect(s.hooks.SessionEnd[0].hooks[0]).toEqual({ type: "command", command: cmd, timeout: 10 });
    expect(mergeSessionEndHook(s, cmd)).toEqual(s);
  });
  it("raises a too-small timeout but keeps a larger one", () => {
    const small = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: cmd, timeout: 2 }] }] } };
    expect(mergeSessionEndHook(small, cmd).hooks.SessionEnd[0].hooks[0].timeout).toBe(10);
    const big = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: cmd, timeout: 30 }] }] } };
    expect(mergeSessionEndHook(big, cmd)).toEqual(big);
  });
  it("detects the command inside a multi-hook entry", () => {
    const input = { hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "x" }, { type: "command", command: cmd, timeout: 10 }] }] } };
    expect(mergeSessionEndHook(input, cmd)).toEqual(input);
  });
});

describe("non-array SessionEnd", () => {
  it("mergeSessionEndHook throws", () => {
    expect(() => mergeSessionEndHook({ hooks: { SessionEnd: {} } }, cmd)).toThrow(/dizi/);
  });
});

describe("installGlobal", () => {
  it("throws without writing when hooks.SessionEnd is not an array", () => {
    const root = mkdtempSync(join(tmpdir(), "vlad-install-bad-"));
    const h = join(root, "home");
    const cd = join(root, ".claude");
    mkdirSync(join(h, "global", "skills", "vlad-worker"), { recursive: true });
    writeFileSync(join(h, "global", "skills", "vlad-worker", "SKILL.md"), "# w\n", "utf8");
    mkdirSync(cd, { recursive: true });
    const raw = JSON.stringify({ hooks: { SessionEnd: "x" } });
    writeFileSync(join(cd, "settings.json"), raw, "utf8");
    expect(() => installGlobal({ home: h, claudeDir: cd, dryRun: false })).toThrow(/dizi/);
    expect(readFileSync(join(cd, "settings.json"), "utf8")).toBe(raw);
    expect(readdirSync(cd)).toEqual(["settings.json"]);
  });

  let home: string;
  let claudeDir: string;
  const now = new Date(2026, 9, 15, 21, 5, 9);

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), "vlad-install-"));
    home = join(root, "vlad home");
    claudeDir = join(root, ".claude");
    mkdirSync(join(home, "global", "skills", "vlad-worker"), { recursive: true });
    writeFileSync(join(home, "global", "skills", "vlad-worker", "SKILL.md"), "# worker\n", "utf8");
    mkdirSync(claudeDir, { recursive: true });
  });

  const hookCmd = () => `node "${home.replace(/\\/g, "/")}/dist/hooks/session-report.js"`;
  const readSettings = () => JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));

  it("backs up settings.json, merges the hook and copies the worker skill", () => {
    const original = { model: "opus", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "s" }] }] } };
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify(original), "utf8");
    const r = installGlobal({ home, claudeDir, dryRun: false, now });
    const bak = join(claudeDir, "settings.json.bak-20261015T210509");
    expect(JSON.parse(readFileSync(bak, "utf8"))).toEqual(original);
    const s = readSettings();
    expect(s.model).toBe("opus");
    expect(s.hooks.SessionStart).toEqual(original.hooks.SessionStart);
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe(hookCmd());
    expect(hookCmd()).not.toContain("\\");
    expect(readFileSync(join(claudeDir, "skills", "vlad-worker", "SKILL.md"), "utf8")).toBe("# worker\n");
    expect(r.actions.length).toBeGreaterThanOrEqual(3);
  });

  it("creates settings.json when missing (no backup)", () => {
    installGlobal({ home, claudeDir, dryRun: false, now });
    expect(readSettings().hooks.SessionEnd[0].hooks[0].command).toBe(hookCmd());
    expect(readdirSync(claudeDir).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("creates claudeDir when it does not exist", () => {
    claudeDir = join(claudeDir, "nested");
    installGlobal({ home, claudeDir, dryRun: false, now });
    expect(existsSync(join(claudeDir, "settings.json"))).toBe(true);
    expect(existsSync(join(claudeDir, "skills", "vlad-worker", "SKILL.md"))).toBe(true);
  });

  it("second run leaves settings untouched (no new backup, single entry)", () => {
    installGlobal({ home, claudeDir, dryRun: false, now });
    installGlobal({ home, claudeDir, dryRun: false, now: new Date(2026, 9, 15, 22, 0, 0) });
    expect(readSettings().hooks.SessionEnd).toHaveLength(1);
    expect(readdirSync(claudeDir).filter((f) => f.includes(".bak-"))).toEqual([]);
  });

  it("writes timeout 10, upgrades an old no-timeout entry once with a backup, then no-ops", () => {
    installGlobal({ home, claudeDir, dryRun: false, now });
    expect(readSettings().hooks.SessionEnd[0].hooks[0].timeout).toBe(10);
    writeFileSync(
      join(claudeDir, "settings.json"),
      JSON.stringify({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: hookCmd() }] }] } }),
      "utf8",
    );
    installGlobal({ home, claudeDir, dryRun: false, now });
    expect(readSettings().hooks.SessionEnd).toHaveLength(1);
    expect(readSettings().hooks.SessionEnd[0].hooks[0].timeout).toBe(10);
    expect(readdirSync(claudeDir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
    installGlobal({ home, claudeDir, dryRun: false, now: new Date(2026, 9, 15, 23, 0, 0) });
    expect(readdirSync(claudeDir).filter((f) => f.includes(".bak-"))).toHaveLength(1);
  });

  it("dryRun returns actions without touching disk", () => {
    writeFileSync(join(claudeDir, "settings.json"), "{}", "utf8");
    const r = installGlobal({ home, claudeDir, dryRun: true, now });
    expect(r.actions.length).toBeGreaterThanOrEqual(3);
    expect(r.actions.join("\n")).toContain(hookCmd());
    expect(readdirSync(claudeDir)).toEqual(["settings.json"]);
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe("{}");
  });

  it("throws on invalid settings.json without overwriting it", () => {
    writeFileSync(join(claudeDir, "settings.json"), "{ bozuk", "utf8");
    expect(() => installGlobal({ home, claudeDir, dryRun: false, now })).toThrow(/settings\.json/);
    expect(readFileSync(join(claudeDir, "settings.json"), "utf8")).toBe("{ bozuk");
  });

  it("throws when the worker skill source is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "vlad-install-empty-"));
    expect(() => installGlobal({ home: empty, claudeDir, dryRun: true, now })).toThrow(/vlad-worker/);
  });
});

describe("content files", () => {
  const skills = ["scan", "delegate", "status", "digest"].map((n) => [n, join(repo, ".claude", "skills", n, "SKILL.md")] as const);
  skills.push(["vlad-worker", join(repo, "global", "skills", "vlad-worker", "SKILL.md")]);

  it.each(skills)("%s SKILL.md has name/description frontmatter", (name, path) => {
    const text = readFileSync(path, "utf8");
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    expect(m).not.toBeNull();
    const fm = parse(m![1]);
    expect(fm.name).toBe(name);
    expect(typeof fm.description).toBe("string");
  });

  it(".claude/settings.json registers the SessionStart summary hook", () => {
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: "node \"${CLAUDE_PROJECT_DIR}/dist/cli.js\" status --summary --hook" });
  });
});
