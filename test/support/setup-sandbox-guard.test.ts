// F-vlad-310: sandbox sahte araçları (gh/schtasks/reg/...) PATH'te gerçeklerden önce çözülmeli; aksi halde setup gerçek gh.exe'yi çağırır.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeSandbox } from "./setup-sandbox.js";

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
});
