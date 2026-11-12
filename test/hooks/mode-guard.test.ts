import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkWorkerMode } from "../../src/hooks/mode-guard.js";
import { runSpawn } from "../support/spawn-vlad.js";

const KB = "/home/u/vlad-kb";
const bash = (command: string) => checkWorkerMode("Bash", { command }, KB);
const edit = (tool: string, file_path: string) => checkWorkerMode(tool, { file_path }, KB);

describe("F-vlad-287: çalışan mod koruması (PreToolUse, env/cwd'den bağımsız komut kalıbı)", () => {
  it("Bash: mod yazan komutlar reddedilir (env -u, node cli.js, boşluk, tırnak, zincir)", () => {
    for (const c of ["vlad mode off", "env -u VLAD_TASK_ID vlad mode off", "cd / && vlad mode night --until 23:00", "node /x/dist/cli.js mode watch on", "vlad   mode  off", `v"la"d mode off`, "vlad \\\nmode off", "true; vlad mode off", "node cli.js mode off"])
      expect(bash(c), c).toMatch(/mod/);
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
  it("çalışan: ilgisiz Edit ve vlad mode status geçer (0)", () => {
    expect(run({ tool_name: "Edit", tool_input: { file_path: "/w/a.ts" }, cwd: "/" }, W).status).toBe(0);
    expect(run({ tool_name: "Bash", tool_input: { command: "vlad mode status" }, cwd: "/" }, W).status).toBe(0);
  });
});
