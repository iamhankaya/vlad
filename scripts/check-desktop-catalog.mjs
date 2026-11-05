#!/usr/bin/env node
// Checks the vlad-desktop command catalog exported from the built manifest against the committed snapshot
// (test/golden/desktop-catalog.json; `--snapshot <file>` overrides). `--write` regenerates the snapshot instead (a new command updates it in the same commit).
// Additive contract: every field of the snapshot must still be present with the same value; new commands/fields only show up as a diff.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const snapIdx = args.indexOf("--snapshot");
const snapFile = snapIdx >= 0 ? resolve(args[snapIdx + 1]) : resolve(root, "test/golden/desktop-catalog.json");
const mod = resolve(root, "dist/commands/export.js");
if (!existsSync(mod)) { process.stderr.write("dist yok: önce npm run build\n"); process.exit(1); }
const { exportCatalog } = await import(pathToFileURL(mod).href);
const now = exportCatalog();

if (args.includes("--write")) {
  mkdirSync(dirname(snapFile), { recursive: true });
  writeFileSync(snapFile, JSON.stringify(now, null, 1) + "\n");
  process.stdout.write(`yazıldı: ${snapFile} (${now.commands.length} komut)\n`);
  process.exit(0);
}

let snap;
try { snap = JSON.parse(readFileSync(snapFile, "utf8")); } catch (e) { process.stderr.write(`snapshot okunamadı: ${snapFile}: ${e.message}\n`); process.exit(1); }
const errors = [];
if (snap.version !== now.version) errors.push(`version ${snap.version} → ${now.version}`);
if (!Array.isArray(snap.commands)) errors.push("snapshot.commands dizi değil");
else {
  const cur = new Map(now.commands.map((c) => [c.path.join(" "), c]));
  for (const c of snap.commands) {
    const n = cur.get(c.path.join(" "));
    if (!n) { errors.push(`komut kalktı: ${c.path.join(" ")}`); continue; }
    for (const [k, v] of Object.entries(c)) if (!isDeepStrictEqual(n[k], v)) errors.push(`${c.path.join(" ")}: ${k} değişti`);
  }
  if (snap.commands.length !== now.commands.length) errors.push(`komut sayısı ${snap.commands.length} → ${now.commands.length} (snapshot'ı --write ile güncelle)`);
}
if (errors.length) { process.stderr.write(errors.join("\n") + "\n"); process.exit(1); }
process.stdout.write(`desktop kataloğu tamam (${now.commands.length} komut)\n`);
