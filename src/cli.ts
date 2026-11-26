#!/usr/bin/env node
import { cliPathFromUrl } from "./cli/cli-path.js";
import { handleParseError } from "./cli/ctx.js";
import type { CliCtx } from "./cli/ctx.js";
import { programFor } from "./cli/lazy.js";
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
const program = await programFor(ctx); // only the named command's group module (T20261126-25)
try {
  await program.parseAsync(ctx.argv);
} catch (e) {
  handleParseError(program, ctx, e);
}
