// T20261121-39 doğrulama: F-vlad-355 koruması test ALT SÜREÇLERİNDE de açık olmalı (kullanıcı: "tek sefer açmak yeterli olmalı").
// spawnVlad/runSpawn çocukları allowlist env ile koşar (process.env yayılmaz); VITEST/NODE_ENV taşımazlarsa guard kapalı kalır
// ve çocuk `approver|monitor|agent install/uninstall` gerçek ~/Library/LaunchAgents'a yazar/siler (HOME geçici olsa bile:
// kurucular `userInfo().homedir` kullanır, HOME'u yok sayar). Çocuk burada YALNIZ yan etkisiz guard fonksiyonlarını çağırır:
// gerçek kurucu ya da gerçek launchctl çağrılmaz; sahte launchctl yalnız çağrıyı sayar.
import { describe, expect, it } from "vitest";
import { runSpawn } from "../support/spawn-vlad.js";
import { join } from "node:path";

const GUARD = join(import.meta.dirname, "..", "..", "dist", "launchd-guard.js");
const probe = (body: string) => runSpawn(process.execPath, ["--input-type=module", "-e", `import * as g from ${JSON.stringify("file://" + GUARD)};\n${body}`]);

describe("launchd koruması alt süreçte (F-vlad-355)", () => {
  it("allowlist env'li çocuk süreçte test ortamı algılanır", () => {
    const r = probe(`console.log(JSON.stringify(g.inTestEnv()))`);
    expect(r.spawnError).toBeUndefined();
    expect(r.stdout.trim()).toBe("true");
  });

  it("çocukta plist dizini verilmeden kurulum reddedilir (gerçek LaunchAgents'a yazma yolu kapalı)", () => {
    const r = probe(`try { g.assertTestSafeLaunchd({ plistDir: g.realLaunchAgentsDir(), injected: false }); console.log("GECTI"); } catch (e) { console.log("RED"); }`);
    expect(r.stdout.trim()).toBe("RED");
  });

  it("çocukta gerçek launchctl'in değiştiren fiili (bootout) reddedilir", () => {
    const r = probe(`let n = 0; const lc = g.guardLaunchctl(async () => { n++; return { code: 0, stdout: "", stderr: "" }; });\nlc(["bootout", "gui/501/com.vlad.approver"]).then(() => console.log("GECTI " + n), () => console.log("RED " + n));`);
    expect(r.stdout.trim()).toBe("RED 0");
  });
});
