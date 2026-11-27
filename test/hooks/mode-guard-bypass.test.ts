import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { setSecretDirForTests } from "../../src/mode/token.js";
import { runSpawn } from "../support/spawn-vlad.js";
import { IS_WIN } from "../support/platform.js";

// T20261116-18 değişiklik turu: kapı bulgularındaki bypass'lar. Yalnız geçici dizin; gerçek ~/.vlad-secret'a dokunulmaz.
let root: string, secret: string, cwd: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-bypass-")));
  secret = join(root, ".vlad-secret"); cwd = join(root, "wt");
  mkdirSync(join(secret, "approver"), { recursive: true }); mkdirSync(cwd);
  writeFileSync(join(secret, "mode.key"), "k");
  setSecretDirForTests(secret);
});
afterEach(() => setSecretDirForTests(null));
const run = (tool: string, input: Record<string, unknown>, at = cwd) => checkWorkerMode(tool, input, null, { vladHome: "/home/u/vlad", cwd: at });

describe("Bash gizli dizin metin reddi (F-vlad-350 gevşetmesi geri alındı: Codex 2×P1; komut metninde gizli dizin adı geçmesi ret sebebidir)", () => {
  const bash = (command: string, at = cwd) => checkWorkerMode("Bash", { command }, null, { vladHome: "/home/u/vlad", cwd: at });
  it("gerçek yol/joker/değişken/cd kaçışları reddedilir", () => {
    for (const c of [`cat ${secret}/mode.key`, "cat ~/.vlad-secret/mode.key", `cat "${root}/.vlad-sec"ret/mode.key`, `cat ${secret}/*`, "cat ../.vlad-secret/mode.key", `cd ${root} && cat .vlad-secret/mode.key`, "cd ~ && cat .vlad-secret/mode.key", `D=${root}; cat $D/.vlad-secret/mode.key`, `echo x; cat $(echo ${secret})/mode.key`])
      expect(bash(c), c).not.toBeNull();
    expect(bash("cat .vlad-secret/mode.key", root)).not.toBeNull(); // cwd HOME iken göreli yol gerçekten gizli dizin
  });
  it("Codex bypass örnekleri: göreli glob/brace, ./.. dolaşımı, bitişik -f<mutlak yol>", () => {
    const name = root.split("/").pop()!;
    for (const c of ["cat ../*/.vlad-secret/mode.key", `cat ../{${name},foo}/.vlad-secret/mode.key`, `cat ./../${name}/.vlad-secret/mode.key`, "cat ..//*/.vlad-secret/*", "cat ../?*/.vlad-secret/x", "cat ../[a-z]*/.vlad-secret/x", `grep -f${secret}/mode.key /dev/null`])
      for (const at of [cwd, root]) expect(bash(c, at), `${at}: ${c}`).not.toBeNull();
  });
});

describe("(1) Grep/Glob kök verilmezse etkin kök cwd'dir", () => {
  it("cwd gizli dizinin atasıysa path'siz Grep/Glob reddedilir; cwd worktree ise serbest", () => {
    expect(run("Grep", { pattern: "." }, root)).not.toBeNull();
    expect(run("Glob", { pattern: "**/mode.key" }, root)).not.toBeNull();
    expect(run("Grep", { pattern: "." })).toBeNull();
  });
});

describe("(2) Glob göreli pattern araç path'ine göre de çözülür; '..' segmenti reddedilir", () => {
  it("path=worktree, pattern ../.vlad-secret/* (cwd'ye göre başka yer, path'e göre gizli dizin) reddedilir", () => {
    const deep = join(cwd, "a"); mkdirSync(deep);
    expect(run("Glob", { pattern: "../.vlad-secret/*", path: cwd }, deep)).not.toBeNull(); // path'e göre → root/.vlad-secret
    expect(run("Glob", { pattern: "../.vlad-secret/mode.key", path: cwd })).not.toBeNull();
  });
  it("jokerli pattern'de '..' segmenti doğrudan reddedilir", () => {
    expect(run("Glob", { pattern: "**/../x/*" })).not.toBeNull();
    expect(run("Grep", { pattern: "x", glob: "*/../*.ts" })).not.toBeNull();
    expect(run("Glob", { pattern: "src/**/*.ts" })).toBeNull();
  });
});

