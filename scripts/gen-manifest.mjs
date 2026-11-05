#!/usr/bin/env node
// One-shot bootstrap of src/commands/manifest.ts from the pre-U1 hand-kept sets (test/commands/fixtures/legacy-classes.json)
// and the real Commander tree (needs `npm run build`). The committed manifest is hand-maintained afterwards; this only documents where it came from.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const leaves = JSON.parse(spawnSync(process.execPath, ["scripts/list-commands.mjs"], { cwd: root, encoding: "utf8" }).stdout).commands;
const L = JSON.parse(readFileSync(resolve(root, "test/commands/fixtures/legacy-classes.json"), "utf8"));
const key = (p) => (p.length === 1 ? `vlad ${p[0]}` : `${p[p.length - 2]} ${p[p.length - 1]}`);
const cat = new Map(L.CONSOLE_CATALOG.map((e) => [e.path.join(" "), e]));
const reasonOf = (p) => {
  const n = p.join(" ");
  if (p[0] === "agent" || p[0] === "machine" || p[0] === "queue") return "yerel makine yönetimi; konsol kataloğundan hariç";
  if (n === "remote") return "konsolun kendi komutu; beyinde yeniden çalıştırılmaz";
  if (n === "install") return "yerel kurulum; konsol kataloğundan hariç";
  if (n === "send" || p[0] === "clip") return "yerel pano/dosya aktarımı; konsol kataloğunda yok";
  return "konsol kataloğunda yoktu (U1 öncesi de); konsolda açmak ayrı karar";
};
const q = (s) => JSON.stringify(s);
const lines = leaves.map(({ path: p, hasJson }) => {
  const k = key(p), o = [];
  if (p.join(" ") === "remote") o.push(`registration: "plain"`);
  if (k === "vlad status") o.push(`exec: "status"`);
  if (L.KB_WRITES.includes(k)) o.push(`lock: ${q(L.INNER_LOCK.includes(k) ? "phased" : "outer")}`);
  if (L.REFRESH_KEYS.includes(k)) o.push(`refresh: true`);
  if (L.WORKER_LOCAL.includes(k)) o.push(`worker: LOCAL`);
  else if (L.FORWARD[k]) o.push(`worker: { kind: "forward", op: ${q(L.FORWARD[k])} }`);
  const e = cat.get(p.join(" "));
  const ff = e?.fileFlags ? `, fileFlags: ${JSON.stringify(e.fileFlags)}` : "";
  o.push(e ? `console: { kind: ${q(e.kind)}${ff} }` : `console: none(${q(reasonOf(p))})`);
  if (!hasJson) o.push(`json: false`);
  return `  c(${JSON.stringify(p)}, { ${o.join(", ")} }),`;
});
process.stdout.write(lines.join("\n") + "\n");
