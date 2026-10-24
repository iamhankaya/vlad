import { spawn } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withKbLock } from "../../src/kb/index.js";
import { makeHome } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
let home: string;
beforeEach(() => {
  home = makeHome();
  process.env.VLAD_HOME = home;
});

const lockFile = () => join(home, "kb", ".vlad.lock");

/** A child that appends `count` audit-like lines, each written in two halves with a pause between them. */
const writer = (id: string, count: number, file: string) => new Promise<number>((res, rej) => {
  const code = `
    import { withKbLock } from ${JSON.stringify(new URL(`file://${root}/dist/kb/lock.js`).href)};
    import { appendFileSync } from "node:fs";
    for (let i = 0; i < ${count}; i++) {
      await withKbLock(async () => {
        appendFileSync(${JSON.stringify(file)}, "${id}-" + i + " begin ");
        await new Promise((r) => setTimeout(r, 2));
        appendFileSync(${JSON.stringify(file)}, "end\\n");
      }, { waitMs: 60000 });
    }`;
  const p = spawn("node", ["--input-type=module", "-e", code], { env: { ...process.env, VLAD_HOME: home }, stdio: "inherit" });
  p.on("error", rej);
  p.on("exit", (c) => res(c ?? -1));
});

describe("records: kb lock", () => {
  it("records: 50 concurrent audit-like writes no interleave", async () => {
    const file = join(home, "kb", "audit.log");
    writeFileSync(file, "");
    const codes = await Promise.all([writer("a", 25, file), writer("b", 25, file)]);
    expect(codes).toEqual([0, 0]);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(50);
    for (const l of lines) expect(l).toMatch(/^[ab]-\d+ begin end$/);
    expect(existsSync(lockFile())).toBe(false);
  }, 60_000);

  it("records: 50 concurrent vlad CLI writes serialize", async () => {
    const errs: string[] = [];
    const run = (n: number) => new Promise<number>((res) => {
      // a file, not stdin: readInput's readFileSync(0) hits EAGAIN on a not-yet-filled non-blocking pipe (pre-existing)
      const f = join(home, `in-${n}.md`);
      writeFileSync(f, `yazı ${n}\n`);
      const p = spawn("node", [cli, "journal", "append", "2026-10-24", "--file", f, "--json"], { env: { ...process.env, VLAD_HOME: home } });
      p.stderr.on("data", (d) => errs.push(String(d)));
      p.on("exit", (c) => res(c ?? -1));
    });
    const codes = await Promise.all(Array.from({ length: 50 }, (_, i) => run(i)));
    expect(errs.join("")).toBe("");
    expect(codes.every((c) => c === 0)).toBe(true);
    const text = readFileSync(join(home, "kb", "journal", "2026-10-24.md"), "utf8");
    for (let i = 0; i < 50; i++) expect(text).toContain(`yazı ${i}\n`);
  }, 60_000);

  it("records: stale lock recovered", async () => {
    // dead owner: pid that cannot exist
    writeFileSync(lockFile(), "999999999 x\n");
    expect(await withKbLock(() => "ok", { waitMs: 2000 })).toBe("ok");
    // live owner (this process) but untouched for longer than staleMs
    writeFileSync(lockFile(), `${process.pid} x\n`);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockFile(), old, old);
    expect(await withKbLock(() => "ok2", { waitMs: 2000, staleMs: 60_000 })).toBe("ok2");
    expect(existsSync(lockFile())).toBe(false);
  });

  it("records: lock wait timeout error kb-meşgul", async () => {
    writeFileSync(lockFile(), `${process.pid} x\n`); // live owner, fresh mtime
    // generous staleMs so the lock stays fresh however slow the machine is; waitMs is the only clock
    await expect(withKbLock(() => "no", { waitMs: 150, staleMs: 600_000 })).rejects.toThrow(/^kb meşgul/);
    expect(readFileSync(lockFile(), "utf8")).toBe(`${process.pid} x\n`); // foreign lock left alone
  });

  it("records: lock released when fn throws, and nested call re-enters", async () => {
    await expect(withKbLock(() => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(existsSync(lockFile())).toBe(false);
    expect(await withKbLock(async () => withKbLock(() => 7))).toBe(7);
    expect(existsSync(lockFile())).toBe(false);
  });

  it("records: write command fails with kb meşgul on a held lock, json error", () => new Promise<void>((done, rej) => {
    writeFileSync(lockFile(), `${process.pid} x\n`);
    let err = "";
    const p = spawn("node", [cli, "journal", "append", "2026-10-24", "--file", "-", "--json"], {
      env: { ...process.env, VLAD_HOME: home, VLAD_LOCK_WAIT_MS: "100", VLAD_LOCK_STALE_MS: "600000" },
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (c) => {
      try {
        expect(c).toBe(1);
        expect(JSON.parse(err).error).toMatch(/^kb meşgul/);
        done();
      } catch (e) { rej(e); }
    });
    p.stdin.end("x\n");
  }));
});
