import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalLauncher, buildCommand, buildScript, closeWorkerWindow, defaultExec, toCommandLine } from "../../src/launcher/terminal.js";
import type { LaunchRequest } from "../../src/launcher/types.js";

const req = (o: Partial<LaunchRequest> = {}): LaunchRequest => ({
  taskId: "T20261015-01", cwd: "C:\\dev\\my proj", prompt: "merhaba",
  env: { VLAD_TASK_ID: "T20261015-01" }, title: "Oda ğüş", ...o,
});
const sd = () => mkdtempSync(join(tmpdir(), "vlad-launch-"));

describe("buildScript", () => {
  it("escapes env single quotes", () => {
    expect(buildScript(req({ env: { K: "it's" } }))).toContain("$env:K = 'it''s'");
  });
  it("handles spaced cwd and Turkish title", () => {
    const s = buildScript(req());
    expect(s).toContain("Set-Location -LiteralPath 'C:\\dev\\my proj'");
    expect(s).toContain("$host.UI.RawUI.WindowTitle = 'Oda ğüş'");
    expect(s).toContain("claude $p");
  });
  it("passes a role model as a quoted --model argument, and none without a model", () => {
    expect(buildScript(req({ model: "sonnet" }))).toMatch(/\nclaude --model 'sonnet' \$p\n$/);
    expect(buildScript(req({ model: "claude-opus-5-5[1m]" }))).toContain("claude --model 'claude-opus-5-5[1m]' $p");
    expect(buildScript(req())).toMatch(/\nclaude \$p\n$/);
    expect(buildScript(req())).not.toContain("--model");
  });
  it("rejects an empty or unsafe model instead of writing it into the script", () => {
    for (const model of ["", " ", "sonnet'; rm x", "a b", "$(evil)", "son`net", "--help"]) {
      expect(() => buildScript(req({ model })), JSON.stringify(model)).toThrow(/geçersiz model/);
    }
  });
  it("protects lines starting with '@", () => {
    const s = buildScript(req({ prompt: "a\n'@ evil\nb" }));
    const lines = s.split("\n");
    expect(lines.filter((l) => l.startsWith("'@"))).toHaveLength(1);
    expect(s).toContain("\n '@ evil\n");
  });
});

describe("buildCommand", () => {
  it("wt", () => {
    expect(buildCommand(req(), "wt", "C:\\t\\s.ps1")).toEqual({
      file: "wt.exe",
      args: ["-w","0","nt","--title","Oda ğüş","-d","C:\\dev\\my proj","powershell","-NoExit","-ExecutionPolicy","Bypass","-File","C:\\t\\s.ps1"],
    });
  });
  it("powershell", () => {
    expect(buildCommand(req(), "powershell", "C:\\t\\s.ps1")).toEqual({
      file: "powershell.exe",
      args: ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", "C:\\t\\s.ps1"],
    });
  });
});

