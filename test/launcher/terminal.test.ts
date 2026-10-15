import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalLauncher, buildCommand, buildScript } from "../../src/launcher/terminal.js";
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
      file: "wt",
      args: ["-w","0","nt","--title","Oda ğüş","-d","C:\\dev\\my proj","powershell","-NoExit","-ExecutionPolicy","Bypass","-File","C:\\t\\s.ps1"],
    });
  });
  it("powershell", () => {
    const c = buildCommand(req(), "powershell", "C:\\t\\s.ps1");
    expect(c.file).toBe("powershell");
    expect(c.args[2]).toBe("Start-Process powershell -WorkingDirectory 'C:\\dev\\my proj' -ArgumentList '-NoExit','-ExecutionPolicy','Bypass','-File','C:\\t\\s.ps1'");
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
    expect(JSON.parse(r.detail!).file).toBe("wt");
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
