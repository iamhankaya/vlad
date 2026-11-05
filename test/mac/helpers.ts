import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const SCRIPTS = join(process.cwd(), "scripts", "mac");

export interface Sandbox { root: string; home: string; bin: string; log: string; env: Record<string, string> }

/** Temp HOME + sahte komut dizini; gerçek HOME/PATH/launchctl/pmset'e dokunmaz. */
export function sandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-mac-")));
  const home = join(root, "home"); const bin = join(root, "bin"); const log = join(root, "calls.log");
  mkdirSync(home, { recursive: true }); mkdirSync(bin); writeFileSync(log, "");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: "tester", LOGNAME: "tester", VLAD_CALL_LOG: log, TZ: "UTC" };
  return { root, home, bin, log, env };
}

/** bin/<name> sahte komutu: çağrıyı log'a yazar, body ile devam eder. */
export function stub(s: Sandbox, name: string, body = "exit 0"): void {
  const p = join(s.bin, name);
  writeFileSync(p, `#!/bin/bash\necho "${name} $*" >> "$VLAD_CALL_LOG"\n${body}\n`);
  chmodSync(p, 0o755);
}

export function run(script: string, args: string[], s: Sandbox, env: Record<string, string> = {}, input?: string) {
  const r = spawnSync("/bin/bash", [join(SCRIPTS, script), ...args], { env: { ...s.env, ...env }, input, encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
