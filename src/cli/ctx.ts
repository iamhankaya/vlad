import { Command, CommanderError } from "commander";
import { join } from "node:path";
import { ValidationError } from "../kb/index.js";
import { exitCodeFor, remoteErrorDetails } from "../machines/exit.js";
import { TRANSITIONS, TransitionError } from "../tasks/index.js";

export interface Opts { json?: boolean; [k: string]: unknown }

export interface CliCtx {
  /** Absolute path of the running CLI module (dist/cli.js); sendMenuActions installs it as the menu command. */
  cliPath: string;
  /** Full argv (node, script, args…): parsed, and `argv[1]` is what `agent install` registers (symlinked bin path, unlike cliPath). */
  argv: readonly string[];
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  exit: (code: number) => never;
  env: NodeJS.ProcessEnv;
}

export function failWith(ctx: CliCtx, e: unknown): never {
  let error = e instanceof Error ? e.message : String(e);
  let details: string[] = [];
  if (e instanceof ValidationError) details = e.details;
  else if (e instanceof TransitionError) details = [`izin verilenler: ${TRANSITIONS[e.from].join(", ") || "(yok)"}`];
  else details = remoteErrorDetails(e);
  if (ctx.argv.includes("--json")) ctx.stderr.write(JSON.stringify({ error, details }) + "\n");
  else {
    error = `hata: ${error}`;
    ctx.stderr.write([error, ...details.map((d) => `  ${d}`)].join("\n") + "\n");
  }
  return ctx.exit(exitCodeFor(e));
}

export const helpOf = new WeakMap<Command, () => string>();
/** What commander wrote to stderr before throwing `commander.help` (bare group without subcommand). */
export const pendingHelpOf = (program: Command): string => helpOf.get(program)?.() ?? "";

/** Maps a parseAsync rejection to the exit behavior the CLI always had. */
export function handleParseError(program: Command, ctx: CliCtx, e: unknown): never {
  if (e instanceof CommanderError) {
    if (e.exitCode === 0) return ctx.exit(0); // --help / --version
    if (e.code === "commander.help" || e.code === "commander.helpDisplayed") {
      ctx.stderr.write(pendingHelpOf(program)); // bare group without subcommand
      return ctx.exit(1);
    }
    return failWith(ctx, new Error(e.message.replace(/^error: /, "")));
  }
  return failWith(ctx, e);
}
