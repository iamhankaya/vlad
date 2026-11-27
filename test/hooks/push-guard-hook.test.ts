import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runSpawn } from "../support/spawn-vlad.js";

// madde 3: hook fail-closed. dist gate'te derlenir (build → vitest).
const hook = resolve(__dirname, "../../dist/hooks/push-guard-hook.js");
const run = (stdin: string, env: Record<string, string> = { VLAD_TASK_ID: "T20261112-10" }) =>
  runSpawn(process.execPath, [hook], { input: stdin, env, timeoutMs: 15000 });
const payload = (command: string) => JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/" });

describe.skipIf(!existsSync(hook))("push-guard hook (PreToolUse)", () => {
  it("çalışanda kendi dalı geçer (0), vlad/x:main ve timeout sarmalı reddedilir (2)", () => {
    expect(run(payload("git push -u origin vlad/T20261112-10")).status).toBe(0);
    for (const c of ["git push origin vlad/T20261112-10:main", "timeout 30 git push origin vlad/T20261112-10:main", "git -c remote.origin.pushurl=/x push origin vlad/T20261112-10"]) {
      const r = run(payload(c));
      expect(r.status, c).toBe(2);
      expect(r.stderr).toMatch(/reddedildi/);
    }
  });
  it("çalışan olmayan oturumda dokunmaz", () => {
    expect(run(payload("git push origin main"), {}).status).toBe(0);
  });
  it("K1 (T20261127-25): 5×60 brace grubu kancayı askıda bırakmaz; ardından gelen push yine reddedilir (2)", () => {
    const g = `{${Array.from({ length: 60 }, (_, i) => `a${i}`).join(",")}}`;
    const t0 = Date.now();
    const r = runSpawn(process.execPath, [hook], { input: payload(`ls /${g.repeat(5)}; git push -f origin main`), env: { VLAD_TASK_ID: "T20261112-10" }, timeoutMs: 5000 });
    expect(r.status).toBe(2);
    expect(Date.now() - t0).toBeLessThan(2000); // hedef < 1 sn; yük altındaki gate için pay
  });
  it("bozuk JSON: ham girdi git…push içeriyorsa fail-closed (2), içermiyorsa 0", () => {
    expect(run('{"tool_input":{"command":"git push origin main"').status).toBe(2);
    expect(run("{bozuk").status).toBe(0);
    expect(run('{"tool_input":{"command":"GIT PUSH --force origin main"').status).toBe(2); // F-vlad-405: catch yolu da harf duyarsız
    expect(run(payload("GIT push --force origin main")).status).toBe(2);
    expect(run('{"tool_name":"Bash","tool_input":{"command":"echo x > ~/.claude/ſettings.json"').status).toBe(2); // K1: catch yolu kelime denetimi de APFS katlamalı
    expect(run(payload("echo x > ~/.claude/ſettings.json")).status).toBe(2);
    // review K1-5: catch yolundaki ikinci FOLD tablosu mode-guard.ts fold ile aynı kalmalı (K, ﬁ, ﬆ, ſ kelime eşleşmesi)
    for (const w of ["x/diſt/hooKs/a", "vlad.conﬁg.json", "diﬆ.hooks/a", "~/.vlad-ſecret/k", "mode.jſon"])
      expect(run(`{"tool_name":"Bash","tool_input":{"command":"echo x > ${w}"`).status, w).toBe(2);
  });
});
