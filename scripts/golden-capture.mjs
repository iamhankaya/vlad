#!/usr/bin/env node
// Golden üretimi (T20261105-62). Kullanım:
//   VLAD_GOLDEN_UPDATE=1 node scripts/golden-capture.mjs --base <sha>      # geçici worktree'de temiz build, golden yaz
//   VLAD_GOLDEN_UPDATE=1 node scripts/golden-capture.mjs --cli <dist/cli.js>  # hazır bir taban ikilisi (KB_WRITES için dump ucu gerekir)
// Çıktı: test/golden/{help,command-classes,command-behavior}.json. Güncelleme politikası: yalnız VLAD_GOLDEN_UPDATE=1 ile
// ve değişikliği yapan fazın commit'inde (gerekçe commit mesajında); `test/golden/intentional.json` bilinçli farkları listeler.
// Taban worktree os.tmpdir() altında kurulur, ana reponun node_modules'una yalnız sembolik bağ verilir ve iş bitince silinir.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { captureBehavior, captureClasses, captureHelp } from "./lib/golden.mjs";

if (process.env.VLAD_GOLDEN_UPDATE !== "1") { process.stderr.write("VLAD_GOLDEN_UPDATE=1 gerekli (golden'ı yanlışlıkla ezmemek için)\n"); process.exit(2); }
const repo = resolve(import.meta.dirname, "..");
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`); return r.stdout; };

let cli = arg("--cli"), work;
if (!cli) {
  const sha = arg("--base");
  if (!sha) { process.stderr.write("--base <sha> ya da --cli <dist/cli.js> gerekli\n"); process.exit(2); }
  work = join(realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-golden-base-"))), "wt");
  sh("git", ["worktree", "add", "--detach", work, sha], repo);
  symlinkSync(join(repo, "node_modules"), join(work, "node_modules"));
  // Tabanda KB_WRITES/REFRESH_KEYS export edilmez: yalnız bu geçici worktree'de, parse'tan önce JSON basan bir uç eklenir.
  const src = join(work, "src/cli.ts");
  const code = readFileSync(src, "utf8");
  const anchor = "try {\n  await program.parseAsync(process.argv);";
  if (!code.includes(anchor)) throw new Error("taban cli.ts parse çapası bulunamadı");
  writeFileSync(src, code.replace(anchor, `if (process.env.VLAD_DUMP_CLASSES) { process.stdout.write(JSON.stringify({ KB_WRITES: [...KB_WRITES], REFRESH_KEYS: [...REFRESH_KEYS] }) + "\\n"); process.exit(0); }\n${anchor}`));
  sh(process.execPath, [join(repo, "node_modules/typescript/bin/tsc")], work);
  cli = join(work, "dist/cli.js");
}
try {
  const outDir = join(repo, "test/golden");
  mkdirSync(outDir, { recursive: true });
  const put = (name, obj) => writeFileSync(join(outDir, name), JSON.stringify(obj, null, 2) + "\n");
  const distDir = dirname(cli);
  const baseSha = arg("--base") ?? "(--cli)";
  put("command-classes.json", { base: baseSha, ...(await captureClasses(distDir, { dumpCli: cli })) });
  put("help.json", { base: baseSha, commander: JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).dependencies.commander, help: captureHelp(cli) });
  put("command-behavior.json", { base: baseSha, ...(await captureBehavior(cli, repo)) });
  process.stdout.write(`golden yazıldı: ${outDir}\n`);
} finally {
  if (work) {
    spawnSync("git", ["worktree", "remove", "--force", work], { cwd: repo });
    rmSync(dirname(work), { recursive: true, force: true });
  }
}
