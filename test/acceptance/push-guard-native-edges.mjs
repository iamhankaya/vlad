#!/usr/bin/env node
// T20261127-26 (doğrulama, D-vlad-093): push-guard Rust ikilisi ↔ TS kancası kenar durum fark testi + politika kâhini + süre ölçümü.
// Geliştiricinin rastgele koşucusunu (scripts/push-guard-diff.mjs) tamamlar: burada girdiler deterministik kenar durum çarpımıdır.
//
//   npm run build && npm run build:native
//   node test/acceptance/push-guard-native-edges.mjs [--bench 200] [--warmup 20] [--jobs 8] [--verbose] [--only-red]
//
// İki ayrı denetim:
//   1. FARK: her girdi aynı stdin/ortam/süreç cwd'siyle iki kancaya verilir; çıkış kodu + ret iletisi aynı olmalı
//      (catch yolunda yalnız "… (fail-closed)" öneki karşılaştırılır; istisna metni V8'e özgü).
//   2. KÂHİN: girdinin politikaya göre beklenen kararı (spec: push-guard.ts/mode-guard.ts/push-guard-hook.ts başlık yorumları,
//      vlad-worker "İzin kalıpları") biliniyorsa iki kancanın çıkışı da ona eşit olmalı. İki taraf aynı yanlış kararı verirse
//      FARK yeşil, KÂHİN kırmızı olur. Kâhini olmayan girdi (bilinen "shortcut" kaçışları) yalnız FARK'a girer.
//   Bilinçli kırmızı (KNOWN_RED): politikanın açık olduğu ama iki kancanın da uymadığı girdiler; ayrıca listelenir, çıkışı bozmaz
//   (rapor "Kırmızı bırakılan testler"). Yeni (listede olmayan) kırmızı çıkışı 1 yapar.
//
// Gerçek kaynak koruması: yalnız mkdtemp altında dosya oluşturur; kök realpath ile doğrulanır, çıkışta silinir. Gerçek ~/.vlad-secret ve
// ~/.claude/settings.json yalnız araç girdisindeki YOL olarak geçer; kancalar yazmaz, bu betik de onlara dokunmaz.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TS = join(root, "dist", "hooks", "push-guard-hook.js");
// PG_EDGE_RS: koşucu duyarlılık denemesi için başka ikili (ör. /usr/bin/true → her vakada izin; FARK ve KÂHİN kırmızı olmalı)
const RS = process.env.PG_EDGE_RS || join(root, "dist", "hooks", "push-guard");
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const BENCH = Number(arg("--bench", "200"));
const WARMUP = Number(arg("--warmup", "20"));
const JOBS = Number(arg("--jobs", "8"));
const VERBOSE = process.argv.includes("--verbose");
for (const f of [TS, RS]) if (!existsSync(f)) { console.error(`eksik: ${f} (önce npm run build && npm run build:native)`); process.exit(1); }

// --- geçici düzen ---
const tmpReal = realpathSync(tmpdir());
const base = realpathSync(mkdtempSync(join(tmpdir(), "pg-edge-")));
if (!base.startsWith(tmpReal + "/")) throw new Error(`geçici dizin dışı: ${base}`);
process.on("exit", () => { try { const r = realpathSync(base); if (r.startsWith(tmpReal + "/") && r.includes("pg-edge-")) rmSync(r, { recursive: true, force: true }); } catch {} });
const P = (...x) => join(base, ...x);
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd, ...a) => { const r = spawnSync("git", a, { cwd, stdio: "ignore", env: gitEnv }); if (r.status !== 0) throw new Error(`git ${a.join(" ")} @ ${cwd}`); };
function repo(dir, branch) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x");
}
const OWN = "T20261127-77";
const KB = P("kb"); mkdirSync(join(KB, "tasks"), { recursive: true }); writeFileSync(join(KB, "mode.json"), "{}");
const VH = P("vlad-home"); mkdirSync(join(VH, "dist", "hooks"), { recursive: true }); writeFileSync(join(VH, "vlad.config.json"), JSON.stringify({ kbDir: KB }));
const WT = P("proj-wt", OWN); repo(WT, `vlad/${OWN}`); mkdirSync(join(WT, ".claude")); mkdirSync(join(WT, "src"));
const WT_OTHER = P("proj-wt", "T20261127-88"); repo(WT_OTHER, "main"); // -wt/T… dizini ama vlad dalı değil
const WT_FOREIGN = P("proj-wt", "T20261127-87"); repo(WT_FOREIGN, "vlad/T20261127-55"); // dizin 87, dal 55
const MAIN = P("main-repo"); repo(MAIN, "master");
const NOREPO = P("norepo"); mkdirSync(NOREPO);
const BSLASH = P("x-wt\\T20261127-86"); mkdirSync(BSLASH); // posix'te ters bölü ad karakteridir (WT_DIR kalıbı \ ayracını da kabul eder)
const SECRET = join(homedir(), ".vlad-secret");