describe("TerminalLauncher", () => {
  it("auto picks by hasWt", async () => {
    const exec = vi.fn();
    const a = await new TerminalLauncher({ mode: "auto", hasWt: () => false, exec, scriptDir: sd() }).launch(req());
    expect(a.method).toBe("powershell");
    const b = await new TerminalLauncher({ mode: "auto", hasWt: () => true, exec, scriptDir: sd() }).launch(req());
    expect(b.method).toBe("wt");
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it("dryRun does not exec", async () => {
    const exec = vi.fn();
    const r = await new TerminalLauncher({ mode: "wt", dryRun: true, exec, scriptDir: sd() }).launch(req());
    expect(exec).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(JSON.parse(r.detail!).file).toBe("wt.exe");
  });
  it("exec failure gives ok false", async () => {
    const exec = vi.fn(() => { throw new Error("boom"); });
    const r = await new TerminalLauncher({ mode: "powershell", exec, scriptDir: sd() }).launch(req());
    expect(r).toMatchObject({ ok: false, method: "powershell", detail: "boom" });
  });
  it("script file starts with BOM", async () => {
    const dir = sd();
    const exec = vi.fn();
    await new TerminalLauncher({ mode: "wt", exec, scriptDir: dir }).launch(req());
    const path = (exec.mock.calls[0] as [string, string[]])[1].at(-1)!;
    const buf = readFileSync(path);
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("buildScript resume", () => {
  it("continues the recorded session, keeping --model", () => {
    expect(buildScript(req({ resume: { sessionId: "abc-123" } }))).toMatch(/\nclaude --resume 'abc-123' \$p\n$/);
    expect(buildScript(req({ model: "sonnet", resume: { sessionId: "it's" } }))).toMatch(/\nclaude --model 'sonnet' --resume 'it''s' \$p\n$/);
  });
  it("falls back to --continue without a session id", () => {
    expect(buildScript(req({ resume: {} }))).toMatch(/\nclaude --continue \$p\n$/);
    expect(buildScript(req({ model: "opus", resume: {} }))).toMatch(/\nclaude --model 'opus' --continue \$p\n$/);
  });
});

describe("TerminalLauncher external", () => {
  it("writes the script but opens no terminal, and returns script/command/cwd", async () => {
    const dir = sd();
    const exec = vi.fn();
    const r = await new TerminalLauncher({ mode: "auto", external: true, exec, scriptDir: dir }).launch(req());
    expect(exec).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.method).toBe("external");
    expect(r.script).toBe(join(dir, "T20261015-01.ps1"));
    expect(readFileSync(r.script!, "utf8")).toContain("claude $p");
    expect(r.cwd).toBe(req().cwd);
    expect(r.command).toBe(toCommandLine("powershell", ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", r.script!]));
  });
  it("quotes a script path with spaces in the command", async () => {
    const dir = join(sd(), "a b");
    const r = await new TerminalLauncher({ mode: "auto", external: true, scriptDir: dir }).launch(req());
    expect(r.command).toBe(`powershell -NoExit -ExecutionPolicy Bypass -File "${r.script}"`);
  });
});

describe("quoting fixes", () => {
  it("powershell method double-quotes a scriptPath with spaces and Turkish chars", () => {
    const p = "C:\\Users\\Metin Ay\\ğ\\s.ps1";
    const c = buildCommand(req(), "powershell", p);
    expect(toCommandLine(c.file, c.args)).toBe(`powershell.exe -NoExit -ExecutionPolicy Bypass -File "${p}"`);
  });
  it("doubles typographic single quotes and guards them before @", () => {
    expect(buildScript(req({ env: { K: "a\u2019b" } }))).toContain("$env:K = 'a\u2019\u2019b'");
    expect(buildScript(req({ prompt: "x\n\u2019@ y" }))).toContain("\n \u2019@ y\n");
  });
  it("escapes ; in wt title", () => {
    expect(buildCommand(req({ title: "a;b" }), "wt", "s").args[4]).toBe("a\\;b");
  });
  it("toCommandLine quotes per Windows argv rules", () => {
    expect(toCommandLine("wt.exe", ["--title", "Oda ğüş", "-d", String.raw`C:\dev\my proj`, "x"]))
      .toBe(String.raw`wt.exe --title "Oda ğüş" -d "C:\dev\my proj" x`);
    expect(toCommandLine("a", ['a"b'])).toBe(String.raw`a "a\"b"`);
    expect(toCommandLine("a", ["C:\\a b\\"])).toBe('a "C:\\a b\\\\"');
    expect(toCommandLine("a", [""])).toBe('a ""');
  });
  it("passes the task cwd to exec", async () => {
    const exec = vi.fn();
    await new TerminalLauncher({ mode: "powershell", exec, scriptDir: sd() }).launch(req());
    expect(exec.mock.calls[0][2]).toBe("C:\\dev\\my proj");
  });
  it("defaultExec rejects for a nonexistent executable", async () => {
    await expect(defaultExec("vlad-no-such-exe-xyz", [])).rejects.toThrow();
  });
  it("launch returns ok:false when async exec rejects", async () => {
    const exec = async () => { throw new Error("ENOENT"); };
    const r = await new TerminalLauncher({ mode: "wt", exec, scriptDir: sd() }).launch(req());
    expect(r).toMatchObject({ ok: false, detail: "ENOENT" });
  });
});

describe("closeWorkerWindow", () => {
  it.runIf(process.platform === "win32")("kills the process whose command line runs the task's worker script", async () => {
    const id = "T29990101-99";
    // this test kills only its own stand-in processes, so it opts out of the VLAD_LAUNCHER=noop guard (F-vlad-064)
    vi.stubEnv("VLAD_ALLOW_REAL_LAUNCHER", "1");
    // stands in for `powershell -File %TEMP%\vlad\<id>.ps1`
    const worker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", join(tmpdir(), "vlad", `${id}.ps1`)], { stdio: "ignore" });
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", join(tmpdir(), "vlad", "T29990101-98.ps1")], { stdio: "ignore" });
    const exited = new Promise((r) => worker.once("exit", r));
    try {
      // under suite load the stand-ins can take seconds to show up in the process list: retry instead of a fixed wait
      let killed: number[] = [];
      for (let i = 0; i < 40 && !killed.length; i++) {
        await new Promise((r) => setTimeout(r, 250));
        killed = closeWorkerWindow(id);
      }
      expect(killed).toEqual([worker.pid]);
      await exited;
      expect(other.exitCode).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      worker.kill();
      other.kill();
    }
  });
});
