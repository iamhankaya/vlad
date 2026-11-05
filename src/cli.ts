#!/usr/bin/env node
import { cliPathFromUrl } from "./cli/cli-path.js";
import { buildProgram, handleParseError } from "./cli/program.js";
import type { CliCtx } from "./cli/program.js";
import { swallowEpipe } from "./stdout.js";

swallowEpipe(process.stdout);
swallowEpipe(process.stderr);

const ctx: CliCtx = {
  cliPath: cliPathFromUrl(import.meta.url),
  argv: process.argv,
  stdout: process.stdout,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
  env: process.env,
};
const program = buildProgram(ctx);
try {
  await program.parseAsync(ctx.argv);
} catch (e) {
  handleParseError(program, ctx, e);
}