// --- oturumlar: ortam + süreç cwd'si + JSON cwd'si + kâhin bilgisi ---
// worker: mode-guard çalışır mı; validated: push doğrulaması çalışır mı; id: push için "kendi" kimlik (null = kalıba uyan her id)
const S = (name, env, proc, cwd, worker, validated, id) => ({ name, env: { VLAD_HOME: VH, ...env }, proc, cwd, worker, validated, id });
const sessions = [
  S("ana", {}, MAIN, MAIN, false, false, null),
  S("ana-cwd-yok", {}, MAIN, undefined, false, false, null),
  S("ana-norepo", {}, NOREPO, NOREPO, false, false, null),
  S("çalışan-env", { VLAD_TASK_ID: OWN }, WT, WT, true, true, OWN),
  S("çalışan-env-alt-dizin", { VLAD_TASK_ID: OWN }, WT, join(WT, "src"), true, true, OWN),
  S("çalışan-env-dışarıda", { VLAD_TASK_ID: OWN }, MAIN, MAIN, true, true, OWN), // cd ile worktree dışı
  S("çalışan-dal", {}, WT, WT, true, true, OWN), // env -u VLAD_TASK_ID sonrası: dal ile tanınır
  S("çalışan-yabancı-dal", {}, WT_FOREIGN, WT_FOREIGN, true, true, "T20261127-55"),
  S("çalışan-env-geçersiz", { VLAD_TASK_ID: "bad" }, MAIN, MAIN, true, true, null),
  S("çalışan-dizin-farklı-dal", {}, WT_OTHER, WT_OTHER, true, false, null),
  S("windows-cwd", {}, NOREPO, "C:\\dev\\vlad-wt\\T20261127-26", true, false, null), // realpath çözülemez → fail-closed çalışan
  S("windows-cwd-ileri", {}, NOREPO, "C:/dev/proj-wt/T20261127-26/src", true, false, null),
  S("windows-cwd-env", { VLAD_TASK_ID: OWN }, NOREPO, "C:\\dev\\proj-wt\\" + OWN, true, true, OWN),
  S("ters-bölü-adlı-dizin", {}, BSLASH, BSLASH, false, false, null), // posix: tek bileşen, -wt/T… değil
];

