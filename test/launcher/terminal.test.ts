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
  it("adds --autocompact after --model when given, and not otherwise", () => {
    expect(buildScript(req({ autoCompact: "300k" }))).toMatch(/\nclaude --autocompact '300k' \$p\n$/);
    expect(buildScript(req({ model: "sonnet", autoCompact: "300000", resume: { sessionId: "s1" } })))
      .toMatch(/\nclaude --model 'sonnet' --autocompact '300000' --resume 's1' \$p\n$/);
    expect(buildScript(req())).not.toContain("--autocompact");
  });
  it("rejects an unsafe autoCompact value instead of writing it into the script", () => {
    for (const v of ["", "300k'; rm x", "$(x)", "abc", "--help"]) {
      expect(() => buildScript(req({ autoCompact: v })), JSON.stringify(v)).toThrow(/geçersiz autoCompact/);
    }
  });
  it("embeds the prompt as base64 so no prompt text can end the literal", () => {
    const prompt = "a\n'@ evil\n’@ x\n\"q\" $p `t` %T% ç";
    const s = buildScript(req({ prompt: prompt.replace(/\n/g, "\r\n") }));
    expect(s).not.toContain("evil");
    const b64 = /FromBase64String\('([^']*)'\)/.exec(s)![1];
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(prompt);
  });
});

describe("PS 5.1 argument escaping (F-vlad-189)", () => {
  it("doubles trailing backslashes only when the argument gets quoted (contains whitespace)", () => {
    // PowerShell 5.1 quotes a native argument only for whitespace; unquoted, a doubled trailing `\\` would reach claude doubled
    expect(buildScript(req())).toContain("if ($p -match '\\s') { $p = [regex]::Replace($p, '(\\\\+)\\z', '$1$1') }");
  });
});

describe("trust preflight (F-vlad-267)", () => {
  it("re-asserts the worktree trust record right before claude starts, without double quotes in the JS argument", () => {
    const s = buildScript(req());
    const at = s.indexOf("trust.js");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(s.indexOf("\nclaude "));
    expect(s).toContain("trustWorktree");
    const line = s.split("\n").find((l) => l.includes("trustWorktree"))!;
    expect(line.startsWith("& ")).toBe(true);
    expect(line).toContain("'C:\\dev\\my proj'");
    expect(line).not.toContain('"'); // PS 5.1 would cut a native argument at an unescaped quote (T20261103-26)
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
    expect(buildScript(req({ model: "sonnet", resume: { sessionId: "it_s" } }))).toMatch(/\nclaude --model 'sonnet' --resume 'it_s' \$p\n$/);
  });
  it("refuses to resume without a session id (F-vlad-247: no --continue)", () => {
    expect(() => buildScript(req({ resume: {} }))).toThrow(/oturum kimliği yok/);
    expect(() => buildScript(req({ model: "opus", resume: {} }))).toThrow(/oturum kimliği yok/);
  });
});

// PowerShell .ps1 script + `powershell -File` command are the Windows form; the POSIX form is covered in posix.test.ts (externalLaunch on darwin).
describe.runIf(process.platform === "win32")("TerminalLauncher external", () => {
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
  it("doubles typographic single quotes in env values", () => {
    expect(buildScript(req({ env: { K: "a’b" } }))).toContain("$env:K = 'a’’b'");
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

// T20261105-47 (5): the Windows close path is driven through an injected runner, so its result handling is tested on any OS.
describe("closeWorkerWindow (win32 sonuç işleme, sahte runner)", () => {
  const run = (out: string) => (_f: string, _a: string[], _env: Record<string, string>) => out;
  it("OK satırları kapatılan PID'lerdir", () => {
    expect(closeWorkerWindow("T20261105-90", "win32", run("OK 111\nOK 222\n"))).toEqual([111, 222]);
  });
  it("taskkill başarısız ama süreç hâlâ duruyorsa sessiz geçmez: PID ve neden hatada", () => {
    expect(() => closeWorkerWindow("T20261105-90", "win32", run("OK 111\nFAIL 222 ERROR: Access is denied.\nLEFT 222\n"))).toThrow(/222.*Access is denied/s);
  });
  it("taskkill başarısız ama süreç zaten gitmişse (çocuk, /T ile ölmüş) hata değildir", () => {
    expect(closeWorkerWindow("T20261105-90", "win32", run("OK 111\nFAIL 222 ERROR: The process not found.\n"))).toEqual([111]);
  });
  it("betik: kapatmadan sonra aynı eşleşmeyi yeniden sorgular ve model yolu env ile gider (komut satırına gömülmez)", () => {
    let seen: { file: string; args: string[]; env: Record<string, string> } | undefined;
    closeWorkerWindow("T20261105-90", "win32", (file, args, env) => { seen = { file, args, env }; return ""; });
    expect(seen!.env.VLAD_WORKER_SCRIPT).toBe("\\vlad\\t20261105-90.ps1");
    const script = seen!.args.join(" ");
    expect(script).toContain("LASTEXITCODE");
    expect(script).toContain("LEFT");
    expect(script).not.toContain("t20261105-90");
  });
});
