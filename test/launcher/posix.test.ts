import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PosixLauncher, buildPosixScript, posixCommand, buildTerminalAppArgs, buildTmuxArgs, closePosixWorker, externalLaunch, resolveLaunchMode,
  tmuxSession,
} from "../../src/launcher/index.js";
import type { LaunchRequest } from "../../src/launcher/types.js";
import { isolatedEnv } from "../isolate-env.js";

const req = (o: Partial<LaunchRequest> = {}): LaunchRequest => ({
  taskId: "T20261101-18", cwd: "/Users/me/vlad wt/T20261101-18", prompt: "merhaba",
  env: { VLAD_TASK_ID: "T20261101-18", VLAD_HOME: "/Users/me/vlad" }, title: "VLAD T20261101-18 — it's", ...o,
});
// POSIX launcher (tmux/osascript/bash, "/" yolları): Windows'ta anlamsız, gerçek platform kısıtı
const WIN = process.platform === "win32";
const sd = () => mkdtempSync(join(tmpdir(), "vlad-posix-"));

describe("resolveLaunchMode (darwin/linux)", () => {
  it("auto on darwin picks tmux; the cloud variable still wins; noop guard applies", () => {
    expect(resolveLaunchMode("auto", "darwin", {})).toBe("tmux");
    expect(resolveLaunchMode("auto", "darwin", { CLAUDE_CODE_REMOTE: "true" })).toBe("cloud");
    expect(resolveLaunchMode("auto", "darwin", { VLAD_LAUNCHER: "noop" })).toBe("noop");
  });
  it("explicit tmux/terminal pass through (noop under the guard)", () => {
    expect(resolveLaunchMode("tmux", "linux", {})).toBe("tmux");
    expect(resolveLaunchMode("terminal", "darwin", {})).toBe("terminal");
    expect(resolveLaunchMode("tmux", "darwin", { VLAD_LAUNCHER: "noop" })).toBe("noop");
  });
  it("auto on Windows and Linux is unchanged", () => {
    expect(resolveLaunchMode("auto", "win32", {})).toBe("auto-terminal");
    expect(resolveLaunchMode("auto", "linux", {})).toBe("tmux");
  });
});