// --- push komutları: [komut, hedef id | "bad"] ("bad" = kalıba uymaz → doğrulanan oturumda ret) ---
const own = (id) => [`git push origin vlad/${id}`, id];
const pushCmds = [
  own(OWN), [`git push -u origin vlad/${OWN}`, OWN], [`git push --set-upstream origin vlad/${OWN} 2>&1`, OWN], [`cd ${WT} && git push origin vlad/${OWN}`, OWN],
  [`cd .. && git push origin vlad/${OWN}`, OWN], own("T20261127-55"), own("T20261127-88"),
  [`git -C ${WT} push origin vlad/${OWN}`, "bad"], [`git -C x push origin main`, "bad"], [`git --git-dir=.git push origin vlad/${OWN}`, "bad"],
  [`git push --force origin vlad/${OWN}`, "bad"], [`git push -f origin vlad/${OWN}`, "bad"], [`git push --force-with-lease origin vlad/${OWN}`, "bad"], [`git push origin +vlad/${OWN}`, "bad"],
  [`git push origin vlad/${OWN} --force`, "bad"], [`git push origin vlad/${OWN}:main`, "bad"], [`git push origin vlad/${OWN} main`, "bad"], ["git push origin --all", "bad"], ["git push --mirror origin", "bad"],
  [`git push origin --delete vlad/${OWN}`, "bad"], ["git push", "bad"], ["git push origin main", "bad"], ["git push upstream vlad/" + OWN, "bad"],
  [`env -u VLAD_TASK_ID git push origin main`, "bad"], [`env -u VLAD_TASK_ID git push origin vlad/${OWN}`, "bad"], [`VLAD_TASK_ID= git push origin main`, "bad"], [`unset VLAD_TASK_ID; git push origin main`, "bad"],
  [`cd ..; git push origin vlad/${OWN}`, "bad"], ["cd ..; git push origin main", "bad"], ["cd / && git push origin main", "bad"], [`cd "${WT}" && git push origin vlad/${OWN}`, "bad"], ["cd $HOME && git push origin main", "bad"],
  ["(git push origin main)", "bad"], [`(git push origin vlad/${OWN})`, "bad"], ["$(git push origin main)", "bad"], ["echo `git push origin main`", "bad"], ["{ git push origin main; }", "bad"],
  ["bash -c 'git push origin main'", "bad"], [`sh -c "git push origin vlad/${OWN}"`, "bad"], ["eval 'git push origin main'", "bad"], ["xargs git push origin < /dev/null", "bad"],
  ["bash <<'EOF'\ngit push origin main\nEOF", "bad"], ["bash <<EOF\ngit push --force origin vlad/" + OWN + "\nEOF", "bad"], ["cat > /tmp/x.sh <<'EOF'\ngit push origin main\nEOF\nbash /tmp/x.sh", "bad"],
  ["git push origin main &", "bad"], ["true && git push origin main", "bad"], ["false || git push origin main", "bad"], ["git status; git push origin main", "bad"], ["git status\ngit push origin main", "bad"],
  ["git \\\npush origin main", "bad"], [`git push origin \\\nvlad/${OWN}`, OWN], ["GIT_TRACE=1 git push origin main", "bad"], ["command git push origin main", "bad"], ["/usr/bin/git push origin main", "bad"],
  ["git p\\ush origin main", "bad"], ["g'i't push origin main", "bad"], ["git pu\"\"sh origin main", "bad"], ["git  push origin main", "bad"],
  [`git commit -m "git push yok"`, "bad"], ["git commit -F /tmp/msg", null], ["git status", null], ["echo push", null], ["gitpush origin main", null],
  [`git push origin vlad/${OWN} `, OWN], ["git\tpush origin main", "bad"], [`git push origin vlad/T2026112-1`, "bad"],
];
// macOS (APFS b\u00fcy\u00fck/k\u00fc\u00e7\u00fck harf duyars\u0131z) ve Windows'ta `GIT`/`Git` git ikilisini \u00e7al\u0131\u015ft\u0131r\u0131r; alt komut `push` k\u00fc\u00e7\u00fck harf kalmal\u0131.
// "GIT PUSH" ger\u00e7ek push de\u011fildir (git: 'PUSH' is not a git command) \u2192 k\u00e2hinsiz.
const upperCmds = [["GIT push --force origin main", "bad"], ["Git push origin main", "bad"], [`GIT push origin vlad/${OWN}`, "bad"], ["cd .. && GIT push -f origin main", "bad"], ["/usr/bin/GIT push origin main", "bad"]];
const upperNoOracle = ["GIT PUSH ORIGIN MAIN", "git PUSH origin main"];
// Bilinen "shortcut" kaçışları (push-guard.ts yorumu): kelime olarak görünmeyen push; yalnız FARK'a girer
// Sondaki NBSP: JS trim() atar (izin), bash'te refspec'in parçasıdır → uzakta `vlad/T…<NBSP>` adlı yeni dal; korunan dala erişmez
const shortcutCmds = [`git push origin vlad/${OWN} `, "git $(echo pu)sh origin main", "g=git; $g push origin main", "git ${P}ush origin main", "alias gp='git push'; gp origin main", "git pus? origin main"];

// --- korunan yazma hedefleri: [ad, yol, Write/Edit kâhini (true = çalışanda ret)] ---
const targets = [
  ["kb mode.json", join(KB, "mode.json"), true], ["kb MODE.JSON", join(KB, "MODE.JSON"), true], ["kb mode.json ..", join(KB, "tasks", "..", "mode.json"), true],
  ["~/.claude/settings.json", join(homedir(), ".claude", "settings.json"), true], ["~ settings.local", "~/.claude/settings.local.json", true],
  ["proje .claude/settings.json", join(WT, ".claude", "settings.json"), true], ["göreli .claude/settings.local.json", ".claude/settings.local.json", true],
  ["windows settings", "C:\\Users\\x\\.claude\\settings.json", true], ["windows karışık settings", "C:/Users/x\\.claude/settings.json", true],
  ["vlad.config.json", join(VH, "vlad.config.json"), true], ["dist/hooks dosya", join(VH, "dist", "hooks", "push-guard-hook.js"), true],
  ["dist/hooks ikili", join(VH, "dist", "hooks", "push-guard"), true], ["dist/hooks dizin", join(VH, "dist", "hooks"), true],
  ["dist/hooks ..", join(VH, "dist", "x", "..", "hooks", "y.js"), true],
  ["vlad-secret anahtar", join(SECRET, "mode.key"), true], ["vlad-secret dizin", SECRET, true], ["~ vlad-secret", "~/.vlad-secret/mode.key", true],
  ["$HOME vlad-secret", "$HOME/.vlad-secret/approver/p.json", true], ["VLAD-SECRET büyük", join(homedir(), ".VLAD-SECRET", "k"), true],
];
// [ad, yol, Bash'te çalışanda ret mi]: Bash komut parçasında yol çözülemez, `mode.json` ADI her dizinde korunur (mode-guard.ts protectedPath anyDir);
// dosya araçlarında yalnız kb'nin mode.json'u korunur.
const benignTargets = [["proje dosyası", join(WT, "src", "a.ts"), false], ["proje mode.json", join(WT, "src", "mode.json"), true], ["tmp", "/tmp/pg-edge-out.txt", false], ["kb dışı dist", join(WT, "dist", "hooks", "x.js"), false]];
// Politika sorusu (spec belirsiz): yerel katman kbDir'i değiştirebilir → mode.json koruması başka kb'ye kayar
const probeTargets = [["vlad.config.local.json", join(VH, "vlad.config.local.json")]];

