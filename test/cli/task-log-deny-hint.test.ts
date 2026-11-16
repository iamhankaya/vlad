import { Writable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { buildProgram } from "../../src/cli/program.js";
import type { CliCtx } from "../../src/cli/program.js";
import { createTask } from "../../src/tasks/index.js";
import { denyLogHint } from "../../src/tasks/denials.js";

beforeEach(() => { makeHome(); });

describe("denyLogHint", () => {
  it.each(["İzin reddi: komut x", "sınıflayıcı reddetti", "Permission DENIED for rm", "izin reddi"])("flags %s", (m) => {
    expect(denyLogHint(m)).toContain("vlad task deny");
  });
  it("is silent for ordinary progress lines and for [İZİN] lines written by task deny", () => {
    expect(denyLogHint("kaldığım yer: testler")).toBeNull();
    expect(denyLogHint("[İZİN] Bash: x")).toBeNull();
  });
});

describe("task log writes the hint to stderr only", () => {
  const run = async (msg: string) => {
    const t = createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }, new Date(2026, 9, 15));
    const chunks = { out: "", err: "" };
    const w = (k: "out" | "err") => new Writable({ write(c, _e, cb) { chunks[k] += String(c); cb(); } });
    const ctx: CliCtx = { cliPath: "/x/dist/cli.js", argv: ["node", "vlad", "task", "log", t.data.id, msg], stdout: w("out"), stderr: w("err"), exit: (c) => { throw new Error(`exit ${c}`); }, env: {} };
    await buildProgram(ctx).parseAsync(ctx.argv);
    return chunks;
  };
  it("warns on a denial message but still logs it", async () => {
    const r = await run("İzin reddi: pkill -f x");
    expect(r.err).toContain("izin reddini `vlad task deny` ile kaydet");
    expect(r.out).toContain("eklendi");
  });
  it("stays silent otherwise", async () => {
    expect((await run("kaldığım yer: x")).err).toBe("");
  });
});
