import { Writable } from "node:stream";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProgram, failWith, handleParseError, pendingHelpOf } from "../../src/cli/program.js";
import type { CliCtx } from "../../src/cli/program.js";
import { cliPathFromUrl } from "../../src/cli/cli-path.js";

class Exit extends Error { constructor(public code: number) { super(`exit ${code}`); } }
function sink() {
  const chunks: string[] = [];
  const w = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  return { w, text: () => chunks.join("") };
}
function ctxOf(argv: string[]) {
  const out = sink(), err = sink();
  const ctx: CliCtx = { cliPath: "/x/dist/cli.js", argv: ["node", "vlad", ...argv], stdout: out.w, stderr: err.w, exit: (c) => { throw new Exit(c); }, env: {} };
  return { ctx, out, err };
}

describe("s-program: buildProgram", () => {
  it("parses nothing and builds independent trees", () => {
    const a = ctxOf([]), b = ctxOf([]);
    const p1 = buildProgram(a.ctx), p2 = buildProgram(b.ctx);
    expect(p1).not.toBe(p2);
    expect(p1.commands.map((c) => c.name())).toContain("task");
    expect(a.out.text() + a.err.text()).toBe("");
  });
  it("keeps pending help per program (no shared module state)", async () => {
    const a = ctxOf(["task"]), b = ctxOf(["project"]);
    const p1 = buildProgram(a.ctx), p2 = buildProgram(b.ctx);
    await expect(p1.parseAsync(a.ctx.argv)).rejects.toBeTruthy();
    expect(pendingHelpOf(p1)).toMatch(/Usage: vlad task/);
    expect(pendingHelpOf(p2)).toBe("");
  });
  it("handleParseError: bare group prints its help to ctx.stderr and exits 1", async () => {
    const { ctx, err } = ctxOf(["task"]);
    const p = buildProgram(ctx);
    const e = await p.parseAsync(ctx.argv).catch((x) => x);
    expect(() => handleParseError(p, ctx, e)).toThrow(new Exit(1));
    expect(err.text()).toMatch(/Usage: vlad task/);
  });
  it("failWith writes JSON errors to ctx.stderr under --json and exits via ctx.exit", () => {
    const { ctx, err } = ctxOf(["scan", "--json"]);
    expect(() => failWith(ctx, new Error("boom"))).toThrow(Exit);
    expect(JSON.parse(err.text())).toEqual({ error: "boom", details: [] });
  });
  it("failWith plain text prefix", () => {
    const { ctx, err } = ctxOf(["scan"]);
    expect(() => failWith(ctx, new Error("boom"))).toThrow(Exit);
    expect(err.text()).toBe("hata: boom\n");
  });
});

describe("s-program: cliPathFromUrl (Windows forms)", () => {
  it("converts file URLs on windows", () => {
    expect(cliPathFromUrl("file:///C:/dev/vlad/dist/cli.js", true)).toBe("C:\\dev\\vlad\\dist\\cli.js");
    expect(cliPathFromUrl("file://server/share/vlad/dist/cli.js", true)).toBe("\\\\server\\share\\vlad\\dist\\cli.js");
  });
  it("converts file URLs on posix", () => {
    expect(cliPathFromUrl("file:///opt/vlad/dist/cli.js", false)).toBe("/opt/vlad/dist/cli.js");
  });
});

describe("s-program: dynamic import targets exist", () => {
  const root = resolve(import.meta.dirname, "../../src");
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
  it("every relative import(\"…\") in src resolves to a source file", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const f of walk(root)) {
      for (const m of readFileSync(f, "utf8").matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g)) {
        seen++;
        const t = resolve(dirname(f), m[1]!).replace(/\.js$/, ".ts");
        if (!existsSync(t)) missing.push(`${f.slice(root.length + 1)} → ${m[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(missing).toEqual([]);
  });
});
