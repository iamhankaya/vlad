#!/usr/bin/env node
// D-vlad-093: Rust ikililerini derler ve dist/ altına kopyalar. `npm run build` bunu ÇALIŞTIRMAZ; devreye alma ayrı onaylıdır.
//   node scripts/build-native.mjs              → push-guard (varsayılan; eski davranış) → dist/hooks/push-guard (TS kancasının yanı;
//                                                ikili <home>/dist/hooks/ konumundan VLAD kökünü çözer)
//   node scripts/build-native.mjs memwatch     → bellek bekçisi (T20261128-06) → dist/bin/memwatch (`vlad top`, `vlad memwatch install`)
//   node scripts/build-native.mjs all          → ikisi
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CRATES = {
  "push-guard": { dir: join(root, "native", "push-guard"), out: join(root, "dist", "hooks") },
  memwatch: { dir: join(root, "native", "memwatch"), out: join(root, "dist", "bin") },
};

const args = process.argv.slice(2);
const names = args.length === 0 ? ["push-guard"] : args.includes("all") ? Object.keys(CRATES) : args;
for (const n of names) {
  if (!Object.hasOwn(CRATES, n)) {
    console.error(`bilinmeyen crate: ${n} (seçenekler: ${Object.keys(CRATES).join(", ")}, all)`);
    process.exit(2);
  }
}

for (const name of names) {
  const { dir, out } = CRATES[name];
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const r = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: dir, stdio: "inherit" });
  if (r.error) {
    console.error(`cargo çalıştırılamadı: ${r.error.message} (Rust kurulu mu? https://rustup.rs)`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);

  const src = join(dir, "target", "release", exe);
  if (!existsSync(src)) {
    console.error(`derleme çıktısı yok: ${src}`);
    process.exit(1);
  }
  mkdirSync(out, { recursive: true });
  // yerinde üzerine yazma çalışan süreci (kanca, daemon) bozmasın: geçici ad + rename
  const tmp = join(out, `.${exe}.${process.pid}`);
  copyFileSync(src, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, join(out, exe));
  console.log(`${name} ikilisi: ${join(out, exe)}`);
}
