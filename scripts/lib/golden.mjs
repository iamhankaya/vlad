// Golden yakalama ortak kütüphanesi (T20261105-62). Hem `scripts/golden-capture.mjs` (taban ikiliyle üretim)
// hem `test/acceptance/restructure-*.test.ts` (geçerli ikiliyle yeniden üretim + karşılaştırma) bunu kullanır; böylece
// iki taraf aynı senaryoyu koşar. Hiçbir şey gerçek HOME/kb'ye dokunmaz: her senaryo kendi geçici dizininde,
// allowlist env ile koşar (process.env yayılmaz). Kaynak regex yok: sınıflar dist import'uyla, yardım metni gerçek CLI'dan alınır.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const GOLDEN_COLUMNS = "100";

/** Allowlist env: PATH + OS temelleri + temp HOME; test verdiklerini ekler. */
export function cleanEnv(extra = {}) {
  const env = {};
  const path = process.env.PATH ?? process.env.Path;
  if (path !== undefined) env.PATH = path;
  for (const k of ["SYSTEMROOT", "COMSPEC", "PATHEXT", "TMPDIR", "TEMP", "TMP"]) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, { TZ: "UTC", COLUMNS: GOLDEN_COLUMNS, NO_COLOR: "1", VLAD_LAUNCHER: "noop", CLAUDE_CODE_REMOTE: "", VLAD_NO_NATIVE: "1" });
  return { ...env, ...extra };
}

export function run(cli, argv, { env, input, timeoutMs = 30_000 } = {}) {
  const r = spawnSync(process.execPath, [cli, ...argv], { encoding: "utf8", env, input, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 10 * 1024 * 1024 });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
}

const lf = (s) => s.replace(/\r\n/g, "\n");

// ---------- yardım metni ----------

/** Yardım çıktısındaki "Commands:" bölümünden alt komut adları (gerçek CLI çıktısı; kaynak okunmaz). */
function subcommandsOf(helpText) {
  const lines = lf(helpText).split("\n");
  const i = lines.findIndex((l) => l.trim() === "Commands:");
  if (i < 0) return [];
  const names = [];
  for (const l of lines.slice(i + 1)) {
    if (!l.trim()) break;
    const m = /^ {2}([a-z][a-z0-9-]*)/.exec(l);
    if (m && !(l.startsWith("  help"))) names.push(m[1]);
  }
  return names;
}

/** Yaprak komut yolları (grup değil); `--help` çıktısını özyinelemeyle gezer. */
export function leafPaths(cli, env) {
  const leaves = [];
  const walk = (path) => {
    const r = run(cli, [...path, "--help"], { env });
    const subs = subcommandsOf(r.out);
    if (!subs.length && path.length) { leaves.push(path); return; }
    for (const s of subs) walk([...path, s]);
  };
  walk([]);
  return leaves;
}

/** Her komut için `--help` (stdout+çıkış kodu) ve grup yardımı (çıplak grup → stderr, çıkış 1). */
export function captureHelp(cli) {
  const env = cleanEnv({ HOME: tmpdir() });
  const out = {};
  const walk = (path) => {
    const key = path.join(" ") || "(root)";
    const r = run(cli, [...path, "--help"], { env });
    out[`${key} --help`] = { code: r.code, stdout: lf(r.out), stderr: lf(r.err) };
    const subs = subcommandsOf(r.out);
    if (subs.length && path.length) {
      const g = run(cli, path, { env });
      out[`${key} (bare)`] = { code: g.code, stdout: lf(g.out), stderr: lf(g.err) };
    }
    for (const s of subs) walk([...path, s]);
  };
  walk([]);
  return out;
}

// ---------- komut sınıfları ----------

const imp = (file) => import(pathToFileURL(file).href);

/**
 * Sınıf kümeleri. `distDir` = ikilinin `dist` klasörü. KB_WRITES/REFRESH_KEYS tabanda export edilmez:
 * `dump` verilirse (taban için, geçici worktree'de enjekte edilen VLAD_DUMP_CLASSES ucu) o ikiliden okunur;
 * yoksa geçerli ağaçtaki erişimci ya da `cli/program.js` export'u kullanılır.
 */
