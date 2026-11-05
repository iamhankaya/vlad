#!/usr/bin/env node
// Prints the leaf commands of the real Commander tree as JSON (needs `npm run build`). The expected inventory is derived from code, never typed by hand.
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const programJs = resolve(root, "dist/cli/program.js");
if (!existsSync(programJs)) { process.stderr.write("dist yok: önce npm run build\n"); process.exit(1); }
const { buildProgram } = await import(pathToFileURL(programJs).href);
const sink = { write: () => true };
const program = buildProgram({ cliPath: resolve(root, "dist/cli.js"), argv: ["node", "vlad"], stdout: sink, stderr: sink, exit: (c) => { throw new Error(`exit ${c}`); }, env: {} });

const commands = [];
const walk = (cmd, path) => {
  for (const c of cmd.commands) {
    const p = [...path, c.name()];
    if (c.commands.length) walk(c, p);
    else commands.push({ path: p, hasJson: c.options.some((o) => o.long === "--json") });
  }
};
walk(program, []);
process.stdout.write(JSON.stringify({ version: 1, commands }) + "\n");
