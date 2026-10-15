import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { validate } from "../../src/kb/index.js";
import { buildReport, main } from "../../src/hooks/session-report.js";
import { makeHome } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });

const line = (role: string, text: string) =>
  JSON.stringify({ type: role, message: { role, content: role === "user" ? text : [{ type: "text", text }] } });

function run(transcript: string, over: Record<string, unknown> = {}) {
  const deps = {
    readFile: () => transcript,
    git: () => null,
    projects: [],
    vladHome: home,
    env: {} as Record<string, string | undefined>,
    now: new Date("2026-10-15T18:10:00Z"),
    ...over,
  };
  return buildReport({ session_id: "s1", transcript_path: "t.jsonl", cwd: "C:\\x" }, deps as any);
}

const two = [line("user", "a"), line("user", "b")].join("\n");

describe("buildReport", () => {
  it("returns null with fewer than 2 user messages", () => {
    expect(run(line("user", "tek"))).toBeNull();
  });
  it("truncates messages to 1000 chars", () => {
    const r = run([line("user", "a".repeat(2000)), line("user", "b")].join("\n"))!;
    expect(r.excerpt[0].text).toHaveLength(1000);
  });
  it("keeps last 6 messages", () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) { lines.push(line("user", `u${i}`)); lines.push(line("assistant", `a${i}`)); }
    const r = run(lines.join("\n"))!;
    expect(r.excerpt).toHaveLength(6);
    expect(r.excerpt[5].text).toBe("a4");
    expect(r.user_message_count).toBe(5);
  });
  it("fills task_id from env", () => {
    const r = run(two, { env: { VLAD_TASK_ID: "T20261015-01" } })!;
    expect(r.task_id).toBe("T20261015-01");
  });
  it("git failures yield empty git block that passes schema", () => {
    const r = run(two)!;
    expect(r.git).toEqual({ branch: null, head: null, recent_commits: [], changed_files: [] });
    expect(() => validate("inbox", r)).not.toThrow();
  });
  it("parses git output", () => {
    const git = (_c: string, a: string[]) => {
      if (a[0] === "rev-parse" && a.includes("--abbrev-ref")) return "main\n";
      if (a[0] === "rev-parse") return "abc1234\n";
      if (a[0] === "log") return "abc1234\tfeat: x\t2026-10-15T20:00:00+03:00\n";
      if (a[0] === "status") return " M src/a.ts\n?? b.txt\n";
      return null;
    };
    const r = run(two, { git })!;
    expect(r.git).toEqual({
      branch: "main", head: "abc1234",
      recent_commits: [{ sha: "abc1234", subject: "feat: x", date: "2026-10-15T20:00:00+03:00" }],
      changed_files: ["src/a.ts", "b.txt"],
    });
    expect(() => validate("inbox", r)).not.toThrow();
  });
});

describe("main", () => {
  it("logs invalid stdin, writes nothing, exitCode 0", async () => {
    process.exitCode = undefined;
    await main("not json");
    expect(readdirSync(join(home, "kb", "inbox")).filter((f) => f.endsWith(".json"))).toEqual([]);
    const logs = readdirSync(join(home, "kb", "logs"));
    expect(logs).toHaveLength(1);
    expect(readFileSync(join(home, "kb", "logs", logs[0]), "utf8").length).toBeGreaterThan(0);
    expect(process.exitCode).toBe(0);
  });
  it("writes inbox file for a valid session", async () => {
    const tp = join(home, "t.jsonl");
    writeFileSync(tp, two);
    await main(JSON.stringify({ session_id: "sess9", transcript_path: tp, cwd: home, reason: "exit" }));
    const files = readdirSync(join(home, "kb", "inbox")).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{8}T\d{6}-sess9\.json$/);
    const rec = JSON.parse(readFileSync(join(home, "kb", "inbox", files[0]), "utf8"));
    expect(rec.project).toBe("vlad");
  });
});
