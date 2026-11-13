// F-vlad-310: sandbox sahte araçları (gh/schtasks/reg/...) PATH'te gerçeklerden önce çözülmeli; aksi halde setup gerçek gh.exe'yi çağırır.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeFixtureRoot } from "../helpers.js";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { makeSandbox, repoRoot } from "./setup-sandbox.js";

describe("setup sandbox koruması", () => {
  it("her sahte araç sandbox bin'indeki dosyaya çözülür (win32'de .cmd, PATHEXT)", () => {
    const sb = makeSandbox({ withDist: false });
    expect(() => sb.assertFakesResolve()).not.toThrow();
  });
  it("sahte araç yoksa (gerçeğe düşerdi) koruma kırmızı olur", () => {
    const sb = makeSandbox({ withDist: false });
    for (const f of ["gh", "gh.cmd"]) rmSync(join(sb.bin, f), { force: true });
    expect(() => sb.assertFakesResolve()).toThrow(/gh/);
  });
  it("sahte gh gerçekten çalışır ve FAKE_LOG'a yazar (gerçek gh çağrılmadı kanıtı)", () => {
    const sb = makeSandbox({ withDist: false });
    const r = sb.runTool("gh", ["repo", "view", "acme/x"]);
    expect(r.code).toBe(0);
    expect(sb.calls()).toEqual(["gh repo view acme/x"]);
  });
  it("F-vlad-333: kaynak ağaçtaki yerel durum (vlad.local.json, yerel katman, kb, Agent durumu) sandbox'a kopyalanmaz; yalıtım ortamı sandbox'a işaret eder", () => {
    const src = makeFixtureRoot();
    for (const d of [".claude", "vendor", "kb", ".vlad-agent", "schemas"]) mkdirSync(join(src, d), { recursive: true });
    for (const f of ["vlad.local.json", "vlad.local.json.bak", "vlad.config.local.json", "vlad.config.local.json.bak-1", "vlad-session.txt", ".vlad.lock", "vlad.config.json", "kb/k.md"]) writeFileSync(join(src, f), "SAHTE");
    const sb = makeSandbox({ withDist: false, srcRoot: src });
    for (const f of ["vlad.local.json", "vlad.local.json.bak", "vlad.config.local.json", "vlad.config.local.json.bak-1", "vlad-session.txt", ".vlad.lock", "kb", ".vlad-agent"]) expect(existsSync(join(sb.vladHome, f)), f).toBe(false);
    expect(existsSync(join(sb.vladHome, "vlad.config.json"))).toBe(true); // tracked dosyalar kopyalanır
  });
  // F-vlad-337 kalanı: env() sıfırdan kurulduğu için NODE_OPTIONS (no-secret-shim) çocuğa geçmiyor, çocuk gerçek gizli dizini görüyordu.
  describe("F-vlad-337: gizli dizin yalıtımı shim'i sandbox çocuğunda yüklenir", () => {
    const secretDirOf = (env: NodeJS.ProcessEnv): string => {
      const tokenUrl = pathToFileURL(join(repoRoot, "dist", "mode", "token.js")).href;
      const r = spawnSync(process.execPath, ["-e", `import("${tokenUrl}").then(m => console.log(m.secretDir()))`], { encoding: "utf8", env, timeout: 30_000, killSignal: "SIGKILL" });
      return (r.stdout ?? "").trim();
    };
    it("VLAD_TEST_SECRET_DIR verilince çocuğun gizli dizini o geçici dizindir", () => {
      const sb = makeSandbox({ withDist: false });
      const dir = join(sb.root, "gizli-seam");
      expect(secretDirOf(sb.env({ VLAD_TEST_SECRET_DIR: dir }))).toBe(dir);
    });
    it("seam verilmese de çocuk gerçek gizli dizini görmez (shim varsayılanı geçici dizin)", () => {
      const sb = makeSandbox({ withDist: false });
      const d = secretDirOf(sb.env());
      expect(d).toContain("vlad-test-nosecret-child");
      expect(d.startsWith(tmpdir())).toBe(true);
    });
  });
});
