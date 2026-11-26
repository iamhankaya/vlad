import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildProgram, handleParseError } from "../../src/cli/program.js";
import type { CliCtx } from "../../src/cli/program.js";
import { GROUP_OF, programFor } from "../../src/cli/lazy.js";

// T20261126-25: `node dist/cli.js <komut>` loads only that command's group module; the tree it builds must behave like the full one
class Exit extends Error { constructor(public code: number) { super(`exit ${code}`); } }
const sink = () => {
  const chunks: string[] = [];
  return { w: new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }), text: () => chunks.join("") };
};
async function run(args: string[], build: (ctx: CliCtx) => Promise<ReturnType<typeof buildProgram>>) {
  const out = sink(), err = sink();
  const ctx: CliCtx = { cliPath: "/x/dist/cli.js", argv: ["node", "vlad", ...args], stdout: out.w, stderr: err.w, exit: (c) => { throw new Exit(c); }, env: {} };
  const p = await build(ctx);
  let code = 0;
  try { await p.parseAsync(ctx.argv); } catch (e) {
    try { handleParseError(p, ctx, e); } catch (x) { if (x instanceof Exit) code = x.code; else throw x; }
  }
  return { code, out: out.text(), err: err.text() };
}
const full = async (ctx: CliCtx) => buildProgram(ctx);
const lazy = (ctx: CliCtx) => programFor(ctx);

describe("tembel komut grubu yükleme", () => {
  it("her üst düzey komutun grubu bilinir, fazlası yok", () => {
    const names = buildProgram({ cliPath: "x", argv: [], stdout: sink().w, stderr: sink().w, exit: () => { throw new Exit(0); }, env: {} }).commands.map((c) => c.name());
    expect(Object.keys(GROUP_OF).sort()).toEqual([...names].sort());
  });

  it("bir grup yüklendiğinde kendi komutlarının hepsi tam ağaçtakiyle aynı", async () => {
    const fullTree = buildProgram({ cliPath: "x", argv: [], stdout: sink().w, stderr: sink().w, exit: () => { throw new Exit(0); }, env: {} });
    for (const name of Object.keys(GROUP_OF)) {
      const out = sink();
      const p = await programFor({ cliPath: "x", argv: ["node", "vlad", name], stdout: out.w, stderr: out.w, exit: () => { throw new Exit(0); }, env: {} });
      const got = p.commands.find((c) => c.name() === name)!;
      const want = fullTree.commands.find((c) => c.name() === name)!;
      expect(got, name).toBeDefined();
      expect(got.helpInformation(), name).toBe(want.helpInformation());
      expect(got.commands.map((c) => c.helpInformation()), name).toEqual(want.commands.map((c) => c.helpInformation()));
    }
  });

  it("yardım, bilinmeyen komut ve seçenekle başlayan argv tam ağacı kurar", async () => {
    const ctxOf = (args: string[]): CliCtx => ({ cliPath: "x", argv: ["node", "vlad", ...args], stdout: sink().w, stderr: sink().w, exit: () => { throw new Exit(0); }, env: {} });
    const n = buildProgram(ctxOf([])).commands.length;
    for (const args of [[], ["--help"], ["help", "task"], ["tsak"], ["--json", "status"], ["__proto__"], ["constructor"]]) {
      expect((await programFor(ctxOf(args))).commands.length, args.join(" ")).toBe(n);
    }
    expect((await programFor(ctxOf(["task", "list"]))).commands.map((c) => c.name())).toEqual(["task"]);
    expect((await programFor(ctxOf(["scan"]))).commands.map((c) => c.name()).sort()).toEqual(["project", "scan"]);
  });

  it("çıktı ve çıkış kodu tam ağaçla aynı", async () => {
    for (const args of [["task"], ["task", "--help"], ["task", "list", "--help"], ["task", "bogus"], ["kb", "search"], ["status", "--bogus"], ["tsak"], ["--help"], []]) {
      const a = await run(args, full), b = await run(args, lazy);
      expect(b, args.join(" ")).toEqual(a);
    }
  });
});
