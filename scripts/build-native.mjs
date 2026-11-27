#!/usr/bin/env node
// D-vlad-093: Rust push-guard kancasını derler ve dist/hooks/push-guard'a kopyalar (TS kancasının yanına; ikili
// <home>/dist/hooks/ konumundan VLAD kökünü çözer). `npm run build` bunu ÇALIŞTIRMAZ; devreye alma ayrı onaylıdır.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "native", "push-guard");
const exe = process.platform === "win32" ? "push-guard.exe" : "push-guard";

const r = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: crate, stdio: "inherit" });
if (r.error) {
  console.error(`cargo çalıştırılamadı: ${r.error.message} (Rust kurulu mu? https://rustup.rs)`);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);

const src = join(crate, "target", "release", exe);
if (!existsSync(src)) {
  console.error(`derleme çıktısı yok: ${src}`);
  process.exit(1);
}
const outDir = join(root, "dist", "hooks");
mkdirSync(outDir, { recursive: true });
// yerinde üzerine yazma çalışan kanca sürecini bozmasın: geçici ad + rename
const tmp = join(outDir, `.${exe}.${process.pid}`);
copyFileSync(src, tmp);
chmodSync(tmp, 0o755);
renameSync(tmp, join(outDir, exe));
console.log(`push-guard ikilisi: ${join(outDir, exe)}`);
