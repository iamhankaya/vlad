#!/usr/bin/env node
// D-vlad-093 fark testi: aynı girdiyi (stdin + ortam + süreç cwd'si) TS kancasına (dist/hooks/push-guard-hook.js) ve
// Rust ikilisine (dist/hooks/push-guard) verir; çıkış kodu ve ret iletisi aynı olmalı. Yalnız geçici dizin kullanır:
// gerçek ~/.vlad-secret yalnız yol olarak geçer (stat), hiçbir şey yazılmaz/silinmez.
//
//   node scripts/push-guard-diff.mjs [--count 2400] [--seed 1] [--bench 200] [--jobs 8] [--verbose]
//
// İleti karşılaştırması: catch yolundaki istisna metni (V8 JSON.parse iletisi vs Rust) farklı olabilir; yalnız önek
// ("push-guard hatası (fail-closed)" / "mod-koruma hatası (fail-closed)") karşılaştırılır. Diğer tüm iletiler bayt bayt aynı olmalı.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TS = join(root, "dist", "hooks", "push-guard-hook.js");
const RS = join(root, "dist", "hooks", process.platform === "win32" ? "push-guard.exe" : "push-guard");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const COUNT = Number(arg("--count", "2400"));
const SEED = Number(arg("--seed", "1"));
const BENCH = Number(arg("--bench", "200"));
const JOBS = Number(arg("--jobs", "8"));
const VERBOSE = process.argv.includes("--verbose");

for (const f of [TS, RS]) if (!existsSync(f)) { console.error(`eksik: ${f} (önce npm run build && npm run build:native)`); process.exit(1); }

// --- tohumlu PRNG (mulberry32) ---
let s = SEED >>> 0;
const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];

