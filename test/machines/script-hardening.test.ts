import { encodeFrame, FrameDecoder } from "../../src/agent/frame.js";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recoverSelfUpdate } from "../../src/agent/ops/script.js";
import { runScript } from "../../src/agent/scripts/run.js";
import { validateScriptManifest } from "../../src/agent/scripts/manifest.js";
import { describe, expect, it } from "vitest";
import { taskkillPath } from "../../src/agent/proc.js";
import { lockDownFile } from "../../src/fleet/state.js";

// Betik çalıştırma sertleştirmesi (T20261109-07, değişiklik turu F): Windows ACL fail-closed, dizin kilidi, taskkill mutlak yol.
const SID = "S-1-5-21-1-2-3-1001";
const exec = (calls: { file: string; args: string[] }[], failIcacls = false) => (file: string, args: string[]): string => {
  calls.push({ file, args });
  if (file.endsWith("icacls.exe") && failIcacls) throw new Error("erişim reddedildi");
  return file.endsWith("whoami.exe") ? `"u","${SID}"` : "";
};

describe("lockDownFile strict / dir", () => {
  it("strict: icacls başarısızlığı fırlatır (uyarı değil) — betik çalışmaz", () => {
    expect(() => lockDownFile("C:\\s\\x.ps1", { platform: "win32", systemRoot: "C:\\Windows", strict: true, exec: exec([], true) })).toThrow(/erişim reddedildi/);
  });
  it("strict değilken eski davranış: uyarı, fırlatma yok", () => {
    const warns: string[] = [];
    expect(() => lockDownFile("x", { platform: "win32", systemRoot: "C:\\Windows", warn: (m) => warns.push(m), exec: exec([], true) })).not.toThrow();
    expect(warns).toHaveLength(1);
  });
  it("dir: Windows'ta (OI)(CI) mirasıyla verilir", () => {
    const calls: { file: string; args: string[] }[] = [];
    lockDownFile("C:\\s", { platform: "win32", systemRoot: "C:\\Windows", dir: true, exec: exec(calls) });
    expect(calls.at(-1)!.args).toEqual(["C:\\s", "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`]);
  });
});

describe("taskkillPath", () => {
  it("PATH'ten değil SystemRoot\\System32'den; SystemRoot yoksa C:\\Windows", () => {
    expect(taskkillPath("D:\\WIN")).toBe("D:\\WIN\\System32\\taskkill.exe");
    expect(taskkillPath(undefined)).toMatch(/System32\\taskkill\.exe$/);
  });
});

// T20261109-26 sertleştirme testleri (Agent/betik).
const posix = it.skipIf(process.platform === "win32");
const manifestWith = (pattern: string) => ({ version: 1, scripts: [{
  name: "x", title: "X", platform: "win32", file: "agent-scripts/x.ps1", sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", class: "write", timeoutSec: 60, outputMaxKb: 32, selfUpdate: false,
  params: [{ name: "tag", type: "string", pattern, maxLen: 8 }],
}] });

describe("F-vlad-268: string param deseni ReDoS ön taraması", () => {
  it.each(["^(a+)+$", "^(a*)*$", "^(\\w+\\s?)+$", "^(a|aa)+$"])("iç içe niceleyici %s reddedilir", (p) => {
    expect(() => validateScriptManifest(manifestWith(p))).toThrow(/pattern geçersiz/);
  });
  it("düz desen kabul edilir", () => {
    expect(() => validateScriptManifest(manifestWith("^[a-z0-9-]+$"))).not.toThrow();
    expect(() => validateScriptManifest(manifestWith("^(v[0-9]+|main)$"))).not.toThrow();
  });
});

describe("F-vlad-280: zaman aşımı sürerken gelen error olayı zaman aşımını ezmez", () => {
  posix("error olayı → yine timedOut:true, exit 124", async () => {
    const d = mkdtempSync(join(tmpdir(), "vlad-t26-"));
    try {
      const r = await runScript({
        bytes: Buffer.from("sleep 30"), name: "t", ext: "sh", opId: "o", cwd: d, dir: join(d, "run"), env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: 200, stdoutCapKb: 32,
        killTree: async (p) => { p.emit("error", new Error("EPIPE")); p.kill("SIGKILL"); return true; },
      });
      expect(r.timedOut).toBe(true);
      expect(r.exit).toBe(124);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe("F-vlad-281: recoverSelfUpdate rename hatasında dist'siz kalmaz", () => {
  posix("dist-old → dist rename'i patlarsa mevcut dist geri konur", () => {
    const repo = mkdtempSync(join(tmpdir(), "vlad-f281-"));
    try {
      for (const [rel, v] of [["dist/cli.js", "NEW"], ["dist-old/cli.js", "OLD"], [".vlad-npm-ci-running", "swap"]] as const) {
        mkdirSync(dirname(join(repo, rel)), { recursive: true }); writeFileSync(join(repo, rel), v);
      }
      const failing = (a: string, b: string) => { if (a.endsWith("dist-old")) throw new Error("EXDEV"); renameSync(a, b); };
      recoverSelfUpdate(repo, failing);
      expect(readFileSync(join(repo, "dist", "cli.js"), "utf8")).toBe("NEW");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("F-vlad-264: 'worktree list -z' NUL baytı Agent çerçevesinde ve trim'de korunur", () => {
  it("encodeFrame/FrameDecoder gidiş-dönüşü NUL'u korur; String.trim NUL'u silmez", () => {
    const out = "worktree /r\0HEAD abc\0branch refs/heads/x\0\0";
    const [back] = new FrameDecoder().push(encodeFrame({ result: out })) as { result: string }[];
    expect(back!.result).toBe(out);
    expect(out.trim()).toBe(out);
  });
});