describe("buildPosixScript", () => {
  it("re-asserts the worktree trust record right before claude starts (F-vlad-261)", () => {
    const s = buildPosixScript(req());
    const at = s.indexOf("trust.js");
    expect(at).toBeGreaterThan(s.indexOf("cd '/Users/me/vlad wt/T20261101-18'"));
    expect(at).toBeLessThan(s.indexOf("\nclaude "));
    expect(s).toContain("trustWorktree");
    expect(s).toContain("'/Users/me/vlad wt/T20261101-18'"); // cwd is passed quoted
  });
  it("exports env, cds quoted, passes the prompt via a quoted heredoc and calls claude", () => {
    const s = buildPosixScript(req({ env: { K: "it's" } }));
    expect(s.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(s).toContain(String.raw`export K='it'\''s'`);
    expect(s).toContain("cd '/Users/me/vlad wt/T20261101-18'");
    expect(s).toContain("read -r -d '' p <<'VLAD_PROMPT_EOF'\nmerhaba\nVLAD_PROMPT_EOF\n");
    expect(s).toMatch(/\nclaude "\$p"\n$/);
  });
  it("keeps model, autocompact and resume flags in the Windows order", () => {
    expect(buildPosixScript(req({ model: "sonnet", autoCompact: "300k", resume: { sessionId: "s1" } })))
      .toMatch(/\nclaude --model 'sonnet' --autocompact '300k' --resume 's1' "\$p"\n$/);
    expect(() => buildPosixScript(req({ resume: {} }))).toThrow(/oturum kimliği yok/); // F-vlad-247: no --continue
  });
  it("validates model, autocompact and env names", () => {
    expect(() => buildPosixScript(req({ model: "a'; rm -rf ~" }))).toThrow(/geçersiz model/);
    expect(() => buildPosixScript(req({ autoCompact: "1;x" }))).toThrow(/geçersiz autoCompact/);
    expect(() => buildPosixScript(req({ env: { "A B": "x" } }))).toThrow(/geçersiz env/);
  });
  it("picks a heredoc delimiter the prompt does not contain", () => {
    const s = buildPosixScript(req({ prompt: "a\nVLAD_PROMPT_EOF\nb\n$(evil) `x`" }));
    expect(s).toContain("read -r -d '' p <<'VLAD_PROMPT_EOF_'\na\nVLAD_PROMPT_EOF\nb\n$(evil) `x`\nVLAD_PROMPT_EOF_\n");
  });
});

describe("buildPosixScript run by a real bash", () => {
  // bash 3.2 (macOS) choked on quotes/parens in a heredoc inside $( ); the script must pass any prompt through intact
  it.runIf(process.platform !== "win32")("hands a prompt with quotes, parens and $() to claude unchanged", () => {
    const dir = sd();
    const fake = join(dir, "claude");
    writeFileSync(fake, '#!/bin/sh\nprintf "%s" "$1" > "$OUT"\n');
    chmodSync(fake, 0o755);
    const prompt = "Merhaba 'dünya' (kapanmayan\n- `x` $(evil) \"q\"\nson satır";
    const script = join(dir, "w.sh");
    writeFileSync(script, buildPosixScript(req({ cwd: dir, prompt })));
    const out = join(dir, "out.txt");
    const res = spawnSync("bash", [script], { env: { ...isolatedEnv(), PATH: `${dir}:${process.env.PATH}`, OUT: out }, encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(prompt);
  });
  it("title control characters never reach the script", () => {
    expect(buildPosixScript(req({ title: "a\u0007b\u001b[0m" }))).not.toMatch(/[\x07\x1b]/);
  });
});

describe.skipIf(WIN)("tmux / Terminal.app commands", () => {
  it("names the session vlad-<id> and builds new-session args", () => {
    expect(tmuxSession("T1")).toBe("vlad-T1");
    expect(buildTmuxArgs(req(), "/tmp/vlad/T20261101-18.sh")).toEqual([
      "new-session", "-d", "-s", "vlad-T20261101-18", "-c", "/Users/me/vlad wt/T20261101-18", "bash '/tmp/vlad/T20261101-18.sh'",
    ]);
  });
  it("Terminal.app runs the script through osascript with AppleScript escaping", () => {
    const a = buildTerminalAppArgs("/tmp/a \"b\"/x.sh");
    expect(a.filter((x) => x === "-e")).toHaveLength(2);
    expect(a[3]).toContain('tell application "Terminal"');
    expect(a[3]).toContain(`do script "bash '/tmp/a \\"b\\"/x.sh'"`);
  });
});

describe.skipIf(WIN)("PosixLauncher", () => {
  it("tmux: writes <dir>/<id>.sh, runs tmux new-session", async () => {
    const dir = sd(); const calls: [string, string[]][] = [];
    const l = new PosixLauncher({ mode: "tmux", scriptDir: dir, hasTmux: () => true, run: (f, a) => { calls.push([f, a]); } });
    const r = await l.launch(req());
    expect(r).toMatchObject({ ok: true, method: "tmux" });
    expect(readFileSync(join(dir, "T20261101-18.sh"), "utf8")).toContain("claude \"$p\"");
    expect(calls).toEqual([["tmux", buildTmuxArgs(req(), join(dir, "T20261101-18.sh"))]]);
  });
  it("tmux missing → ok:false with the brew hint, nothing launched", async () => {
    const l = new PosixLauncher({ mode: "tmux", scriptDir: sd(), hasTmux: () => false, run: () => { throw new Error("no"); } });
    const r = await l.launch(req());
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("brew install tmux");
  });
  it("terminal mode runs osascript", async () => {
    const calls: string[] = [];
    const r = await new PosixLauncher({ mode: "terminal", scriptDir: sd(), run: (f) => { calls.push(f); } }).launch(req());
    expect(r.method).toBe("terminal");
    expect(calls).toEqual(["osascript"]);
  });
  it("dry run writes nothing and runs nothing", async () => {
    const dir = join(sd(), "x");
    const r = await new PosixLauncher({ mode: "tmux", scriptDir: dir, dryRun: true, run: () => { throw new Error("ran"); } }).launch(req());
    expect(r.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });
  it("exec failure is reported, not thrown", async () => {
    const r = await new PosixLauncher({ mode: "tmux", scriptDir: sd(), hasTmux: () => true, run: () => { throw new Error("duplicate session"); } }).launch(req());
    expect(r).toMatchObject({ ok: false });
    expect(r.detail).toContain("duplicate session");
    expect(r.detail).toContain("close-window T20261101-18");
  });
});

describe.skipIf(WIN)("externalLaunch on darwin", () => {
  it("writes a POSIX script and returns `bash <script>`", () => {
    const dir = sd();
    const r = externalLaunch(req(), dir, "darwin");
    expect(r.ok).toBe(true);
    expect(r.script).toBe(join(dir, "T20261101-18.sh"));
    expect(r.command).toBe(posixCommand(r.script!));
    expect(r.cwd).toBe(req().cwd);
    expect(readFileSync(r.script!, "utf8")).toContain("#!/usr/bin/env bash");
  });
});

describe.skipIf(WIN)("posixCommand", () => {
  it("leaves plain paths bare and double-quotes paths with spaces or shell characters", () => {
    expect(posixCommand("/var/folders/ab/T/vlad/T1.sh")).toBe("bash /var/folders/ab/T/vlad/T1.sh");
    expect(posixCommand("/Users/me x/T1.sh")).toBe('bash "/Users/me x/T1.sh"');
    expect(posixCommand("/a/$b/`c`.sh")).toBe(String.raw`bash "/a/\$b/\`c\`.sh"`);
  });
});

describe.skipIf(WIN)("closePosixWorker", () => {
  it("kills the tmux session, then the processes whose command line has the script path", () => {
    const calls: string[] = [];
    const killed: number[] = [];
    const out = closePosixWorker("T20261101-18", {
      run: (f, a) => {
        calls.push(`${f} ${a.join(" ")}`);
        return f === "pgrep" ? "111\n222\n" : "";
      },
      kill: (pid) => { killed.push(pid); },
      selfPid: 222,
    });
    expect(calls[0]).toBe("tmux kill-session -t vlad-T20261101-18");
    expect(calls).toContain(String.raw`pgrep -f -- bash .*/vlad/T20261101-18\.sh$`);
    expect(calls).toContain("pkill -TERM -P 111");
    expect(killed).toEqual([111]);
    expect(out).toEqual([111]);
  });
  it("a missing tmux session or no process is not an error", () => {
    const out = closePosixWorker("T1", { run: (f) => { if (f === "tmux") throw new Error("can't find session"); return ""; }, kill: () => {} });
    expect(out).toEqual([]);
  });
});
