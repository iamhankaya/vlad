// F-vlad-355 (c): servis sessizce kalkarsa SessionStart özeti uyarır (plist yok ya da launchd'de yüklü değil).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approverServiceWarning } from "../../src/approver/health.js";

const mk = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vlad-aw-")));
  const approverDir = join(root, "approver"), plistDir = join(root, "LA");
  mkdirSync(approverDir, { recursive: true }); mkdirSync(plistDir, { recursive: true });
  return { approverDir, plistDir };
};
const base = { platform: "darwin" as NodeJS.Platform };

describe("approverServiceWarning", () => {
  it("approver hiç kurulmamışsa (channel.json yok) uyarı yok", () => {
    const d = mk();
    expect(approverServiceWarning({ ...base, ...d })).toBeNull();
  });
  it("channel.json var, plist yok → uyarı kurulum komutunu söyler", () => {
    const d = mk();
    writeFileSync(join(d.approverDir, "channel.json"), "{}");
    expect(approverServiceWarning({ ...base, ...d })).toMatch(/approver servisi kurulu değil.*vlad approver install/);
  });
  it("channel.json + plist var, launchd'de yüklü değil → uyarı", () => {
    const d = mk();
    writeFileSync(join(d.approverDir, "channel.json"), "{}");
    writeFileSync(join(d.plistDir, "com.vlad.approver.plist"), "x");
    expect(approverServiceWarning({ ...base, ...d, loaded: () => false })).toMatch(/launchd'de yüklü değil/);
    expect(approverServiceWarning({ ...base, ...d, loaded: () => true })).toBeNull();
  });
  it("Mac dışında uyarı yok; hata (okunamayan dizin) uyarıya dönüşmez", () => {
    const d = mk();
    writeFileSync(join(d.approverDir, "channel.json"), "{}");
    expect(approverServiceWarning({ platform: "win32", ...d })).toBeNull();
    expect(approverServiceWarning({ ...base, approverDir: join(d.approverDir, "yok", "x"), plistDir: d.plistDir })).toBeNull();
  });
});
