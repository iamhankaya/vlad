import { Writable } from "node:stream";
import { isolatedEnv } from "../isolate-env.js";
import { buildProgram, handleParseError } from "../../src/cli/program.js";
import type { CliCtx } from "../../src/cli/program.js";

export interface CliRun { code: number; out: string; err: string }

class ExitSignal extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }

const sink = () => {
  const chunks: string[] = [];
  return { w: new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }), text: () => chunks.join("") };
};

/**
 * Runs the vlad CLI inside the test process (F-vlad-071): same command tree as `node dist/cli.js`, no child process,
 * so no per-call node start-up and no dist dependency. Output goes to captured sinks and `exit` becomes the returned code.
 * `env` is applied to process.env for the duration of the call only (the product reads VLAD_HOME & co. from there) and then
 * restored; calls must therefore not overlap (tests in one file run sequentially). Commands that read stdin (`--file -`) need
 * the child-process path (`spawnVlad`): `input` is rejected here instead of silently hanging.
 */
export async function runCli(args: string[], o: { env?: Record<string, string>; input?: string } = {}): Promise<CliRun> {
  if (o.input !== undefined) throw new Error("runCli: stdin is not supported, use spawnVlad for commands that read it");
  const out = sink(), err = sink();
  const env = { ...isolatedEnv(), ...o.env };
  const ctx: CliCtx = { cliPath: "vlad", argv: ["node", "vlad", ...args], stdout: out.w, stderr: err.w, exit: (c) => { throw new ExitSignal(c); }, env };
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(o.env ?? {})) { saved.set(k, process.env[k]); process.env[k] = v; }
  let code = 0;
  try {
    const program = buildProgram(ctx);
    try { await program.parseAsync(ctx.argv); } catch (e) { if (e instanceof ExitSignal) throw e; handleParseError(program, ctx, e); } // process.exit would have ended the run before handleParseError
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code;
    else throw e;
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { code, out: out.text(), err: err.text() };
}
