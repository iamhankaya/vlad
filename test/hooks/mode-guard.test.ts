import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { runSpawn } from "../support/spawn-vlad.js";

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KB = "/home/u/vlad-kb";
const HOME = "/home/u/vlad";
const ctx = { vladHome: HOME, cwd: "/work/wt" };
const bash = (command: string) => checkWorkerMode("Bash", { command }, KB, ctx);
const edit = (tool: string, file_path: string) => checkWorkerMode(tool, { file_path }, KB, ctx);

describe("F-vlad-287: çalışan mod koruması (PreToolUse, env/cwd'den bağımsız komut kalıbı)", () => {
  it("Bash: mod yazan komutlar reddedilir (env -u, node cli.js, boşluk, tırnak, zincir)", () => {
    for (const c of ["vlad mode off", "env -u VLAD_TASK_ID vlad mode off", "cd / && vlad mode night --until 23:00", "node /x/dist/cli.js mode watch on", "vlad   mode  off", `v"la"d mode off`, "vlad \\\nmode off", "true; vlad mode off", "node cli.js mode off"])
      expect(bash(c), c).toMatch(/mod/);
  });
  it("Bash: status ile başlayan zincirde sonraki vlad mode da denetlenir; Windows shim / ts / kök seçenek biçimleri yakalanır", () => {
    for (const c of ["vlad mode status && vlad mode off", "vlad mode status\nvlad mode off", "vlad mode status | cat; vlad mode off", "vlad mode status; vlad mode off", "vlad.cmd mode off", "vlad.exe mode off", "npx tsx src/cli.ts mode off", "vlad --json mode off", "vlad -q mode night"])
      expect(bash(c), c).toMatch(/mod/);
    expect(bash("vlad mode status; echo ok")).toBeNull();
  });
  it("Bash: mode.json yalnız okuma/arama bağlamında (grep, git diff, cat) geçerse serbest; yazma bağlamı reddedilir", () => {
    for (const c of ["grep -r mode.json src", "git diff -- src/mode/mode.json", `cat ${KB}/mode.json`]) expect(bash(c), c).toBeNull();
    for (const c of [`echo x >${KB}/mode.json`, `tee ${KB}/mode.json`, `mv a ${KB}/mode.json`, `python3 -c "open('mode.json','w')"`, `truncate -s0 ${KB}/mode.json`]) expect(bash(c), c).toMatch(/mode\.json/);
  });
  it("Bash: mode.json'a dokunan her komut reddedilir (echo >, cp, sed, tırnaklı ad)", () => {
    for (const c of [`echo '{}' > ${KB}/mode.json`, `cp x ${KB}/mode.json`, `sed -i s/a/b/ ${KB}/MODE.JSON`, `echo x > ${KB}/mo"de.j"son`, "rm $KB/mode.json"])
      expect(bash(c), c).toMatch(/mode\.json/);
  });
  it("Bash: salt okuma ve ilgisiz komutlar geçer (vlad mode status, task log, 'mode' kelimesi)", () => {
    for (const c of ["vlad mode status", "vlad task log T1 x", "git status", "echo mode", "npm run build", "vlad mode status --json"]) expect(bash(c), c).toBeNull();
  });
  it("Edit/Write/MultiEdit/NotebookEdit: kb mode.json yolu reddedilir (büyük harf, .. dolaşımı), başka dosya geçer", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      expect(edit(t, `${KB}/mode.json`), t).toMatch(/mode\.json/);
      expect(edit(t, `${KB}/sub/../MODE.json`), t).toMatch(/mode\.json/);
      expect(edit(t, `${KB}/tasks/T1.md`), t).toBeNull();
      expect(edit(t, "/work/wt/src/mode.json"), t).toBeNull(); // projenin kendi mode.json'u (kb dışı)
    }
  });
  it("korunan yollar: .claude/settings(.local).json, <vladHome>/dist/hooks/**, <vladHome>/vlad.config.json — Edit/Write ve Bash yazma bağlamı reddedilir", () => {
    const prot = ["/Users/x/.claude/settings.json", "/Users/x/.claude/settings.local.json", "/work/wt/.claude/settings.json", "~/.claude/settings.json", `${HOME}/dist/hooks/push-guard-hook.js`, `${HOME}/dist/hooks/sub/x.js`, `${HOME}/vlad.config.json`];
    for (const p of prot) for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) expect(edit(t, p), `${t} ${p}`).toMatch(/koruma|mod/);
    for (const p of prot) for (const c of [`sed -i s/a/b/ ${p}`, `echo {} > ${p}`, `tee ${p}`, `cp x ${p}`, `mv x ${p}`, `jq . ${p} | sponge ${p}`, `python3 -c "open('${p}','w')"`, `node -e "require('fs').writeFileSync('${p}','')"`, `truncate -s0 ${p}`]) expect(bash(c), c).toMatch(/koruma|mod/);
    for (const p of ["/work/wt/src/settings.json", `${HOME}/dist/cli.js`, `${HOME}/src/vlad.config.json`, "/work/wt/vlad.config.json"]) expect(edit("Edit", p), p).toBeNull(); // .claude dışı / hooks dışı / vladHome dışı
    for (const c of [`cat ${HOME}/vlad.config.json`, "cat ~/.claude/settings.json", "grep hooks ~/.claude/settings.json", `ls ${HOME}/dist/hooks`, "sed -n 1,40p ~/.claude/settings.json 2>&1"]) expect(bash(c), c).toBeNull();
  });
  it("joker hedefler (mod?.json, m*e.json, mode.jso[n]) ve kb dizini altına yazma reddedilir; *.json / rm * çalışanın kendi dosyaları serbest", () => {
    for (const c of [`rm ${KB}/mod?.json`, `echo x > ${KB}/m*e.json`, `cp x ${KB}/mode.jso[n]`, `truncate -s0 ${KB}/mo?e.json`, `echo x > ${KB}/tasks/T1.md`, `tee ${KB}/findings/F1.md`, `mv a ${KB}/x`]) expect(bash(c), c).not.toBeNull();
    for (const c of ["rm *.json", "rm -rf build/*", `cat ${KB}/tasks/T1.md`, `grep x ${KB}/tasks/T1.md > /tmp/out.txt`]) expect(bash(c), c).toBeNull();
  });
  it("komut konumu: git grep / commit -m / task log içindeki 'vlad mode off' ve mode.json okuma serbest; bash -c / eval / sarmalayıcı / $( ) içindekiler reddedilir", () => {
    for (const c of [`git grep 'vlad mode off'`, `git commit -m "docs: vlad mode off notu"`, `git commit -m "a; vlad mode off"`, `vlad task log T1 'vlad mode off'`, `echo "vlad mode night"`, `sed -n '1,80p' ${KB}/mode.json`, `cat ${KB}/mode.json 2>&1`, `grep -n night ${KB}/mode.json 2>/dev/null`])
      expect(bash(c), c).toBeNull();
    for (const c of [`bash -c 'vlad mode off'`, `sh -c "cd / && vlad mode night"`, `eval "vlad mode off"`, `echo $(vlad mode off)`, "echo `vlad mode off`", `(vlad mode off)`, `FOO=1 vlad mode off`, `sudo vlad mode off`, `a || vlad mode off`, `x | vlad mode off`, `bash -c "bash -c 'vlad mode off'"`])
      expect(bash(c), c).toMatch(/mod/);
  });
  it("ret mesajı yol gösterir (ana VLAD'san ana repo dizininden çalıştır)", () => {
    expect(bash("vlad mode off")).toMatch(/ana VLAD'san ana repo dizininden/);
    expect(edit("Write", `${KB}/mode.json`)).toMatch(/vlad task ask/);
  });
  it("kb dizini çözülemezse mode.json adlı her yazma reddedilir (fail-closed)", () => {
    expect(checkWorkerMode("Write", { file_path: "/herhangi/mode.json" }, null)).toMatch(/mode\.json/);
  });
});

