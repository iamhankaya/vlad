import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..", "..");
const skill = readFileSync(join(root, "global", "skills", "vlad-worker", "SKILL.md"), "utf8");

const cache = new Map<string, string>();
const help = (...args: string[]): string => {
  const k = args.join(" ");
  if (cache.has(k)) return cache.get(k)!;
  try {
    const o = execFileSync("node", [join(root, "dist", "cli.js"), ...args, "--help"], { encoding: "utf8" });
    cache.set(k, o);
    return o;
  } catch (e) {
    return "";
  }
};

/** every `vlad <group> [<sub>]` inside inline code spans of the skill text */
const commands = (): Array<{ group: string; sub?: string; text: string }> => {
  const found: Array<{ group: string; sub?: string; text: string }> = [];
  for (const m of skill.matchAll(/`(vlad [^`]+)`/g)) {
    const words = m[1].split(/\s+/).slice(1);
    if (!words[0] || !/^[a-z]+$/.test(words[0])) continue;
    const sub = words[1] && /^[a-z]+$/.test(words[1]) ? words[1] : undefined;
    found.push({ group: words[0], sub, text: m[1] });
  }
  return found;
};

describe("skills: vlad-worker", () => {
  // each help call spawns the CLI; allow headroom under full-suite load
  it("every vlad command named in the skill exists in the CLI", { timeout: 60_000 }, () => {
    const cmds = commands();
    expect(cmds.length).toBeGreaterThan(0);
    for (const c of cmds) {
      const top = help();
      expect(top, c.text).toMatch(new RegExp(`^\\s+${c.group}\\b`, "m"));
      if (c.sub) expect(help(c.group), c.text).toMatch(new RegExp(`^\\s+${c.sub}\\b`, "m"));
    }
  });

  it("task pr flags in the skill match the real CLI", () => {
    const real = help("task", "pr");
    const line = skill.match(/`(vlad task pr [^`]+)`/)?.[1] ?? "";
    expect(line).not.toBe("");
    const flags = [...line.matchAll(/--[a-z]+/g)].map((m) => m[0]);
    expect(flags).toEqual(expect.arrayContaining(["--number", "--repo", "--base"]));
    for (const f of flags) expect(real, f).toContain(f);
  });

  it("commands the worker cannot run (S2a deny list) are not instructed", () => {
    const denied = /^vlad (project list|task list|session|task set|quota|kb commit|status)/;
    for (const c of commands()) expect(c.text, c.text).not.toMatch(denied);
    // the task-writing commands the skill does instruct must be ones the scope guard lets through
    const own = new Set(["log", "ask", "report", "progress", "pr"]);
    for (const c of commands()) {
      if (c.group === "task" && c.sub && ["log", "ask", "report", "progress", "pr"].includes(c.sub)) expect(own.has(c.sub)).toBe(true);
    }
  });

  it("phase PR paragraph states base rule, order and failure behaviour", () => {
    const sec = skill.split("## Faz PR'ı")[1]?.split("\n## ")[0] ?? "";
    expect(sec).toContain("vlad/<çatı-id>");
    expect(sec).toContain("ana branch");
    const order = ["git push", "gh pr create", "vlad task pr", "vlad task report"].map((k) => sec.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sec).toMatch(/PR açılamazsa[\s\S]*çalıştırma[\s\S]*Açık noktalar/);
  });
});