// Bash yazma biçimleri (komut içindeki yol; yolu tırnaksız koyan biçimler ters bölülü yolda kâhinsizdir)
const bashWriters = [
  (t) => `echo x > ${t}`, (t) => `echo x >> ${t}`, (t) => `printf x>${t}`, (t) => `tee ${t} < /dev/null`, (t) => `cp /tmp/a ${t}`, (t) => `mv /tmp/a ${t}`, (t) => `rm -f ${t}`,
  (t) => `sed -i '' s/a/b/ ${t}`, (t) => `ln -sf /tmp/a ${t}`, (t) => `truncate -s0 ${t}`, (t) => `python3 -c "open('${t}','w')"`, (t) => `node -e "require('fs').writeFileSync('${t}','')"`,
  (t) => `cat > ${t} <<'EOF'\n{}\nEOF`, (t) => `ls && echo x > ${t}`, (t) => `(echo x > ${t})`, (t) => `bash -c 'echo x > ${t}'`, (t) => `env -u VLAD_TASK_ID tee ${t} </dev/null`,
];
const quotedWriters = [(t) => `echo x > "${t}"`, (t) => `cp /tmp/a '${t}'`];
// K1 (T20261128-01): APFS ad eşdeğerleri — ſ→s, K(U+212A)→k, ß→ss, ﬁ→fi, ﬆ→st aynı dosyayı açar (macOS'ta kod noktası taramasıyla doğrulandı).
// Korunan her hedefin katlanmış eşdeğeri ve yazıcı komut adının eşdeğeri (ſed, baſh, inſtall) aynı kâhinle reddedilmeli.
const foldVariants = (t) => [...new Set([t.replace(/s/g, "ſ"), t.replace(/ss/g, "ß").replace(/fi/g, "ﬁ").replace(/st/g, "ﬆ").replace(/k/g, "K")])].filter((x) => x !== t);
// F-vlad-408/409 (T20261128-01): korunan hedefin jokerli biçimleri (son bileşende `?` / baştaki `*` / süslü; dizin bileşeninde `*`) kabukta aynı dosyaya açılır → ret
const jokerVariants = (t) => {
  if (hasBackslash(t)) return [];
  const sg = t.split("/"), last = sg.at(-1), par = sg.at(-2), up = (x) => [...sg.slice(0, -1), x].join("/");
  const c = last.at(-1), body = last.slice(0, -1);
  // review tur 2: {x..y} dizisi, `]` ile başlayan sınıf, POSIX sınıfı, sözcük başında brace (tilde/kök brace içinde)
  const out = [up(last.slice(0, 1) + "?" + last.slice(2)), up(`{${last},zz}`), up(`${body}{${c}..${c}}`), up(`${body}[]${c}]`), up(`${body}[[:alnum:]]`), `{${t},/dev/null}`];
  if (!last.startsWith(".")) out.push(up("*" + last.slice(1)));
  if (par && par !== ".." && par !== "~" && par.length > 1) out.push([...sg.slice(0, -2), par.slice(0, -1) + "*", last].join("/"));
  return out;
};
const jokerBenign = [join(WT, "src", "*.ts"), join(VH, "src", "*.ts"), join(homedir(), ".claude", "*.md"), join(VH, "dist", "*.js"), join(WT, "*.json")];
// T20261128-04 (F-vlad-410..413): fail-closed — çoklu POSIX/collating/eşdeğerlik sınıfı, zsh alternasyonu, `>|`, ata/dizin hedefli silme-taşıma-kopyalama, `cd <korunan kök>` sonrası göreli yazma
const failclosedDeny = [
  "echo x > ~/.claude/settings.js[[:alpha:][:digit:]]n", `tee ${VH}/vlad.config.js[[:alpha:][:digit:]]n`, `tee ${VH}/dist/hook[[:alpha:][:digit:]]/push-guard`, "bash -c 'tee ~/.claude/settings.js[[.o.]]n'", "echo x > ~/.claude/settings.js[[=o=]]n",
  "echo x > ~/.cl(a|x)ude/settings.json", "tee ~/.claude/settings.(json|x)", `tee ${VH}/vlad.config.(json|x)`, `tee ${VH}/dist/(hooks|x)/push-guard`, "bash -c 'echo x > ~/.cl(a|x)ude/settings.json'",
  "echo x >| ~/.claude/settings.json", `echo x >| ${VH}/vlad.config.json`, `echo x >|${KB}/mode.json`, `echo x 1>| ${VH}/dist/hooks/a.js`,
  `rm -rf ${VH}/dist`, `rm -rf ${VH}/di*`, `cp -r hooks ${VH}/di?t`, "cp settings.json ~/.claude/", "cp -t ~/.claude settings.json", "rm -rf ~/.claude", "mv ~/.cla* ~/old", `rm -rf ${KB}`, `rm -rf ${VH}`, `mv ${VH}/dist ${VH}/x`, `install -t ${VH}/dist/hooks x`,
  "cd ~/.claude 2>&1 && tee settings.json", "{ cd ~/.claude; tee settings.json; }", "builtin cd ~/.claude && tee settings.json", "cd $SOMEWHERE && tee settings.json", "tee ~/(.claude|x)/settings.json", "tee ~/(.claude/settings.json|x)", `tee ${VH}/(dist/hooks|x)/a.js`,
  "tar -xf x.tar -C ~/.claude", "unzip x.zip -d ~/.claude",
  "cd ~/.claude && echo x > settings.json", `cd ${VH} && echo x > vlad.config.json`, `cd ${VH}/dist/hooks && cp x push-guard-hook.js`, `cd ${KB}; echo x > mode.json`, "pushd ~/.claude; tee settings.local.json",
];
const failclosedAllow = ["echo x >| out.txt", "echo x | tee out.txt", "echo x >| /dev/null", "echo $(date) > out.txt", "rm -rf build", "cp -r a b", "cp x src/", "cd src && echo x > a.json", `cd ${VH} && cat vlad.config.json`, "cd ~/.claude && ls", "cd $X && make > log.txt", "cd src 2>&1 && tee a.json", "tar -xf x.tar -C out",
  "ls ~/.claude", "tee src/[[:alpha:][:digit:]]x.ts", "(cd src && ls)", "tee src/(a|b).ts", `cp x ${VH}/src`, "echo x > *.json", "tee out-?.txt", "echo x > {a,b}.ts", "echo '*.json' > notes.txt"];
