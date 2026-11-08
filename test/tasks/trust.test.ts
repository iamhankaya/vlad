import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeJsonPath, trustKey, trustRecorded, trustWorktree, verifyTrustAfterLaunch, untrustWorktree } from "../../src/tasks/trust.js";

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

describe("F-vlad-202: eşzamanlı yazım güven kaydını kaybetmez", () => {
  it("birden çok süreç aynı anda farklı worktree'leri güvenilir yapınca hepsi kayıtlı kalır", async () => {
    const { spawn } = await import("node:child_process");
    writeFileSync(file, JSON.stringify({ numStartups: 3, projects: {} }));
    const mod = join(process.cwd(), "dist", "tasks", "trust.js");
    const n = 10;
    const run = (i: number) => new Promise<number | null>((res) => {
      const c = spawn(process.execPath, ["--input-type=module", "-e",
        `const m = await import(${JSON.stringify("file://" + mod)}); for (let k = 0; k < 15; k++) { const w = m.trustWorktree("/wt/p${i}-" + k, process.argv[1]); if (w) { console.error(w); process.exit(3); } }`, file],
      { stdio: "inherit" });
      c.on("exit", res);
    });
    const codes = await Promise.all(Array.from({ length: n }, (_, i) => run(i)));
    expect(codes).toEqual(Array(n).fill(0));
    const j = read();
    expect(j.numStartups).toBe(3);
    expect(Object.keys(j.projects)).toHaveLength(n * 15);
  }, 60_000);

  it("tutulan taze kilit varken yazmaz, uyarı döner; bayat kilit kırılır", async () => {
    const { mkdirSync, utimesSync } = await import("node:fs");
    writeFileSync(file, JSON.stringify({ projects: {} }));
    mkdirSync(`${file}.vlad-lock`);
    const w = trustWorktree("/wt/a", file, { lockWaitMs: 100 });
    expect(w).toMatch(/kilit/);
    expect(read().projects).toEqual({});
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.vlad-lock`, old, old);
    expect(trustWorktree("/wt/a", file, { lockWaitMs: 100 })).toBeNull();
    expect(read().projects["/wt/a"].hasTrustDialogAccepted).toBe(true);
    expect(existsSync(`${file}.vlad-lock`)).toBe(false);
  });
});

describe("trustRecorded (F-vlad-261)", () => {
  it("is true only while the record exists; a live Claude rewriting the file from memory drops it", () => {
    expect(trustRecorded("/wt/a", file)).toBe(false); // no file
    trustWorktree("/wt/a", file);
    expect(trustRecorded("/wt/a", file)).toBe(true);
    writeFileSync(file, JSON.stringify({ projects: {} })); // another process rewrote ~/.claude.json from a stale copy
    expect(trustRecorded("/wt/a", file)).toBe(false);
    writeFileSync(file, "{broken");
    expect(trustRecorded("/wt/a", file)).toBe(false);
  });
});

describe("verifyTrustAfterLaunch (F-vlad-261)", () => {
  it("is silent when the record stands, repairs a dropped one, warns when it cannot be kept", () => {
    trustWorktree("/wt/a", file);
    expect(verifyTrustAfterLaunch("/wt/a", file)).toBeNull();
    writeFileSync(file, JSON.stringify({ projects: {} }));
    expect(verifyTrustAfterLaunch("/wt/a", file)).toBeNull();
    expect(trustRecorded("/wt/a", file)).toBe(true);
    writeFileSync(file, "{broken");
    expect(verifyTrustAfterLaunch("/wt/a", file)).toMatch(/güven kaydı/);
  });
});
