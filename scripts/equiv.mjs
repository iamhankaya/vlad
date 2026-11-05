#!/usr/bin/env node
// Davranış eşdeğerliği (T20261105-65, U3). Kullanım: node scripts/equiv.mjs --base <sha> [--only "<anahtar>"] [--verbose]
// Taban (--base) geçici worktree'de derlenir; geçerli ikili bu reponun dist/cli.js'idir (önce `npm run build`).
// Her senaryo (scripts/equiv.cases.json) iki ikilide de taze bir test/fixtures/kb-mini kopyasında, allowlist env ve geçici HOME ile koşar;
// karşılaştırılan: çıkış kodu, stdout, stderr (normalize) ve koşu sonrası kb ağacının özeti (yazan komutlar için asıl kanıt).
// scripts/equiv.exempt.json koşulmayan komutları gerekçesiyle listeler; iki dosyanın birleşimi manifeste eşit olmalı (test denetler).
// Gerçek HOME/kb/~/.claude'a dokunulmaz; taban worktree ve dünyalar os.tmpdir() altında kurulur ve silinir.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { cleanEnv, run } from "./lib/golden.mjs";

const repo = resolve(import.meta.dirname, "..");
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const base = arg("--base"), only = arg("--only"), verbose = process.argv.includes("--verbose");
if (!base) { process.stderr.write("--base <sha> gerekli (ör. git merge-base HEAD vlad/<çatı-id> ya da U3 öncesi entegrasyon ucu)\n"); process.exit(2); }
const sh = (cmd, args, cwd) => { const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`); return r.stdout; };

const lf = (s) => s.replace(/\r\n/g, "\n");
const normalizer = (root) => (s) => lf(s)
  .split(root).join("<BASE>")
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}[:-]\d{2}[:-]\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g, "<ISO>")
  .replace(/pid \d+/g, "pid <PID>")
  .replace(/\d+ sn önce/g, "<N> sn önce")
  .replace(/\bT\d{8}-(\d+)/g, "T<DATE>-$1")
  .replace(/\bvlad-wt\/\S+/g, "<WT>");

const listFiles = (dir) => readdirSync(dir).sort().flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? listFiles(p) : [p]; });

/** kb ağacının özeti: yol + normalize içerik; kilit/log gibi geçici dosyalar dışarıda. */
function treeHash(kb, norm) {
  const h = createHash("sha256");
  for (const f of listFiles(kb)) {
    const rel = relative(kb, f).split("\\").join("/");
    if (rel.startsWith("logs/") || rel === ".vlad.lock") continue;
    h.update(norm(rel) + "\0" + norm(readFileSync(f, "utf8")) + "\0");
  }
  return h.digest("hex").slice(0, 16);
}

function runCase(cli, cliRepo, c) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-equiv-")));
  try {
    const home = join(root, "home");
    cpSync(join(repo, "test/fixtures/kb-mini/kb"), join(home, "kb"), { recursive: true });
    for (const d of ["schemas", "roles", "global"]) cpSync(join(cliRepo, d), join(home, d), { recursive: true });
    const local = join(home, "vlad.local.json");
    const env = cleanEnv({
      HOME: root, USERPROFILE: root, VLAD_HOME: home, VLAD_LOCAL_FILE: local, VLAD_MACHINE: "mac", VLAD_CLAUDE_DIR: join(root, ".claude"),
      VLAD_CLAUDE_JSON: join(root, "claude.json"), VLAD_LOCK_TIMEOUT_MS: "1000",
      GIT_AUTHOR_NAME: "e", GIT_AUTHOR_EMAIL: "e@example.invalid", GIT_COMMITTER_NAME: "e", GIT_COMMITTER_EMAIL: "e@example.invalid",
    });
    const norm = normalizer(root);
    const r = run(cli, c.argv, { env, input: c.input });
    return { code: r.code, stdout: norm(r.out), stderr: norm(r.err), timedOut: r.timedOut, kb: treeHash(join(home, "kb"), norm) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const spec = JSON.parse(readFileSync(join(repo, "scripts/equiv.cases.json"), "utf8"));
const cases = spec.cases.filter((c) => !only || c.key === only);
const cur = join(repo, "dist/cli.js");
const work = join(realpathSync.native(mkdtempSync(join(tmpdir(), "vlad-equiv-base-"))), "wt");
let bad = 0;
try {
  sh("git", ["worktree", "add", "--detach", work, base], repo);
  symlinkSync(join(repo, "node_modules"), join(work, "node_modules"));
  sh(process.execPath, [join(repo, "node_modules/typescript/bin/tsc")], work);
  const baseCli = join(work, "dist/cli.js");
  for (const c of cases) {
    const a = runCase(baseCli, work, c), b = runCase(cur, repo, c);
    const diffs = ["code", "stdout", "stderr", "timedOut", "kb"].filter((k) => a[k] !== b[k]);
    if (diffs.length) {
      bad++;
      process.stdout.write(`FARK  ${c.key}  (${diffs.join(", ")})\n`);
      for (const k of diffs) process.stdout.write(`   ${k}\n     taban:   ${JSON.stringify(a[k]).slice(0, 300)}\n     geçerli: ${JSON.stringify(b[k]).slice(0, 300)}\n`);
    } else if (verbose) process.stdout.write(`aynı  ${c.key}  (çıkış ${a.code}, kb ${a.kb})\n`);
  }
  process.stdout.write(`${cases.length - bad}/${cases.length} senaryo aynı, ${bad} fark (taban ${base})\n`);
} finally {
  spawnSync("git", ["worktree", "remove", "--force", work], { cwd: repo });
  rmSync(dirname(work), { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