const foldedWriters = [(t) => `ſed -i '' s/a/b/ ${t}`, (t) => `baſh -c 'echo x > ${t}'`, (t) => `inſtall /tmp/a ${t}`];

// --- vakalar ---
const cases = [];
const J = (o) => JSON.stringify(o);
const add = (group, s, input, expect, extra = {}) => cases.push({ group, s, input, expect, ...extra });
const tool = (name, tool_input, s) => J({ tool_name: name, tool_input, ...(s.cwd === undefined ? {} : { cwd: s.cwd }) });
const pushExpect = (s, target) => {
  if (!s.worker || !s.validated) return s.worker ? undefined : 0; // ana oturum: serbest; dizinle tanınan çalışan: push doğrulanmaz (spec) → kâhin yok
  if (target === null) return 0;
  if (target === "bad") return 2;
  return s.id === null || s.id === target ? 0 : 2;
};
const hasBackslash = (t) => t.includes("\\");
for (const s of sessions) {
  for (const [cmd, target] of pushCmds) add("push", s, tool("Bash", { command: cmd }, s), pushExpect(s, target));
  for (const cmd of shortcutCmds) add("push-shortcut", s, tool("Bash", { command: cmd }, s), undefined);
  for (const [name, t, blocked] of targets) {
    const e = s.worker ? (blocked ? 2 : 0) : 0;
    for (const tn of ["Write", "Edit", "MultiEdit"]) add(`yazma:${name}`, s, tool(tn, { file_path: t, content: "x" }, s), e);
    add(`yazma:${name}`, s, tool("NotebookEdit", { notebook_path: t }, s), e);
    for (const w of bashWriters) add(`bash-yazma:${name}`, s, tool("Bash", { command: w(t) }, s), hasBackslash(t) ? undefined : e);
    for (const w of quotedWriters) add(`bash-yazma:${name}`, s, tool("Bash", { command: w(t) }, s), e);
  }
  for (const [name, t, blocked] of targets) {
    const e = s.worker ? (blocked ? 2 : 0) : 0;
    for (const v of foldVariants(t)) {
      for (const tn of ["Write", "NotebookEdit"]) add(`apfs-katlama:${name}`, s, tool(tn, tn === "Write" ? { file_path: v, content: "x" } : { notebook_path: v }, s), e);
      for (const w of [...bashWriters.slice(0, 6), ...quotedWriters]) add(`apfs-katlama:${name}`, s, tool("Bash", { command: w(v) }, s), hasBackslash(v) && !quotedWriters.includes(w) ? undefined : e);
    }
    for (const w of foldedWriters) add(`apfs-komut:${name}`, s, tool("Bash", { command: w(t) }, s), hasBackslash(t) ? undefined : e);
  }
  for (const [name, t, blocked] of targets) {
    const e = s.worker ? (blocked ? 2 : 0) : 0;
    for (const v of jokerVariants(t)) {
      add(`joker-korunan:${name}`, s, tool("Write", { file_path: v, content: "x" }, s), e);
      for (const w of [...bashWriters.slice(0, 6), quotedWriters[0]]) add(`joker-korunan:${name}`, s, tool("Bash", { command: w(v) }, s), e);
    }
  }
  for (const v of jokerBenign) for (const w of bashWriters.slice(0, 6)) add("joker-zararsız", s, tool("Bash", { command: w(v) }, s), 0);
  for (const cmd of failclosedDeny) add("failclosed-ret", s, tool("Bash", { command: cmd }, s), s.worker ? 2 : 0);
  for (const cmd of failclosedAllow) add("failclosed-izin", s, tool("Bash", { command: cmd }, s), 0);
  for (const [inp, e] of [[{ file_path: "~/.vlad-ſecret/mode.key" }, 2], [{ file_path: join(SECRET, "mode.Key") }, 2], [{ file_path: join(WT, "src", "ſettings.json") }, 0]])
    add("apfs-okuma", s, tool("Read", inp, s), s.worker ? e : 0);
  for (const [name, t, bashBlocked] of benignTargets) {
    for (const tn of ["Write", "Edit"]) add(`zararsız:${name}`, s, tool(tn, { file_path: t, content: "x" }, s), 0);
    for (const w of bashWriters.slice(0, 6)) add(`zararsız:${name}`, s, tool("Bash", { command: w(t) }, s), s.worker && bashBlocked ? 2 : 0);
  }
  for (const [cmd, target] of upperCmds) add("push-büyükharf", s, tool("Bash", { command: cmd }, s), pushExpect(s, target));
  for (const cmd of upperNoOracle) add("push-büyükharf-kâhinsiz", s, tool("Bash", { command: cmd }, s), undefined);
  for (const [name, t] of probeTargets) {
    add(`soru:${name}`, s, tool("Write", { file_path: t, content: JSON.stringify({ kbDir: "/tmp/sahte-kb" }) }, s), s.worker ? 2 : 0);
    add(`soru:${name}`, s, tool("Bash", { command: `echo '{}' > ${t}` }, s), s.worker ? 2 : 0);
  }
  // okuma: yalnız gizli dizin reddedilir
  for (const [inp, e] of [[{ file_path: join(SECRET, "mode.key") }, 2], [{ file_path: "~/.vlad-secret/mode.key" }, 2], [{ file_path: join(WT, "src", "a.ts") }, 0], [{ file_path: join(KB, "mode.json") }, 0]])
    add("okuma", s, tool("Read", inp, s), s.worker ? e : 0);
  for (const [tn, inp, e] of [["Grep", { pattern: "x", path: SECRET }, 2], ["Glob", { pattern: "~/.vlad-secret/*" }, 2], ["Glob", { pattern: "**/*.ts", path: WT }, 0], ["Grep", { pattern: "mode", path: join(WT, "src") }, 0]])
    add("okuma", s, tool(tn, inp, s), s.worker ? e : 0);
  // mod komutu
  for (const [cmd, e] of [["vlad mode off", 2], ["vlad mode night", 2], ["env -u VLAD_TASK_ID vlad mode off", 2], ["vlad mode status", 0], ["bash -c 'vlad mode watch'", 2]])
    add("mod", s, tool("Bash", { command: cmd }, s), s.worker ? e : 0);
  // diğer araçlar: kancanın kapsamı dışı (F-vlad-395: PowerShell kapsanmıyor; yalnız fark)
  for (const tn of ["PowerShell", "Task", "WebFetch", "bash"]) add("kapsam-dışı", s, tool(tn, { command: "git push --force origin main", file_path: join(KB, "mode.json") }, s), undefined);
}
// bozuk/kesik JSON, boş ve çok büyük stdin: süreç cwd'si ve ortam oturumdan
const ws = sessions.find((x) => x.name === "çalışan-env"), ms = sessions.find((x) => x.name === "ana"), ds = sessions.find((x) => x.name === "çalışan-dal");
const seeds = [
  [tool("Bash", { command: "git push --force origin main" }, ws), "push"], [tool("Bash", { command: `git push origin vlad/${OWN}` }, ws), "push"],
  [tool("Write", { file_path: join(KB, "mode.json"), content: "{}" }, ws), "mode"], [tool("Read", { file_path: join(WT, "a.ts") }, ws), "read"],
  [tool("Bash", { command: "ls -la" }, ws), "plain"], [tool("Edit", { file_path: join(homedir(), ".claude", "settings.json") }, ws), "settings"],
  [tool("Bash", { command: "echo x > ~/.claude/ſettings.json" }, ws), "apfs"],
];
for (const s of [ws, ms, ds]) {
  for (const [full, kind] of seeds) {
    // her kesim noktası: JSON.parse hata → catch yolu (çalışanda okuma/yazma aracıysa koşulsuz ret, push/mode kelimesi varsa ret)
    for (let k = 0; k < full.length; k += 3) add(`kesik:${kind}`, s, full.slice(0, k), undefined);
    add(`bozuk:${kind}`, s, full + "}", undefined); add(`bozuk:${kind}`, s, "\ufeff" + full, undefined); add(`bozuk:${kind}`, s, full.replace(/"/g, "'"), undefined);
  }
  add("boş-stdin", s, "", 0); add("boş-stdin", s, " \n\t", 0); add("boş-stdin", s, "null", 0); add("boş-stdin", s, "{}", 0); add("boş-stdin", s, "[]", 0);
}
// kesik push girdisi: ham metinde git…push geçtiği an (oturumdan bağımsız) ret beklenir
{
  const full = tool("Bash", { command: "git push --force origin main" }, ws);
  const from = full.indexOf("push") + 4;
  for (const s of [ws, ms, ds]) for (let k = from; k < full.length; k++) add("kesik-push-kâhin", s, full.slice(0, k), 2);
}
// çok büyük stdin
const big = (n) => "a".repeat(n);
for (const s of [ws, ms]) {
  for (const n of [1 << 20, 8 << 20]) {
    add("büyük:yazma-zararsız", s, tool("Write", { file_path: join(WT, "src", "big.txt"), content: big(n) }, s), 0, { slow: true });
    add("büyük:yazma-mode", s, tool("Write", { file_path: join(KB, "mode.json"), content: big(n) }, s), s.worker ? 2 : 0, { slow: true });
    add("büyük:bash-push", s, tool("Bash", { command: `echo ${big(n)}; git push --force origin main` }, s), s.worker ? 2 : 0, { slow: true });
    add("büyük:bash-zararsız", s, tool("Bash", { command: `echo ${big(n)}` }, s), 0, { slow: true });
    add("büyük:kesik", s, tool("Bash", { command: `echo ${big(n)}; git push --force origin main` }, s).slice(0, -3), 2, { slow: true });
  }
}

// Bilinçli kırmızı (grup → neden): politikanın açık olduğu ama iki kancanın da (TS ve Rust aynı) uymadığı vakalar; rapor "Kırmızı bırakılan testler".
// Düzeltme TS+Rust'ta birlikte yapılınca buradan silinir; --strict bunları da çıkış 1 sayar.
// T20261128-01: push-büyükharf (F-vlad-405) ve soru:vlad.config.local.json (F-vlad-406) düzeltildi, listeden çıkarıldı.
const KNOWN_RED = {};
const STRICT = process.argv.includes("--strict");

// --- koşu ---
const envFor = (e) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ...e });
const runOne = (bin, c) => new Promise((res) => {
  const [cmd, args] = bin === "ts" ? [process.execPath, [TS]] : [RS, []];
  const t0 = process.hrtime.bigint();
  const p = spawn(cmd, args, { cwd: c.s.proc, env: envFor(c.s.env), stdio: ["pipe", "ignore", "pipe"] });
  let err = "";
  p.stderr.setEncoding("utf8"); p.stderr.on("data", (d) => (err += d));
  const t = setTimeout(() => p.kill("SIGKILL"), 30000);
  p.on("close", (code, sig) => { clearTimeout(t); res({ code: code ?? `sig:${sig}`, err, ms: Number(process.hrtime.bigint() - t0) / 1e6 }); });
  p.stdin.on("error", () => {});
  p.stdin.end(c.input);
});
const normErr = (r) => { const m = /^(push-guard hatası \(fail-closed\)|mod-koruma hatası \(fail-closed\)): /.exec(r.err); return m ? `${m[1]}: <istisna>` : r.err; };