// --- geçici düzen ---
const base = realpathSync(mkdtempSync(join(tmpdir(), "pg-diff-")));
if (!base.startsWith(realpathSync(tmpdir()))) throw new Error(`geçici dizin dışı: ${base}`);
const P = (...x) => join(base, ...x);
const git = (cwd, ...a) => spawnSync("git", a, { cwd, stdio: "ignore", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
function repo(dir, branch, detached = false) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
  if (detached) git(dir, "checkout", "-q", "--detach");
}
const OWN = "T20261127-99";
const WT = P("repo-wt", OWN); repo(WT, `vlad/${OWN}`);
const WT_NOGIT = P("Other-WT", "t20261127-98", "sub"); mkdirSync(WT_NOGIT, { recursive: true });
const PLAIN = P("plain"); repo(PLAIN, "main");
const BRANCHED = P("branched"); repo(BRANCHED, "vlad/T20261127-97");
const DETACHED = P("detached"); repo(DETACHED, "main", true);
const NOREPO = P("norepo"); mkdirSync(NOREPO);
const KB1 = P("kb1"); mkdirSync(join(KB1, "tasks"), { recursive: true }); writeFileSync(join(KB1, "mode.json"), "{}");
const KB2 = P("kb2"); mkdirSync(KB2);
const homes = {};
function home(name, cfg, local) {
  const h = P(name); mkdirSync(join(h, "dist", "hooks"), { recursive: true });
  if (cfg !== undefined) writeFileSync(join(h, "vlad.config.json"), cfg);
  if (local !== undefined) writeFileSync(join(h, "vlad.config.local.json"), local);
  homes[name] = h; return h;
}
home("h-rel", JSON.stringify({ kbDir: "../kb1" }));
home("h-abs", JSON.stringify({ kbDir: KB2 }));
home("h-bad", "{bozuk");
home("h-null", JSON.stringify({ kbDir: "../kb1" }), JSON.stringify({ kbDir: null }));
home("h-proto", JSON.stringify({}), JSON.stringify({ ["__proto__"]: { kbDir: KB2 } }).replace('"__proto__"', '"__proto__"'));
home("h-proto-own", '{"__proto__":{"kbDir":"/nope"}}', JSON.stringify({ ["__proto__"]: { kbDir: KB2 } }));
home("h-arr", "[1]");
home("h-none");
home("h-empty", JSON.stringify({ kbDir: "" }));
home("h-num", JSON.stringify({ kbDir: 5 }));
home("h-bom", "\ufeff" + JSON.stringify({ kbDir: KB2 }));
// symlink'ler (yalnız geçici dizinde; hedef gerçek gizli dizin yalnız yol olarak)
const SECRET = join(userInfo().homedir, ".vlad-secret");
symlinkSync(SECRET, join(WT, "sec-link"));
symlinkSync(join(KB1, "mode.json"), join(WT, "mode-link"));
symlinkSync(join(KB1, "yok.json"), join(WT, "dangling"));
symlinkSync(join(WT, "chain2"), join(WT, "chain1"));
symlinkSync(join(KB1, "mode.json"), join(WT, "chain2"));
symlinkSync(KB1, join(WT, "kb-link"));
symlinkSync(join(WT, "loop2"), join(WT, "loop1"));
symlinkSync(join(WT, "loop1"), join(WT, "loop2"));
mkdirSync(join(WT, ".claude"), { recursive: true }); writeFileSync(join(WT, ".claude", "settings.json"), "{}");
mkdirSync(join(WT, "dist", "hooks"), { recursive: true });

// --- girdi parçaları ---
const ids = [OWN, "T20261127-55", "T20261112-10"];
const pushCmds = [
  `git push origin vlad/${OWN}`, `git push -u origin vlad/${OWN}`, `git push --set-upstream origin vlad/${OWN} 2>&1`, `cd ${WT} && git push origin vlad/${OWN}`,
  `git push origin vlad/T20261127-55`, "git push origin main", "git push", `git push -f origin vlad/${OWN}`, `git push origin vlad/${OWN}:main`,
  `git push origin \\\nvlad/${OWN}`, `git \\\npush origin main`, `"git" push origin +main`, `git p\\ush origin main`, `timeout 30 git push origin vlad/${OWN}`,
  `bash -c 'git push origin main'`, `git commit -m "fix git push guard"`, "git commit -F /tmp/msg", "echo push", "git status", "gitpush", "git\u00a0push origin main",
  `\ufeffgit push origin vlad/${OWN}\ufeff`, `git push origin vlad/${OWN}\u2028`, `cd "${WT}" && git push origin vlad/${OWN}`, `cd a\u00e7 && git push origin vlad/${OWN}`,
  "égit épush", "git push origin vlad/T2026112-1", `git  push origin vlad/${OWN}`, `git push origin vlad/${OWN} `,
];
const modeCmds = [
  "vlad mode off", "vlad mode status", "vlad mode status --json", "VLAD mode OFF", "vlad mode STATUS", "env -u VLAD_TASK_ID vlad mode night", "node /x/dist/cli.js mode watch on",
  "npx tsx src/cli.ts mode off", "vlad --json mode off", "vlad.cmd mode off", "sudo vlad mode off", "FOO=1 vlad mode off", "bash -c 'vlad mode off'", `sh -c "vlad mode night"`,
  `eval "vlad mode off"`, "echo $(vlad mode off)", "echo `vlad mode off`", "(vlad mode off)", "a || vlad mode off", "vlad mode status; vlad mode off", "vlad mode status\nvlad mode off",
  `git commit -m "vlad mode off"`, "vlad task log T1 'vlad mode off'", "v\"la\"d mode off", "vlad \\\nmode off", "vlad\u00a0mode off", "vlad mode\u2028off", "cli mode off", "vladx mode off",
  `bash -c "bash -c 'vlad mode off'"`, `bash -c "bash -c \\"bash -c 'bash -c \\\\\\"vlad mode off\\\\\\"'\\""`, "zsh -xc 'vlad mode off'", "dash -c ''", "eval ''",
];
const paths = [
  join(KB1, "mode.json"), join(KB1, "MODE.JSON"), join(KB1, "sub", "..", "mode.json"), join(KB2, "mode.json"), "mode.json", "./mode.json", join(WT, "src", "mode.json"),
  join(KB1, "mod?.json"), join(KB1, "m*e.json"), join(KB1, "mode.jso[n]"), join(KB1, "*.json"), join(KB1, "mode["), join(KB1, "tasks", "T1.md"), join(KB2, "x"),
  "/Users/x/.claude/settings.json", "/Users/x/.claude/settings.local.json", join(WT, ".claude", "settings.json"), "~/.claude/settings.json", ".claude/setting?.json", "x/.CLAUDE/Settings.json",
  join(root, "dist", "hooks", "push-guard-hook.js"), join(root, "vlad.config.json"), join(root, "dist", "hooks"), join(homes["h-rel"], "dist", "hooks", "a.js"), join(homes["h-rel"], "vlad.config.json"),
  "dist/hooks/x.js", "vlad.config.json", SECRET, join(SECRET, "mode.key"), join(SECRET, "approver", "p.json"), "~/.vlad-secret/mode.key", "$HOME/.vlad-secret", "${HOME}/.vlad-secret/x",
  ".VLAD-SECRET/x", "sec-link/mode.key", "sec-link", "mode-link", "dangling", "chain1", "kb-link/mode.json", "loop1", join(WT, "a.ts"), "a.ts", "", "/", ".", "..", "../..",
  "C:\\Users\\x\\.claude\\settings.json", "a\\b\\mode.json", "~", "~x/mode.json", "/tmp/a\u0000b", "çğü/mode.json", "/tmp/😀/x", "mo\"de.j\"son", "x/m'o'de.json", "x/mode.json/",
  join(base, "*", ".vlad-secret"), join(userInfo().homedir, ".v*"), join(userInfo().homedir, ".vlad-{secret,x}", "k"), join(userInfo().homedir, ".?lad-secret"), join(userInfo().homedir, "*"),
  "~/.v*/k", "$HOME/.[v]lad-secret", "/U*/*/.vlad-secret", "/Users/*", "/*", "~/{a,b}/c", "/x/{a,{b,c}}/{d,e}", "/[z-a]/x", "/[!x]sers/*",
];
const benign = ["ls -la", "npm test", "cat README.md", "grep -r mode.json src", "git diff -- src/mode/mode.json", "echo hi > /tmp/out.txt", "sed -n 1,40p ~/.claude/settings.json 2>&1",
  "rm *.json", "rm -rf build/*", "cat x 2>/dev/null", "jq . a.json", "python3 x.py", "git checkout -b x", "sed -i '' s/a/b/ f", "ls ~/dev/*", "grep -r '.*' src", "echo [", "node -e 'x[0]'"];
const writers = ["echo x >", "echo x >>", "tee", "cp x", "mv a", "rm", "sed -i s/a/b/", "truncate -s0", "ln -s x", "python3 -c \"open('$P','w')\" #", "cat", "grep x", "ls", "jq . a | sponge", "git checkout --"];

function bashCommand() {
  const r = rnd();
  if (r < 0.2) return pick(pushCmds);
  if (r < 0.35) return pick(modeCmds);
  if (r < 0.7) { const p = pick(paths); const w = pick(writers); return w.includes("$P") ? w.replace("$P", p) : `${w} ${p}`; }
  if (r < 0.8) return pick(benign);
  // birleşik / mutasyonlu
  const parts = [pick(pushCmds), pick(modeCmds), pick(benign), `${pick(writers)} ${pick(paths)}`];
  let c = `${pick(parts)}${pick([" && ", "; ", " | ", "\n", " || ", " & "])}${pick(parts)}`;
  const m = rnd();
  if (m < 0.2) c = c.replace(/ /g, () => pick([" ", "  ", "\t", " \\\n", "\u00a0", "\ufeff", "\u0085"]));
  else if (m < 0.35) c = `bash -c '${c.replace(/'/g, "")}'`;
  else if (m < 0.45) c = `eval "${c.replace(/"/g, "")}"`;
  else if (m < 0.55) c = c.toUpperCase();
  return c;
}
const fileTools = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const readTools = ["Read", "Grep", "Glob"];
const otherTools = ["Task", "WebFetch", "bash", "TodoWrite"];
const globs = ["*", "**/*.ts", "**/mode.key", "../.vlad-secret/*", "**/../x/*", "*/../*.ts", "src/**/*.ts", "s/*/channel.json", ".vlad-secret/*", "{a,b}/*", "*.{js,ts}"];

function toolInput(tool) {
  if (tool === "Bash") return rnd() < 0.95 ? { command: bashCommand() } : pick([{}, { command: 5 }, { command: null }, { command: ["git push"] }]);
  if (fileTools.includes(tool)) {
    const r = rnd();
    if (r < 0.75) return tool === "NotebookEdit" && rnd() < 0.5 ? { notebook_path: pick(paths) } : { file_path: pick(paths) };
    return pick([{}, { file_path: null, notebook_path: pick(paths) }, { file_path: 5, notebook_path: pick(paths) }, { file_path: [pick(paths)] }, { notebook_path: null }]);
  }
  if (readTools.includes(tool)) {
    const o = {};
    if (rnd() < 0.6) o.file_path = pick(paths);
    if (rnd() < 0.5) o.path = pick(paths);
    if (rnd() < 0.5) o.pattern = rnd() < 0.5 ? pick(globs) : pick(paths);
    if (rnd() < 0.4) o.glob = pick(globs);
    if (rnd() < 0.05) o.path = 5;
    return o;
  }
  return { command: pick(pushCmds), file_path: pick(paths) };
}
const cwds = [WT, join(WT, "src"), WT_NOGIT, PLAIN, BRANCHED, DETACHED, NOREPO, base, "/", "", "rel", join(base, "yok", "repo-wt", "T20261127-96"), userInfo().homedir, join(WT, "sec-link")];
const procCwds = [WT, PLAIN, NOREPO, WT_NOGIT, BRANCHED, base];

function payload() {
  const r = rnd();
  const tool = r < 0.45 ? "Bash" : r < 0.65 ? pick(fileTools) : r < 0.9 ? pick(readTools) : pick(otherTools);
  const j = { tool_name: tool, tool_input: toolInput(tool) };
  const c = rnd();
  if (c < 0.85) j.cwd = pick(cwds); else if (c < 0.9) j.cwd = 7;
  if (rnd() < 0.03) j.tool_name = pick([5, null, "Bash ", "read"]);
  if (rnd() < 0.02) j.tool_input = pick(["x", null, [1], 3]);
  return JSON.stringify(j);
}
function broken() {
  const v = payload();
  const r = rnd();
  if (r < 0.3) return v.slice(0, Math.floor(rnd() * v.length));
  if (r < 0.4) return "\ufeff" + v;
  if (r < 0.5) return v.replace(/"command":"/, '"command":"\\ud800');
  if (r < 0.55) return v.replace(/"cwd":"/, '"cwd":"\\udc00\\ud83d\\ude00');
  if (r < 0.6) return `${"[".repeat(5000)}${"]".repeat(5000)}`;
  if (r < 0.65) return `{"tool_name":"Bash","tool_input":{"command":"git push origin main"}${"}".repeat(2)}`;
  if (r < 0.7) return v + " x";
  if (r < 0.75) return v.replace(/:/, ": ,");
  if (r < 0.8) return pick(["", " ", "{bozuk", "null", "[]", "\"x\"", "{\"tool_name\":\"Read\"", "{'tool_name':'Write'}", "{\"tool_name\" : \"Edit\" , x}", "settings", "dist hooks", "dist\u00e9hooks", "dist😀hooks", "vlad.config"]);
  if (r < 0.85) return v.replace(/\\\\/g, "\\x");
  if (r < 0.9) return Buffer.concat([Buffer.from(v.slice(0, 20)), Buffer.from([0xff, 0xc3, 0x28, 0xe2, 0x82]), Buffer.from(v.slice(20))]);
  return v.replace(/"/, "'");
}
const envs = [
  {}, { VLAD_TASK_ID: OWN }, { VLAD_TASK_ID: "T20261127-55" }, { VLAD_TASK_ID: "  " }, { VLAD_TASK_ID: "bad" }, { VLAD_TASK_ID: "\ufeff" },
  { VLAD_TASK_ID: OWN, VLAD_HOME: homes["h-rel"] }, { VLAD_TASK_ID: OWN, VLAD_KB_DIR: KB1 }, { VLAD_KB_DIR: "kb1", VLAD_HOME: base }, { VLAD_HOME: homes["h-bad"] },
  { VLAD_HOME: homes["h-null"] }, { VLAD_HOME: homes["h-proto"] }, { VLAD_HOME: homes["h-proto-own"] }, { VLAD_HOME: homes["h-arr"] }, { VLAD_HOME: homes["h-none"] },
  { VLAD_HOME: homes["h-empty"] }, { VLAD_HOME: homes["h-num"] }, { VLAD_HOME: homes["h-bom"] }, { VLAD_HOME: "rel-home" }, { VLAD_HOME: "" }, { VLAD_KB_DIR: "" },
  { VLAD_TASK_ID: OWN, HOME: "" }, { VLAD_TASK_ID: OWN, HOME: base }, { VLAD_TASK_ID: OWN, HOME: "/a$&b" }, { VLAD_TASK_ID: OWN, NOGIT: "1" }, { NOGIT: "1" },
];

const cases = [];
const fixed = [
  // TS testlerindeki uçtan uca vakalar
  [JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push -u origin vlad/T20261112-10" }, cwd: "/" }), { VLAD_TASK_ID: "T20261112-10" }, NOREPO],
  [JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: "/" }), {}, NOREPO],
  ['{"tool_input":{"command":"git push origin main"', { VLAD_TASK_ID: "T20261112-10" }, NOREPO],
  ["{bozuk", { VLAD_TASK_ID: "T20261112-10" }, NOREPO],
  ['{"tool_input":{"command":"vlad mode off"', {}, WT_NOGIT],
  ['{"tool_input":{"command":"vlad mode off"', {}, NOREPO],
  ...["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "MultiEdit"].map((t) => [`{"tool_name":"${t}","tool_input":{"file_path":"x"`, { VLAD_TASK_ID: "T20261116-99" }, NOREPO]),
  [`{"tool_name":"Read","tool_input":{"file_path":"x"`, {}, NOREPO],
];
for (const [input, env, cwd] of fixed) cases.push({ input, env, cwd });
while (cases.length < COUNT) {
  const env = pick(envs);
  const input = rnd() < 0.85 ? payload() : broken();
  cases.push({ input, env, cwd: pick(procCwds) });
}

function envFor(e) {
  const out = { PATH: e.NOGIT ? "/nonexistent-bin" : process.env.PATH, HOME: process.env.HOME };
  for (const [k, v] of Object.entries(e)) if (k !== "NOGIT") out[k] = v;
  return out;
}
const runOne = (bin, c) => new Promise((res) => {
  const [cmd, args] = bin === "ts" ? [process.execPath, [TS]] : [RS, []];
  const p = spawn(cmd, args, { cwd: c.cwd, env: envFor(c.env), stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => (err += d));
  const t = setTimeout(() => p.kill("SIGKILL"), 20000);
  p.on("close", (code, sig) => { clearTimeout(t); res({ code: code ?? `sig:${sig}`, err }); });
  p.stdin.on("error", () => {});
  p.stdin.end(c.input);
});
const normErr = (r) => {
  if (r.code === 1) return "<crash>";
  const m = /^(push-guard hatası \(fail-closed\)|mod-koruma hatası \(fail-closed\)): /.exec(r.err);
  return m ? `${m[1]}: <istisna>` : r.err;
};

const t0 = Date.now();
const mism = [];
const stats = { total: 0, block: 0, allow: 0, crash: 0, catchPath: 0 };
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= cases.length) return;
    const c = cases[i];
    const [a, b] = await Promise.all([runOne("ts", c), runOne("rs", c)]);
    stats.total++;
    if (a.code === 2) stats.block++; else if (a.code === 0) stats.allow++; else stats.crash++;
    if (/fail-closed/.test(a.err)) stats.catchPath++;
    if (a.code !== b.code || normErr(a) !== normErr(b)) mism.push({ i, input: typeof c.input === "string" ? c.input : `<bytes>${c.input.toString("latin1")}`, env: c.env, cwd: c.cwd, ts: a, rs: b });
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(JSON.stringify({ seed: SEED, cases: stats.total, same: stats.total - mism.length, mismatches: mism.length, ts_outcomes: { allow: stats.allow, block: stats.block, other: stats.crash, catch_path: stats.catchPath }, seconds: Number(elapsed) }));
for (const m of mism.slice(0, VERBOSE ? mism.length : 15)) console.log(JSON.stringify(m));

// --- süre ölçümü: aynı girdi, sıralı; spawn maliyeti dahil (Claude Code da süreç başlatır) ---
function bench(bin, input, env, cwd) {
  const [cmd, args] = bin === "ts" ? [process.execPath, [TS]] : [RS, []];
  const xs = [];
  for (let i = 0; i < BENCH; i++) {
    const t = process.hrtime.bigint();
    spawnSync(cmd, args, { input, env: envFor(env), cwd, stdio: ["pipe", "ignore", "ignore"] });
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  xs.sort((x, y) => x - y);
  const q = (p) => xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(2);
  return { p50: Number(q(0.5)), p95: Number(q(0.95)) };
}
if (BENCH > 0) {
  const bashIn = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status && npm test" }, cwd: PLAIN });
  const readIn = JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(WT, "a.ts") }, cwd: WT });
  const scenarios = [
    ["ana oturum Bash (git dal sorgusu)", bashIn, {}, PLAIN],
    ["ana oturum Read", JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/x" }, cwd: PLAIN }), {}, PLAIN],
    ["çalışan Bash", JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status && npm test" }, cwd: WT }), { VLAD_TASK_ID: OWN }, WT],
    ["çalışan push", JSON.stringify({ tool_name: "Bash", tool_input: { command: `git push -u origin vlad/${OWN}` }, cwd: WT }), { VLAD_TASK_ID: OWN }, WT],
    ["çalışan Read", readIn, { VLAD_TASK_ID: OWN }, WT],
  ];
  const out = {};
  for (const [name, input, env, cwd] of scenarios) out[name] = { rust: bench("rs", input, env, cwd), ts: bench("ts", input, env, cwd) };
  console.log(JSON.stringify({ bench_runs: BENCH, ms: out }));
}

if (realpathSync(base).startsWith(realpathSync(tmpdir()))) rmSync(base, { recursive: true, force: true });
process.exit(mism.length ? 1 : 0);
