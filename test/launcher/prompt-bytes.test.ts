import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildScript, externalLaunch } from "../../src/launcher/terminal.js";
import type { LaunchRequest } from "../../src/launcher/types.js";
import { isolatedEnv } from "../isolate-env.js";

// T20261103-26: Windows PowerShell 5.1 does not escape embedded double quotes when passing a native argument,
// so the prompt was cut at the first `"`. Real powershell.exe, fake claude = a copy of node.exe named claude.exe
// whose preload (NODE_OPTIONS) dumps its argv to a file and exits.
const win = process.platform === "win32";
const NASTY = [
  'rol "açık nokta" yazar', "it's", "`backtick`", "$env:PATH ve $p", "%TEMP% %PATH%", "satır1\nsatır2\r\nsatır3",
  "Türkçe: ğüşıöçĞÜŞİÖÇ", 'ters\ eğik \\" ve \\\\"çift', "'@ başta", "bitiş ters eğik\\", "ikili \"\"", "a & b | c > d ^ e",
].join("\n");

const root = mkdtempSync(join(tmpdir(), "vlad-promptbytes-"));
afterAll(() => { if (realpathSync(root).startsWith(realpathSync(tmpdir()))) rmSync(root, { recursive: true, force: true }); });

// fake claude: C# console exe (arguments parsed by the CLR the way CommandLineToArgvW does) dumping each arg as base64 UTF-8
let fakeExe: string | undefined;
function fakeClaude(): string {
  if (fakeExe) return fakeExe;
  const csc = join(process.env.windir ?? "C:\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const src = join(root, "fake.cs");
  writeFileSync(src, `class P { static void Main(string[] a) { var l = new System.Collections.Generic.List<string>();
    foreach (var s in a) l.Add(System.Convert.ToBase64String(new System.Text.UTF8Encoding(false).GetBytes(s)));
    System.IO.File.WriteAllLines(System.Environment.GetEnvironmentVariable("VLAD_ARGV_OUT"), l); } }`);
  fakeExe = join(root, "claude.exe");
  execFileSync(csc, ["/nologo", `/out:${fakeExe}`, src], { stdio: "ignore", windowsHide: true });
  return fakeExe;
}

function run(script: string, name: string): string[] {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(fakeClaude(), join(dir, "claude.exe"));
  const out = join(dir, "argv.txt");
  const ps1 = join(dir, "run.ps1");
  writeFileSync(ps1, "﻿" + script, "utf8");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
    env: { ...isolatedEnv(), PATH: dir + ";" + process.env.PATH, VLAD_ARGV_OUT: out },
    stdio: "ignore", windowsHide: true, timeout: 60000,
  });
  return readFileSync(out, "utf8").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => Buffer.from(l, "base64").toString("utf8"));
}

const req = (o: Partial<LaunchRequest> = {}): LaunchRequest => ({
  taskId: "T20261103-90", cwd: root, prompt: NASTY, env: { VLAD_TASK_ID: "T20261103-90" }, title: "t", ...o,
});
const norm = (s: string) => s.replace(/\r\n?/g, "\n");

describe.skipIf(!win)("prompt reaches claude byte for byte (real powershell.exe)", () => {
  it("launch script", () => {
    expect(run(buildScript(req()), "launch").map(norm)).toEqual([norm(NASTY)]);
  });
  it("prompt ending in a backslash (with spaces, and before a newline)", () => {
    for (const p of ["yol C:\\dev\\", "yol C:\\dev\\\n", "x \\\\"]) {
      expect(run(buildScript(req({ prompt: p })), "bs").map(norm)).toEqual([norm(p)]);
    }
  });
  it("rejects a prompt over the command-line limit instead of launching a broken worker", () => {
    expect(() => buildScript(req({ prompt: 'a "'.repeat(20000) }))).toThrow(/çok uzun/);
  });
  it("resume script (session id and model flags before the prompt)", () => {
    const argv = run(buildScript(req({ model: "sonnet", resume: { sessionId: "s-1" } })), "resume");
    expect(argv.slice(0, 4)).toEqual(["--model", "sonnet", "--resume", "s-1"]);
    expect(norm(argv[4])).toBe(norm(NASTY));
    expect(argv).toHaveLength(5);
  });
  it("--external launch and resume scripts written to disk", () => {
    // F-vlad-247: resume artık kayıtlı oturum kimliği ister (--continue kullanılmaz)
    for (const r of [req(), req({ resume: { sessionId: "s-123" } })]) {
      const out = externalLaunch(r, join(root, "ext"), "win32");
      expect(out.ok).toBe(true);
      const argv = run(readFileSync(out.script!, "utf8").replace(/^﻿/, ""), "ext-" + (r.resume ? "resume" : "launch"));
      expect(norm(argv[argv.length - 1])).toBe(norm(NASTY));
    }
  });
  it("--external resume without a session id is rejected (no --continue fallback)", () => {
    const out = externalLaunch(req({ resume: {} }), join(root, "ext"), "win32");
    expect(out.ok).toBe(false);
    expect(out.detail).toMatch(/oturum kimliği yok/);
  });
});