const t0 = Date.now();
const mism = [], red = [], knownRed = [];
const groupStats = {};
const observe = {};
let next = 0;
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= cases.length) return;
    const c = cases[i];
    const [a, b] = await Promise.all([runOne("ts", c), runOne("rs", c)]);
    const g = (groupStats[c.group.split(":")[0]] ??= { n: 0, oracle: 0 });
    g.n++; if (c.expect !== undefined) g.oracle++;
    const show = (r) => ({ code: r.code, err: r.err.slice(0, 160), ms: Math.round(r.ms) });
    const brief = { i, group: c.group, session: c.s.name, input: c.input.length > 300 ? `${c.input.slice(0, 200)}…(${c.input.length} kr)` : c.input };
    if (a.code !== b.code || normErr(a) !== normErr(b)) mism.push({ ...brief, ts: show(a), rs: show(b) });
    // gözlem: push doğrulaması çalışmayan çalışan oturumları (yalnız dizinle tanınan) — kâhin yok, karar dağılımı rapora
    if (c.group === "push" && c.s.worker && !c.s.validated) { const o = (observe[c.s.name] ??= { allow: 0, block: 0, allow_force_main: false }); if (a.code === 0) o.allow++; else o.block++; if (a.code === 0 && c.input.includes('"command":"git push origin main"')) o.allow_force_main = true; }
    if (c.expect !== undefined && (a.code !== c.expect || b.code !== c.expect)) {
      (Object.hasOwn(KNOWN_RED, c.group) ? knownRed : red).push({ ...brief, expect: c.expect, ts: show(a), rs: show(b) });
    }
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
const oracleN = cases.filter((c) => c.expect !== undefined).length;
console.log(JSON.stringify({ cases: cases.length, with_oracle: oracleN, mismatches: mism.length, red: red.length, known_red: knownRed.length, seconds: (Date.now() - t0) / 1000, groups: groupStats }));
for (const m of mism.slice(0, VERBOSE ? Infinity : 20)) console.log("FARK", JSON.stringify(m));
const byKey = (xs) => { const o = {}; for (const r of xs) (o[`${r.group}|${r.session}`] ??= []).push(r); return o; };
for (const [k, xs] of Object.entries(byKey(red))) console.log("KIRMIZI", k, `(${xs.length})`, JSON.stringify(VERBOSE ? xs : xs.slice(0, 2)));
console.log("GÖZLEM push doğrulanmayan çalışan oturumları (TS kararı; allow_force_main = `git push origin main` geçti):", JSON.stringify(observe));
const knownByGroup = {};
for (const r of knownRed) (knownByGroup[r.group] ??= new Set()).add(r.session);
for (const [g, ss] of Object.entries(knownByGroup)) console.log("BİLİNEN-KIRMIZI", g, `(${knownRed.filter((r) => r.group === g).length} vaka; oturumlar: ${[...ss].join(", ")})`, "—", KNOWN_RED[g]);
for (const g of Object.keys(KNOWN_RED)) if (!knownByGroup[g]) console.log("DÜZELMİŞ?", g, "— kırmızı vaka kalmadı; KNOWN_RED'den sil");

