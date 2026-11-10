#!/usr/bin/env node
// Regenerates docs/commands.md from the built manifest + descriptions (needs `npm run build`). `--check` only verifies the file is up to date.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const mod = resolve(root, "dist/commands/docs.js");
if (!existsSync(mod)) { process.stderr.write("dist yok: önce npm run build\n"); process.exit(1); }
const { renderCommandsDoc, validateDocs } = await import(pathToFileURL(mod).href);
const errors = validateDocs();
if (errors.length) { process.stderr.write(errors.join("\n") + "\n"); process.exit(1); }
const file = resolve(root, "docs/commands.md");
const text = renderCommandsDoc();
if (process.argv.includes("--check")) {
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cur !== text) { process.stderr.write("docs/commands.md eski: npm run build && npm run docs:commands\n"); process.exit(1); }
  process.exit(0);
}
writeFileSync(file, text);
process.stdout.write(`yazıldı: docs/commands.md\n`);