export async function captureClasses(distDir, { dumpCli } = {}) {
  const fwd = await imp(join(distDir, "agent/forward.js"));
  const cat = await imp(join(distDir, "agent/console-catalog.js"));
  const lock = await imp(join(distDir, "machines/lock-policy.js"));
  let KB_WRITES, REFRESH_KEYS;
  if (dumpCli) {
    const r = run(dumpCli, ["--help"], { env: cleanEnv({ VLAD_DUMP_CLASSES: "1", HOME: tmpdir() }) });
    const j = JSON.parse(r.out.trim().split("\n").pop());
    KB_WRITES = j.KB_WRITES; REFRESH_KEYS = j.REFRESH_KEYS;
  } else {
    let done = false;
    try {
      const acc = await imp(join(distDir, "commands/accessors.js"));
      KB_WRITES = [...acc.kbWriteKeys()]; REFRESH_KEYS = [...acc.refreshKeys()]; done = true;
    } catch { /* manifest henüz dolu değil (stub throw'u) → program.js export'una düş */ }
    if (!done) {
      const prog = await imp(join(distDir, "cli/program.js"));
      KB_WRITES = [...prog.KB_WRITES]; REFRESH_KEYS = [...prog.REFRESH_KEYS];
    }
  }
  const sort = (a) => [...a].sort();
  return {
    version: 1,
    KB_WRITES: sort(KB_WRITES),
    REFRESH_KEYS: sort(REFRESH_KEYS),
    WORKER_LOCAL: sort(fwd.WORKER_LOCAL),
    FORWARD: Object.fromEntries(Object.entries(fwd.FORWARD).sort(([a], [b]) => a.localeCompare(b))),
    INNER_LOCK: sort(lock.INNER_LOCK),
    CONSOLE_CATALOG: JSON.parse(JSON.stringify(cat.CONSOLE_CATALOG)),
  };
}

// ---------- davranış matrisi ----------

export const CONTEXTS = ["single", "brain", "worker", "unknown", "locked", "forwarded"];

/** Matrisin komutları: [anahtar etiketi, argv]. Her sınıftan temsilciler; hepsi sahte kb'de deterministik başarılı/başarısız. */
export const BEHAVIOR_CASES = [
  // kb yazıcı, dış kilit
  ["project write", ["project", "write", "ghost", "--file", "<CARD>", "--json"]],
  ["project note", ["project", "note", "ghost", "ders", "--json"]],
  ["finding add", ["finding", "add", "--project", "ghost", "--title", "x", "--severity", "düşük", "--source", "T20260101-01", "--json"]],
  ["finding set", ["finding", "set", "F-ghost-001", "fixed", "--json"]],
  ["task new", ["task", "new", "--project", "ghost", "--title", "x", "--kind", "dev", "--body-file", "-", "--json"]],
  ["task set", ["task", "set", "T20260101-01", "done", "--json"]],
  ["decision add", ["decision", "add", "--project", "ghost", "--title", "x", "--body-file", "-", "--json"]],
  ["decision set", ["decision", "set", "D-ghost-001", "geçersiz", "--json"]],
  ["inbox done", ["inbox", "done", "nope", "--json"]],
  ["journal append", ["journal", "append", "2026-01-01", "--file", "-", "--json"]],
  ["session register", ["session", "register", "ghost", "--json"]],
  ["mode off", ["mode", "off", "--json"]],
  ["mode status", ["mode", "status", "--json"]],
  ["kb maintain", ["kb", "maintain", "--dry-run", "--json"]],
  // iç kilit
  ["task resume", ["task", "resume", "T20260101-01", "--json"]],
  ["task cleanup", ["task", "cleanup", "T20260101-01", "--json"]],
  // iletilen
  ["task log", ["task", "log", "T20260101-01", "not", "--json"]],
  ["task ask", ["task", "ask", "T20260101-01", "soru", "--json"]],
  ["task session", ["task", "session", "T20260101-01", "sess-1", "--json"]],
  // işçide yerel
  ["task list", ["task", "list", "--json"]],
  ["finding list", ["finding", "list", "--json"]],
  ["decision list", ["decision", "list", "--json"]],
  ["role list", ["role", "list", "--json"]],
  ["inbox count", ["inbox", "count", "--json"]],
  ["status --no-mark", ["status", "--summary", "--no-mark", "--json"]],
  ["status", ["status", "--summary", "--json"]],
  ["status --hook", ["status", "--hook"]],
  ["kb search", ["kb", "search", "ghost", "--json"]],
  // kilitsiz ama işçide yerel değil → reject
  ["task launch", ["task", "launch", "T20260101-01", "--dry-run", "--json"]],
  ["task gate", ["task", "gate", "T20260101-01", "--json"]],
  ["project list", ["project", "list", "--json"]],
  ["project status", ["project", "status", "ghost", "--json"]],
];