// --- süre: sıralı, süreç başlatma dahil; ilk WARMUP koşu atılır; ana oturum ve çalışan yolu ayrı ---
function bench(bin, input, s) {
  const [cmd, args] = bin === "ts" ? [process.execPath, [TS]] : [RS, []];
  const xs = [];
  for (let i = 0; i < WARMUP + BENCH; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(cmd, args, { input, env: envFor(s.env), cwd: s.proc, stdio: ["pipe", "ignore", "ignore"] });
    const ms = Number(process.hrtime.bigint() - t) / 1e6;
    if (r.status === null) throw new Error(`bench süreci öldü: ${bin}`);
    if (i >= WARMUP) xs.push(ms);
  }
  xs.sort((x, y) => x - y);
  const q = (p) => Number(xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)].toFixed(2));
  return { p50: q(0.5), p95: q(0.95), max: Number(xs[xs.length - 1].toFixed(2)) };
}
if (BENCH > 0) {
  const sc = [
    ["ana oturum Bash", tool("Bash", { command: "git status && npm test" }, ms), ms],
    ["ana oturum Write", tool("Write", { file_path: join(MAIN, "a.ts"), content: "x" }, ms), ms],
    ["ana oturum Read", tool("Read", { file_path: join(MAIN, "a.ts") }, ms), ms],
    ["çalışan Bash", tool("Bash", { command: "git status && npm test" }, ws), ws],
    ["çalışan push (izinli)", tool("Bash", { command: `git push -u origin vlad/${OWN}` }, ws), ws],
    ["çalışan Write", tool("Write", { file_path: join(WT, "src", "a.ts"), content: "x" }, ws), ws],
    ["çalışan Read", tool("Read", { file_path: join(WT, "src", "a.ts") }, ws), ws],
    ["çalışan dal (env yok, git sorgusu)", tool("Bash", { command: "npm test" }, ds), ds],
  ];
  const out = {};
  for (const [name, input, s] of sc) out[name] = { rust: bench("rs", input, s), ts: bench("ts", input, s) };
  console.log(JSON.stringify({ bench_runs: BENCH, warmup_discarded: WARMUP, ms: out }));
}
process.exit(mism.length || red.length || (STRICT && knownRed.length) ? 1 : 0);
