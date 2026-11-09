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