const hook = resolve(__dirname, "../../dist/hooks/push-guard-hook.js");
const run = (payload: object, env: Record<string, string>) => runSpawn(process.execPath, [hook], { input: JSON.stringify(payload), env: { VLAD_KB_DIR: KB, ...env }, timeoutMs: 15000 });

describe.skipIf(!existsSync(hook))("F-vlad-287: hook uçtan uca", () => {
  const W = { VLAD_TASK_ID: "T20261113-12" };
  it("çalışan: worktree dışı cwd'den vlad mode off, mode.json'a Write/Edit reddedilir (2)", () => {
    expect(run({ tool_name: "Bash", tool_input: { command: "env -u VLAD_TASK_ID vlad mode off" }, cwd: "/" }, W).status).toBe(2);
    for (const t of ["Write", "Edit", "MultiEdit"]) expect(run({ tool_name: t, tool_input: { file_path: `${KB}/mode.json` }, cwd: "/" }, W).status, t).toBe(2);
  });
  it("env'siz ama cwd <repo>-wt/T… worktree'si: yine çalışan sayılır (2)", () => {
    expect(run({ tool_name: "Bash", tool_input: { command: "vlad mode off" }, cwd: "/nope/vlad-wt/T20261113-12" }, {}).status).toBe(2);
  });
  it("regresyon: ana oturum / kullanıcı terminali (çalışan değil) vlad mode ve mode.json yazımı serbest (0)", () => {
    expect(run({ tool_name: "Bash", tool_input: { command: "vlad mode night --until 23:00" }, cwd: "/" }, {}).status).toBe(0);
    expect(run({ tool_name: "Write", tool_input: { file_path: `${KB}/mode.json` }, cwd: "/" }, {}).status).toBe(0);
  });
  it("catch fail-closed: bozuk JSON + mod/settings geçiyor + yalnız <repo>-wt/T… dizininden tanınan çalışan → 2; çalışan olmayan cwd → 0", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "mg-")));
    const wt = join(base, "vlad-wt", "T20261113-12"); mkdirSync(wt, { recursive: true });
    const other = join(base, "other"); mkdirSync(other);
    const bad = '{"tool_input":{"command":"vlad mode off"';
    expect(runSpawn(process.execPath, [hook], { input: bad, env: {}, cwd: wt, timeoutMs: 15000 }).status).toBe(2);
    expect(runSpawn(process.execPath, [hook], { input: bad, env: {}, cwd: other, timeoutMs: 15000 }).status).toBe(0);
  });
  it("çalışan: Write ile ~/.claude/settings.json ve hook dosyasına yazım reddedilir (2)", () => {
    for (const p of ["/Users/x/.claude/settings.json", "/Users/x/.claude/settings.local.json"]) expect(run({ tool_name: "Write", tool_input: { file_path: p }, cwd: "/" }, W).status, p).toBe(2);
    expect(run({ tool_name: "Edit", tool_input: { file_path: "/Users/x/.claude/settings.json" }, cwd: "/" }, {}).status).toBe(0); // çalışan değil
  });
  it("çalışan: ilgisiz Edit ve vlad mode status geçer (0)", () => {
    expect(run({ tool_name: "Edit", tool_input: { file_path: "/w/a.ts" }, cwd: "/" }, W).status).toBe(0);
    expect(run({ tool_name: "Bash", tool_input: { command: "vlad mode status" }, cwd: "/" }, W).status).toBe(0);
  });
});
