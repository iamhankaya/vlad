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
  it("bozuk JSON: ham girdi git…push içeriyorsa fail-closed (2), içermiyorsa 0", () => {
    expect(run('{"tool_input":{"command":"git push origin main"').status).toBe(2);
    expect(run("{bozuk").status).toBe(0);
  });
});