async function freePort() {
  return await new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

function makeWorld(root, ctxName, { repoRoot, port }) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), `vlad-golden-${ctxName}-`)));
  const home = join(base, "home");
  for (const d of ["projects", "tasks", "inbox", "inbox/processed", "logs", "journal", "findings"]) mkdirSync(join(home, "kb", d), { recursive: true });
  cpSync(join(repoRoot, "schemas"), join(home, "schemas"), { recursive: true });
  const multi = ctxName !== "single" && ctxName !== "locked";
  const machines = [{ name: "mac", os: "darwin", agent: { port } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port } }];
  if (multi) writeFileSync(join(home, "vlad.config.json"), JSON.stringify({ brain: "mac", machines }));
  const self = ctxName === "brain" ? "mac" : ctxName === "unknown" ? "ghost-machine" : ctxName === "single" || ctxName === "locked" ? "mac" : "windows";
  const local = join(home, "vlad.local.json");
  const k = "a".repeat(64);
  writeFileSync(local, JSON.stringify({ self, keys: { mac: k, windows: k } }));
  const card = join(base, "card.md");
  writeFileSync(card, `---\nslug: ghost\nname: ghost\npath: ${JSON.stringify(join(base, "ghost-repo"))}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`);
  if (ctxName === "locked") {
    // taze, yaşayan pid'li (bu süreç) kilit: dış kilit alan komut zaman aşımına düşer
    writeFileSync(join(home, "kb", ".vlad.lock"), JSON.stringify({ pid: process.pid, started: Date.now(), token: "golden-holder" }));
  }
  const env = cleanEnv({
    HOME: base, USERPROFILE: base, VLAD_HOME: home, VLAD_LOCAL_FILE: local, VLAD_MACHINE: self,
    VLAD_CLAUDE_JSON: join(base, "claude.json"), VLAD_LOCK_TIMEOUT_MS: "300",
    GIT_AUTHOR_NAME: "g", GIT_AUTHOR_EMAIL: "g@example.invalid", GIT_COMMITTER_NAME: "g", GIT_COMMITTER_EMAIL: "g@example.invalid",
    ...(ctxName === "forwarded" ? { VLAD_FORWARDED: "1" } : {}),
  });
  return { base, home, card, env };
}

const normalizer = (w, port) => (s) => lf(s)
  .split(w.base).join("<BASE>")
  .replace(new RegExp(String(port), "g"), "<PORT>")
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, "<ISO>")
  .replace(/pid \d+/g, "pid <PID>")
  .replace(/\d+ sn önce/g, "<N> sn önce")
  .replace(/\bT\d{8}-(\d+)/g, "T<DATE>-$1");

/**
 * Komut × bağlam matrisi. Hücre: çıkış kodu, stdout, stderr (normalize) ve gözlem bayrakları:
 * `lockTimeout` (dış kilit alınmaya çalışıldı), `forwardAttempt` (yerel Agent'a iletim denendi), `rejected` (işçi reddi).
 * Hiçbir hücre ağ/hesap/pano kullanmaz; iletim yalnız kapalı yerel porta gider.
 */
export async function captureBehavior(cli, repoRoot, contexts = CONTEXTS) {
  const port = await freePort();
  const matrix = {};
  for (const ctxName of contexts) {
    const w = makeWorld(repoRoot, ctxName, { repoRoot, port });
    const norm = normalizer(w, port);
    try {
      for (const [label, argvT] of BEHAVIOR_CASES) {
        const argv = argvT.map((a) => (a === "<CARD>" ? w.card : a));
        const input = argv.includes("-") ? "## Tanım\nx\n" : undefined;
        const r = run(cli, argv, { env: w.env, input });
        const err = norm(r.err), out = norm(r.out);
        matrix[`${ctxName} :: ${label}`] = {
          code: r.code, stdout: out, stderr: err,
          lockTimeout: /kb kilidi alınamadı/.test(err),
          forwardAttempt: /VLAD Agent çalışmıyor|kuyruğa alındı|Agent/.test(err) && ctxName === "worker",
          rejected: /beyin değil|kimliği doğrulanamadı/.test(err),
          timedOut: r.timedOut,
        };
      }
    } finally {
      rmSync(w.base, { recursive: true, force: true });
    }
  }
  return { version: 1, contexts, matrix };
}
