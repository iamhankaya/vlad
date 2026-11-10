import { describe, expect, it } from "vitest";
import { CONSOLE_CATALOG, validateConsoleArgv } from "../../src/agent/console-catalog.js";

const bad = (argv: string[], stdin?: string) => {
  try { validateConsoleArgv(argv, stdin); } catch (e) { return e as Error & { code: string }; }
  throw new Error("kabul edildi: " + JSON.stringify(argv));
};

describe("machines:B console catalog", () => {
  it("matches the longest command path and reports read/write", () => {
    expect(validateConsoleArgv(["task", "list", "--json"]).entry).toMatchObject({ path: ["task", "list"], kind: "read" });
    expect(validateConsoleArgv(["task", "log", "T20261101-24", "merhaba"]).entry).toMatchObject({ path: ["task", "log"], kind: "write" });
    expect(validateConsoleArgv(["kb", "maintain", "--dry-run"]).entry.kind).toBe("write");
  });
  it("digest pending list/add/done and kb refs are catalogued with the right class", () => {
    expect(validateConsoleArgv(["digest", "pending", "list", "--json"]).entry).toMatchObject({ path: ["digest", "pending", "list"], kind: "read" });
    expect(validateConsoleArgv(["digest", "pending", "add", "--text", "x"]).entry).toMatchObject({ path: ["digest", "pending", "add"], kind: "write" });
    expect(validateConsoleArgv(["digest", "pending", "done", "P-1"]).entry).toMatchObject({ path: ["digest", "pending", "done"], kind: "write" });
    expect(validateConsoleArgv(["kb", "refs", "F-vlad-001", "--json"]).entry).toMatchObject({ path: ["kb", "refs"], kind: "read" });
  });
  it("status is a read (no journal) even though it may mark stalled", () => {
    expect(validateConsoleArgv(["status", "--no-mark", "--json"]).entry.kind).toBe("read");
  });
  it("rejects commands outside the catalog: agent, machine, queue, remote, install and unknown", () => {
    for (const a of [["agent", "keygen", "x"], ["agent", "start"], ["machine", "list"], ["queue", "drop", "1"], ["remote", "--", "task", "list"], ["install"], ["rm", "-rf", "/"], ["--version"], []]) {
      const e = bad(a);
      expect(e.code, a.join(" ")).toBe("forbidden");
      expect(e.message).toMatch(/^forbidden: komut konsoldan çalıştırılamaz: /);
    }
  });
  it("a group alone is not a command (task, kb)", () => {
    expect(bad(["task"]).code).toBe("forbidden");
    expect(bad(["kb"]).code).toBe("forbidden");
  });
  it("file flags only take `-` (content comes through stdin); path and --flag=value forms are refused", () => {
    expect(validateConsoleArgv(["task", "report", "T20261101-24", "--file", "-"], "# rapor").entry.path).toEqual(["task", "report"]);
    expect(bad(["task", "report", "T1", "--file", "C:\\Windows\\win.ini"], "x").code).toBe("forbidden");
    expect(bad(["task", "report", "T1", "--file=-"], "x").code).toBe("forbidden");
    expect(bad(["task", "report", "T1", "--file=/etc/passwd"], "x").code).toBe("forbidden");
    expect(bad(["decision", "add", "--body-file", "../x"], "x").code).toBe("forbidden");
    expect(bad(["task", "ingest", "--events-file", "/tmp/e"]).code).toBe("forbidden");
    expect(bad(["finding", "add", "--detail-file"]).code).toBe("forbidden"); // değersiz bayrak
    expect(bad(["task", "new", "--pipeline", "--phase-body", "uygulama=/etc/passwd"]).code).toBe("forbidden"); // brain dosyası okutulamaz
  });
  it("`-` as a file flag value needs stdin", () => {
    expect(bad(["task", "report", "T1", "--file", "-"]).code).toBe("bad_request");
  });
  it("size and NUL limits: arg ≤ 64 KiB, total ≤ 1 MiB, no NUL", () => {
    expect(bad(["task", "log", "T1", "a\0b"]).code).toBe("bad_request");
    expect(bad(["task", "log", "T1", "x".repeat(64 * 1024 + 1)]).code).toBe("bad_request");
    const many = Array.from({ length: 20 }, () => "y".repeat(60 * 1024));
    expect(bad(["task", "log", "T1", ...many]).code).toBe("bad_request");
    expect(() => validateConsoleArgv(["task", "log", "T1", "x".repeat(64 * 1024)])).not.toThrow();
    expect(bad(["task", "report", "T1", "--file", "-"], "a\0b").code).toBe("bad_request");
  });
  it("injection-looking text is plain data (no shell is ever involved)", () => {
    for (const t of ["; rm -rf /", "$(whoami)", "`id`", "--", "a\nb", "ǂ‐‐file", "x && y"]) expect(() => validateConsoleArgv(["task", "ask", "T1", t])).not.toThrow();
  });
  it("kb lint (read) and project refresh (write) are in the catalog (F-vlad-183)", () => {
    expect(validateConsoleArgv(["kb", "lint", "--json"]).entry.kind).toBe("read");
    expect(validateConsoleArgv(["project", "refresh", "alpha"]).entry.kind).toBe("write");
  });
  it("catalog has unique paths and no excluded group", () => {
    const keys = CONSOLE_CATALOG.map((e) => e.path.join(" "));
    expect(new Set(keys).size).toBe(keys.length);
    for (const g of ["agent", "machine", "queue", "remote", "install"]) expect(keys.some((k) => k === g || k.startsWith(g + " "))).toBe(false);
  });
});
