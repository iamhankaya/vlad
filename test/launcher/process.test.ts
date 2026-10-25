import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ProcessLauncher, buildShellScript, buildSystemdArgs, closeWorker, closeWorkerProcess, defaultSettingsPath,
  ensureWorkerDir, renderSettings, resolveLaunchMode, shq, workerDir, writeSecureFile,
} from "../../src/launcher/index.js";
import type { LaunchRequest } from "../../src/launcher/types.js";

const ENV = { PATH: "/usr/bin:/bin", HOME: "/home/vlad", VLAD_MACHINE: "srv", SECRET_TOKEN: "x", ANTHROPIC_API_KEY: "y" };
const req = (o: Partial<LaunchRequest> = {}): LaunchRequest => ({
  taskId: "T20261025-54", cwd: "/srv/wt/vlad-T20261025-54", prompt: "merhaba",
  env: { VLAD_TASK_ID: "T20261025-54", VLAD_HOME: "/srv/vlad" }, title: "VLAD T20261025-54 — iş", ...o,
});
const sd = () => mkdtempSync(join(tmpdir(), "vlad-proc-"));
const root = resolve(import.meta.dirname, "..", "..");

describe("launcher: sh script", () => {
  it("launcher: sh script escapes single quote $ newline", () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
    const cwd = "/srv/o'neil $HOME `id`\nx";
    const script = buildShellScript(req({ cwd, model: "sonnet" }), "/run/p'q.prompt", "/etc/s.json", ENV);
    expect(script).toContain(`cd '/srv/o'\\''neil $HOME \`id\`\nx' || exit 1`);
    expect(script).toContain(`< '/run/p'\\''q.prompt'`);
    // run it for real: the shell must see the literal path, not expand it
    const dir = sd();
    const tricky = join(dir, "a'b $HOME\nc");
    spawnSync("mkdir", ["-p", tricky]);
    const r = spawnSync("/bin/sh", ["-c", `cd ${shq(tricky)} && pwd`], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe(tricky);
  });
  it("launcher: model value validated", () => {
    expect(buildShellScript(req({ model: "claude-opus-5-5[1m]" }), "/p", "/s", ENV)).toContain("--model 'claude-opus-5-5[1m]'");
    expect(buildShellScript(req(), "/p", "/s", ENV)).not.toContain("--model");
    for (const bad of ["x'; rm -rf ~; '", "a b", "$(id)", "-p", ""]) {
      expect(() => buildShellScript(req({ model: bad }), "/p", "/s", ENV)).toThrow(/geçersiz model/);
    }
  });
  it("runs headless with auto permission mode and the worker settings", () => {
    const s = buildShellScript(req(), "/p", "/etc/ws.json", ENV);
    expect(s).toMatch(/ claude -p /);
    expect(s).toContain("--permission-mode auto");
    expect(s).toContain("--settings '/etc/ws.json'");
    // only the --settings file: no project/local settings, no project .mcp.json
    expect(s).toContain("--setting-sources user");
    expect(s).toContain("--strict-mcp-config");
  });
  it("launcher: env -i passes only the fixed variable list (F-vlad-007)", () => {
    const s = buildShellScript(req({ env: { VLAD_TASK_ID: "T20261025-54", VLAD_HOME: "/srv/vlad", EVIL: "1" } }), "/p", "/s", ENV);
    expect(s).toContain("exec env -i 'PATH=/usr/bin:/bin' 'HOME=/home/vlad' 'VLAD_HOME=/srv/vlad' 'VLAD_TASK_ID=T20261025-54' 'VLAD_MACHINE=srv' claude ");
    expect(s).not.toMatch(/SECRET_TOKEN|ANTHROPIC_API_KEY|EVIL/);
    // run it for real with a fake claude: the environment seen is exactly the list
    const dir = sd();
    const fake = join(dir, "bin"); spawnSync("mkdir", [fake]);
    writeFileSync(join(fake, "claude"), "#!/bin/sh\nenv | sort\n", { mode: 0o755 });
    const script = buildShellScript(req({ cwd: dir }), "/dev/null", "/s", { ...ENV, PATH: `${fake}:/usr/bin:/bin` });
    const r = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", SECRET_TOKEN: "x", FOO: "bar" } });
    const names = r.stdout.split("\n").filter(Boolean).map((l) => l.split("=")[0]).filter((n) => n !== "PWD" && n !== "_" && n !== "SHLVL" && n !== "OLDPWD");
    expect(names.sort()).toEqual(["HOME", "PATH", "VLAD_HOME", "VLAD_MACHINE", "VLAD_TASK_ID"].sort());
  });
});

