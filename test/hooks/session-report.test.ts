import { copyFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { validate } from "../../src/kb/index.js";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { buildReport, main, readStdin } from "../../src/hooks/report.js";
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

describe("git deadline", () => {
  it("skips remaining git calls after the first timeout", () => {
    let t = 0;
    const calls: string[][] = [];
    const git = (_c: string, a: string[]) => { calls.push(a); t += 3500; return null; };
    const r = run(two, { git, clock: () => t })!;
    expect(calls).toHaveLength(1);
    expect(r.git).toEqual({ branch: null, head: null, recent_commits: [], changed_files: [] });
  });
  it("skips calls once the shared deadline has passed", () => {
    let t = 0;
    const calls: string[][] = [];
    const git = (_c: string, a: string[]) => { calls.push(a); t += 2500; return "x"; };
    run(two, { git, clock: () => t });
    expect(calls).toHaveLength(2);
  });
});

describe("stdin", () => {
  it("times out on a stream that never ends", async () => {
    const s = new PassThrough();
    await expect(readStdin(s, 50)).rejects.toThrow(/zaman aşımı/);
  });
  it("main logs a stdin timeout and exits 0", async () => {
    process.exitCode = undefined;
    const s = new PassThrough();
    await main(undefined, s);
    expect(readdirSync(join(home, "kb", "logs"))).toHaveLength(1);
    expect(process.exitCode).toBe(0);
  }, 10000);
});

describe("entry process", () => {
  const out = resolve(import.meta.dirname, "..", "..", "dist");
  beforeAll(() => {
    const r = spawnSync("npx", ["tsc"], { cwd: resolve(out, ".."), shell: true, encoding: "utf8" });
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }, 120000);
  afterAll(() => {});
  it("exits 0 on invalid stdin and logs", () => {
    const r = spawnSync("node", [join(out, "hooks", "session-report.js")], {
      input: "not json", encoding: "utf8", env: { ...process.env, VLAD_HOME: home },
    });
    expect(r.status).toBe(0);
    expect(readdirSync(join(home, "kb", "logs"))).toHaveLength(1);
  });
  it("exits 0 even when the implementation module fails to load", () => {
    const d = mkdtempSync(join(tmpdir(), "vlad-entry-"));
    copyFileSync(join(out, "hooks", "session-report.js"), join(d, "session-report.js"));
    writeFileSync(join(d, "report.js"), "import \"./does-not-exist.js\";");
    writeFileSync(join(d, "package.json"), '{"type":"module"}');
    const r = spawnSync("node", [join(d, "session-report.js")], {
      input: "x", encoding: "utf8", env: { ...process.env, VLAD_HOME: home },
    });
    expect(r.status).toBe(0);
    expect(readdirSync(join(home, "kb", "logs"))).toHaveLength(1);
  });
});
