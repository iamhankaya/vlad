import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initKey, mintOpToken, setSecretDirForTests } from "../../src/mode/token.js";

// Süreç kovası: child_process + dist kullanır (vmt2 unit dosyası spawn içeremez: buckets.test).
let base: string;
const ARGV = ["mode", "off"];
beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "vlad-vmt2race-"))); setSecretDirForTests(join(base, "s")); initKey(); });
afterEach(() => { setSecretDirForTests(null); if (base.startsWith(realpathSync(tmpdir()))) rmSync(base, { recursive: true, force: true }); });

describe("approver: vmt2 yarış", () => {
  it("iki süreç aynı tokenı yarıştırır: tam bir başarı", () => {
    const tok = mintOpToken(ARGV, 60_000, new Date());
    const dist = resolve("dist/mode/token.js");
    const code = `import(${JSON.stringify(pathToFileURL(dist).href)}).then(m=>{m.setSecretDirForTests(${JSON.stringify(join(base, "s"))});try{m.requireModeAuthority({VLAD_MODE_TOKEN:${JSON.stringify(tok)}},new Date(),["mode","off"]);console.log("OK")}catch(e){console.log("FAIL")}})`;
    return Promise.all([spawnAsync(code), spawnAsync(code), spawnAsync(code), spawnAsync(code)]).then((out) => {
      expect(out.filter((o) => o === "OK")).toHaveLength(1);
      expect(out.filter((o) => o === "FAIL")).toHaveLength(3);
    });
  });
});

function spawnAsync(code: string): Promise<string> {
  return new Promise((res) => {
    const c = spawn(process.execPath, ["-e", code]);
    let o = ""; c.stdout.on("data", (d) => { o += d; });
    c.on("close", () => res(o.trim()));
  });
}