describe("launcher: systemd-run", () => {
  it("launcher: systemd-run args have explicit setenv list", () => {
    const args = buildSystemdArgs(req(), "/run/vlad/T.sh", ENV);
    const set = args.filter((a) => a.startsWith("--setenv="));
    expect(set.sort()).toEqual([
      "--setenv=HOME=/home/vlad", "--setenv=PATH=/usr/bin:/bin", "--setenv=VLAD_HOME=/srv/vlad",
      "--setenv=VLAD_MACHINE=srv", "--setenv=VLAD_TASK_ID=T20261025-54",
    ].sort());
    const all = args.join(" ");
    expect(all).not.toContain("SECRET_TOKEN");
    expect(all).not.toContain("ANTHROPIC_API_KEY");
    expect(args).toContain("--unit=vlad-worker-T20261025-54");
    expect(args).toContain("--collect");
    expect(args.slice(-3)).toEqual(["--", "/bin/sh", "/run/vlad/T.sh"]);
  });
  it("extra request env does not pass through, bad values and unit names are rejected", () => {
    const args = buildSystemdArgs(req({ env: { VLAD_TASK_ID: "T20261025-54", EVIL: "1", VLAD_HOME: "/srv/vlad" } }), "/s.sh", ENV);
    expect(args.join(" ")).not.toContain("EVIL");
    expect(() => buildSystemdArgs(req({ env: { VLAD_HOME: "/a\nb" } }), "/s.sh", ENV)).toThrow(/geçersiz karakter/);
    expect(() => buildSystemdArgs(req({ taskId: "T1; reboot" }), "/s.sh", ENV)).toThrow(/geçersiz görev kimliği/);
    // same shape as the task schema id: T + 8 digits + - + 2 or more digits
    for (const bad of ["a.b", "T20261025-5", "t20261025-54", "T20261025-54x", "../T20261025-54"]) {
      expect(() => buildSystemdArgs(req({ taskId: bad }), "/s.sh", ENV), bad).toThrow(/geçersiz görev kimliği/);
    }
    buildSystemdArgs(req({ taskId: "T20261025-100" }), "/s.sh", ENV);
  });
  it("launcher: KillMode control-group", () => {
    const args = buildSystemdArgs(req(), "/s.sh", ENV);
    const i = args.indexOf("-p");
    expect(args[i + 1]).toBe("KillMode=control-group");
  });
});

describe("ProcessLauncher", () => {
  it("launcher: 82KB prompt passed via file not argv", async () => {
    const dir = sd();
    const prompt = "ş".repeat(41_000) + "'$(x)\n" + "a".repeat(41_000);
    expect(Buffer.byteLength(prompt)).toBeGreaterThan(82_000);
    const calls: { file: string; args: string[] }[] = [];
    const res = await new ProcessLauncher({
      scriptDir: dir, env: ENV, exec: (file, args) => { calls.push({ file, args }); },
    }).launch(req({ prompt }));
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("systemd-run");
    expect(calls[0].args.join("\0").length).toBeLessThan(2_000);
    expect(readFileSync(join(dir, "T20261025-54.prompt"), "utf8")).toBe(prompt);
    expect(readFileSync(join(dir, "T20261025-54.sh"), "utf8")).not.toContain("ş");
    expect(statSync(join(dir, "T20261025-54.prompt")).mode & 0o077).toBe(0);
  });
  it("launcher: dry-run output", async () => {
    const dir = join(sd(), "none");
    let ran = false;
    const res = await new ProcessLauncher({ dryRun: true, scriptDir: dir, env: ENV, exec: () => { ran = true; } }).launch(req());
    expect(res.ok).toBe(true);
    expect(res.method).toBe("process");
    const cmd = JSON.parse(res.detail ?? "");
    expect(cmd.file).toBe("systemd-run");
    expect(cmd.args).toContain("--unit=vlad-worker-T20261025-54");
    expect(ran).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
  it("a missing systemd-run gives the stable error message", async () => {
    const res = await new ProcessLauncher({
      scriptDir: sd(), env: { ...ENV, PATH: "/nonexistent" },
    }).launch(req());
    // the real default exec: PATH of this process may contain systemd-run; only assert when it is absent
    if (!res.ok) expect(res.detail).toMatch(/^systemd-run (bulunamadı|başarısız)/);
  });
  it("systemd-run ENOENT maps to 'systemd-run bulunamadı'", async () => {
    const res = await new ProcessLauncher({
      scriptDir: sd(), env: ENV,
      exec: () => { throw new Error("systemd-run bulunamadı: Linux sunucuda systemd (kullanıcı oturumu) gerekli"); },
    }).launch(req());
    expect(res).toMatchObject({ ok: false, method: "process" });
    expect(res.detail).toMatch(/^systemd-run bulunamadı/);
  });
  it("refuses to start when worker-settings.json is missing", async () => {
    const res = await new ProcessLauncher({ scriptDir: sd(), env: ENV, settingsPath: "/nonexistent/ws.json", exec: () => {} }).launch(req());
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/worker-settings\.json bulunamadı/);
  });
  it("an invalid model fails the launch", async () => {
    const res = await new ProcessLauncher({ scriptDir: sd(), env: ENV, exec: () => {} }).launch(req({ model: "a b" }));
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/geçersiz model/);
  });
});

