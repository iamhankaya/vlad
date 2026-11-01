import { RemoteError, type ExecResult } from "../../machines/types.js";
import { consoleExecTimeoutMs, validateConsoleArgv } from "../console-catalog.js";
import { runCli } from "./run-cli.js";

interface ExecArgs { argv: string[]; stdin?: string; json?: boolean }
function parse(a: unknown): ExecArgs {
  const x = a as Partial<ExecArgs> | null;
  if (!x || !Array.isArray(x.argv)) throw new RemoteError("bad_request", "bad_request: argv dizisi gerekli");
  if (x.stdin !== undefined && typeof x.stdin !== "string") throw new RemoteError("bad_request", "bad_request: stdin string olmalı");
  return x as ExecArgs;
}

/** Yazma `exec`'leri günlüğe girer (aynı opId tekrarı ilk sonucu döner); okumalar girmez. Geçersiz argv burada değil exec'te reddedilir. */
export function execIsWrite(args: unknown): boolean {
  try { const x = parse(args); return validateConsoleArgv(x.argv, x.stdin).entry.kind === "write"; } catch { return false; }
}

/** konsol → beyin: katalog izin listesi; alt süreç `VLAD_FORWARDED=console:<ad>`. */
export async function exec(args: unknown, ctx: { from: string; opId: string }): Promise<ExecResult> {
  const x = parse(args);
  validateConsoleArgv(x.argv, x.stdin);
  const argv = x.json && !x.argv.includes("--json") ? [...x.argv, "--json"] : x.argv;
  return runCli(argv, { stdin: x.stdin, forwarded: `console:${ctx.from}`, opId: ctx.opId, timeoutMs: consoleExecTimeoutMs(argv) });
}