describe("(3) yazma araçları da tam realpath kullanır (symlink s -> gizli dizin)", () => {
  // Windows'ta atlanır: symlink oluşturma ayrıcalık ister (EPERM; Windows'ta geliştirici modu/yönetici gerekir)
  it.skipIf(IS_WIN)("Write/Edit/MultiEdit/NotebookEdit s/mode.key reddedilir; dangling symlink de", () => {
    symlinkSync(secret, join(cwd, "s"));
    symlinkSync(join(secret, "yeni.json"), join(cwd, "dangling"));
    for (const t of ["Write", "Edit", "MultiEdit"]) { expect(run(t, { file_path: "s/mode.key" }), t).not.toBeNull(); expect(run(t, { file_path: "dangling" }), `${t} dangling`).not.toBeNull(); }
    expect(run("NotebookEdit", { notebook_path: "s/x.ipynb" })).not.toBeNull();
    expect(run("Write", { file_path: "ok.txt" })).toBeNull();
  });
});

describe("(4) Bash: dot-dizin jokerleri ve ln -s hedefi gizli dizine açılamaz", () => {
  const c = (cmd: string) => run("Bash", { command: cmd });
  it("jokerle gizli dizine açılan komutlar reddedilir", () => {
    for (const cmd of [`cat ${root}/.v*/mode.key`, `cat ${root}/.vlad-*/mode.key`, `cat ${root}/.*/mode.key`, `cat ${root}/.[v]lad-secret/mode.key`, `cat ${root}/.vlad-{secret,x}/mode.key`, `ln -s ${root}/.vlad-sec* x`, `cat ${root}/.?lad-secret/mode.key`])
      expect(c(cmd), cmd).not.toBeNull();
  });
  it("K1 (T20261128-01): APFS ad eşdeğerli joker (ſ, K) ve ß içeren ev dizini gizli dizine açılamaz", () => {
    for (const cmd of [`cat ${root}/.v*-ſecret/mode.key`, `cat ${root}/.vlad-ſec*/mode.key`, `ls ${root}/.vlad-{ſecret,x}`, `cat ${root}/.vlad-ſecret/mode.Key`]) expect(c(cmd), cmd).not.toBeNull();
    const ev = join(root, "straß"); mkdirSync(join(ev, ".vlad-secret"), { recursive: true }); setSecretDirForTests(join(ev, ".vlad-secret"));
    for (const cmd of [`cat ${root}/strass/.v*/mode.key`, `cat ${root}/straſſ/.vlad-*/mode.key`]) expect(c(cmd), cmd).not.toBeNull();
    expect(run("Read", { file_path: join(root, "strass", ".vlad-secret", "mode.key") })).not.toBeNull();
  });
  it("ilgisiz joker ve normal komutlar serbest", () => {
    for (const cmd of [`ls ${root}/*.txt`, `cat ${root}/.gitignore`, `ls ${root}/wt/*`, "grep -r '.*' src", "ls ~/dev/*"]) expect(c(cmd), cmd).toBeNull();
  });
});

describe("(5) hook catch yolu: çalışanda dosya araçları için koşulsuz fail-closed", () => {
  const hook = join(import.meta.dirname, "..", "..", "dist", "hooks", "push-guard-hook.js");
  const broken = (tool: string) => runSpawn(process.execPath, [hook], { input: `{"tool_name":"${tool}","tool_input":{"file_path":"x"`, env: { VLAD_TASK_ID: "T20261116-99" }, cwd: tmpdir() });
  it("bozuk girdi: Read/Grep/Glob/Edit/Write/NotebookEdit çalışanda çıkış 2", () => {
    for (const t of ["Read", "Grep", "Glob", "Edit", "Write", "NotebookEdit", "MultiEdit"]) expect(broken(t).status, t).toBe(2);
  });
  it("ana oturumda (VLAD_TASK_ID yok) engellemez", () => {
    const r = runSpawn(process.execPath, [hook], { input: `{"tool_name":"Read","tool_input":{"file_path":"x"`, cwd: tmpdir() });
    expect(r.status).toBe(0);
  });
});