describe("closeWorker", () => {
  it("stops the task's unit through systemctl --user", () => {
    const calls: string[][] = [];
    closeWorkerProcess("T20261025-54", (f, a) => { calls.push([f, ...a]); });
    expect(calls).toEqual([["systemctl", "--user", "stop", "vlad-worker-T20261025-54.service"]]);
    expect(() => closeWorkerProcess("a b")).toThrow(/geçersiz görev kimliği/);
  });
  it("removes the task's script, prompt and settings copy", () => {
    const dir = sd();
    for (const f of ["T20261025-54.sh", "T20261025-54.prompt", "T20261025-54.settings.json", "T20261025-55.prompt"]) {
      writeFileSync(join(dir, f), "x");
    }
    closeWorkerProcess("T20261025-54", () => {}, dir);
    expect(readdirSync(dir)).toEqual(["T20261025-55.prompt"]);
  });
  it("is a no-op error-wise when no unit or no systemd exists", () => {
    expect(() => closeWorker("T20261025-99")).not.toThrow();
  });
});

describe("launcher: mode and permissions", () => {
  it("launcher: auto on linux resolves process", () => {
    expect(resolveLaunchMode("auto", "linux", {})).toBe("process");
    expect(resolveLaunchMode("auto", "linux", { CLAUDE_CODE_REMOTE: "true" })).toBe("cloud");
    expect(resolveLaunchMode("auto", "win32", {})).toBe("auto-terminal");
  });
  it("launcher: no skip-permissions flag anywhere (script, args, settings)", async () => {
    const flag = ["dangerously", "skip", "permissions"].join("-");
    const script = buildShellScript(req({ model: "sonnet" }), "/p", defaultSettingsPath());
    const args = buildSystemdArgs(req(), "/s.sh", ENV).join(" ");
    expect(script + args).not.toContain(flag);
    for (const f of [defaultSettingsPath(), join(root, "src/launcher/process.ts"), join(root, "src/launcher/mode.ts"),
      join(root, "src/launcher/terminal.ts"), join(root, "src/cli-groups/task.ts")]) {
      expect(readFileSync(f, "utf8"), f).not.toContain(flag);
    }
    for (const f of readdirSync(join(root, "deploy"), { recursive: true, encoding: "utf8" })) {
      const p = join(root, "deploy", f);
      if (statSync(p).isFile()) expect(readFileSync(p, "utf8"), p).not.toContain(flag);
    }
  });
  it("worker-settings.json: path rules use a valid form (absolute needs //, others ~/ ** or relative)", () => {
    const s = JSON.parse(readFileSync(defaultSettingsPath(), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
    for (const rule of [...s.permissions.allow, ...s.permissions.deny]) {
      const m = /^(Read|Edit|Write)\((.*)\)$/.exec(rule);
      if (!m) continue;
      // a single leading slash is relative to the settings file's directory, not the filesystem root
      expect(/^\/(?!\/)/.test(m[2]), rule).toBe(false);
    }
    expect(s.permissions.deny).toContain("Edit(//var/lib/vladapi/**)");
    for (const t of ["Edit", "Write"]) {
      expect(s.permissions.deny).toContain(`${t}(**/.claude/**)`);
      expect(s.permissions.deny).toContain(`${t}(**/.mcp.json)`);
    }
  });
  it("worker-settings.json: extra deny rules", () => {
    const s = JSON.parse(readFileSync(defaultSettingsPath(), "utf8")) as { permissions: { deny: string[] } };
    for (const d of ["Bash(git -C*push*)", "Bash(env *)", "Bash(gh auth*)", "Bash(gh repo delete*)", "Bash(* $HOME/.config*)",
      "Bash(rm -r*)", "Bash(rm --recursive*)", "Bash(git clean*)", "Bash(npm publish*)"]) {
      expect(s.permissions.deny, d).toContain(d);
    }
  });
  it("worker-settings.json keeps the deny net", () => {
    const s = JSON.parse(readFileSync(defaultSettingsPath(), "utf8")) as { permissions: { allow: string[]; deny: string[] } };
    for (const d of ["Bash(rm -rf*)", "Bash(rm -r *)", "Bash(curl*)", "Bash(wget*)", "Bash(* | sh)", "Bash(* | bash)",
      "Bash(git push --force*)", "Bash(git push* main)", "Bash(git push* master)", "Bash(gh pr merge*)", "Bash(gh api*)",
      "Read(~/.config/**)", "Read(~/.claude/**)", "Read(//var/lib/vladapi/**)", "Read(**/.env*)"]) {
      expect(s.permissions.deny, d).toContain(d);
    }
    // S14a review: the allow pattern is anchored on the task branch prefix; suffixes are caught by deny rules (test/deploy/s14a.test.ts)
    expect(s.permissions.allow).toContain("Bash(git push origin vlad/T*)");
    expect(s.permissions.allow.filter((a) => a.startsWith("Bash(git push"))).toEqual([
      "Bash(git push origin vlad/T*)", "Bash(git push -u origin vlad/T*)",
    ]);
    expect(s.permissions.allow.some((a) => /gh |curl|wget/.test(a))).toBe(false);
  });
});

describe("launcher: worker dir hardening", () => {
  it("falls back to ~/.local/state/vlad, never the shared tmp; errors without any home", () => {
    expect(workerDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/vlad");
    expect(workerDir({ HOME: "/home/vlad" })).toBe("/home/vlad/.local/state/vlad");
    expect(() => workerDir({})).toThrow(/XDG_RUNTIME_DIR ve HOME yok/);
  });
  it("creates the dir 0700 and rejects symlinks, loose modes", () => {
    const base = sd();
    const d = join(base, "new", "vlad");
    ensureWorkerDir(d);
    expect(statSync(d).mode & 0o777).toBe(0o700);
    const link = join(base, "link");
    symlinkSync(d, link);
    expect(() => ensureWorkerDir(link)).toThrow(/güvenli değil/);
    chmodSync(d, 0o755);
    expect(() => ensureWorkerDir(d)).toThrow(/0700 değil/);
  });
  it("writeSecureFile writes 0600 and does not follow a planted symlink", () => {
    const dir = sd();
    const victim = join(dir, "victim");
    writeFileSync(victim, "keep");
    symlinkSync(victim, join(dir, "T.prompt"));
    writeSecureFile(join(dir, "T.prompt"), "new");
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(readFileSync(join(dir, "T.prompt"), "utf8")).toBe("new");
    expect(statSync(join(dir, "T.prompt")).mode & 0o777).toBe(0o600);
  });
  it("ProcessLauncher refuses an unsafe dir and writes the rendered settings copy", async () => {
    const loose = sd();
    chmodSync(loose, 0o755);
    const bad = await new ProcessLauncher({ scriptDir: loose, env: ENV, exec: () => {} }).launch(req());
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/0700 değil/);
    const dir = sd();
    const ok = await new ProcessLauncher({ scriptDir: dir, env: ENV, exec: () => {} }).launch(req());
    expect(ok.ok).toBe(true);
    const copy = JSON.parse(readFileSync(join(dir, "T20261025-54.settings.json"), "utf8")) as { permissions: { deny: string[] } };
    expect(statSync(join(dir, "T20261025-54.settings.json")).mode & 0o777).toBe(0o600);
    expect(copy.permissions.deny).toContain(`Write(/${resolve(root, "deploy", "claude")}/**)`);
    expect(copy.permissions.deny).toContain(`Edit(/${resolve(dir)}/**)`);
    expect(readFileSync(join(dir, "T20261025-54.sh"), "utf8")).toContain(`--settings '${join(dir, "T20261025-54.settings.json")}'`);
  });
  it("renderSettings leaves the source file unchanged", () => {
    const before = readFileSync(defaultSettingsPath(), "utf8");
    renderSettings(defaultSettingsPath(), "/run/user/1/vlad");
    expect(readFileSync(defaultSettingsPath(), "utf8")).toBe(before);
  });
});
