#!/usr/bin/env node
// agent-scripts/manifest.json içindeki sha256'ları dosya baytlarından yeniden hesaplar.
//   node scripts/agent-scripts-sha.mjs           -> farkları yazar, fark varsa çıkış 1
//   node scripts/agent-scripts-sha.mjs --write   -> manifesti günceller
// Betik değişince manifest satırı da değişmeli (incelemede görünür); test/machines/script-registry.test.ts aynı denetimi yapar.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const mf = resolve(root, "agent-scripts/manifest.json");
const m = JSON.parse(readFileSync(mf, "utf8"));
let diff = 0;
for (const e of m.scripts) {
  const sha = createHash("sha256").update(readFileSync(resolve(root, e.file))).digest("hex");
  if (sha !== e.sha256) { diff++; console.log(`${e.name}/${e.platform}: ${e.sha256.slice(0, 12)} -> ${sha.slice(0, 12)}`); e.sha256 = sha; }
}
if (process.argv.includes("--write")) { if (diff) writeFileSync(mf, JSON.stringify(m, null, 2) + "\n"); console.log(diff ? `${diff} giriş güncellendi` : "güncel"); }
else if (diff) { console.error(`${diff} giriş eski; --write ile güncelle`); process.exit(1); }
else console.log("güncel");
