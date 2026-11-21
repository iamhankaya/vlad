import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnGuarded } from "../support/spawn-vlad.js";
import { rmTemp } from "../helpers.js";
import { trustKey } from "../../src/tasks/trust.js";
import { IS_WIN } from "../support/platform.js";

/** POSIX tek tırnaklı sözcükleri ayrıştırır (q() çıktısı: '…', içteki tırnak '\''); `|| true` kuyruğu atılır. Windows'ta bash yok/PATH'te olmayabilir (servis PATH'i). */
const argvOf = (line: string): string[] => {
  const s = line.replace(/\s*\|\|\s*true\s*$/, ""), out: string[] = [];
  let cur = "", has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'") { i++; while (i < s.length && s[i] !== "'") cur += s[i++]; has = true; } // tek tırnak içi düz metin
    else if (c === "\\") { cur += s[++i] ?? ""; has = true; } // '\'' dizisindeki kaçışlı tırnak
    else if (c === " ") { if (has) { out.push(cur); cur = ""; has = false; } }
    else { cur += c; has = true; }
  }
  if (has) out.push(cur);
  return out;
};

const DIST = join(import.meta.dirname, "..", "..", "dist");

// F-vlad-266: the preflight `node -e import(<file url>)` only resolves from the built dist (src/*.ts is not loadable by plain node);
// the unit tests import the src module, so only the dist copy proves the URL points at a real trust.js.
describe("launch script trust preflight (dist)", () => {
  it("the preflight line of a dist-built script resolves to dist/tasks/trust.js and writes the trust record", async () => {
    expect(existsSync(join(DIST, "tasks", "trust.js"))).toBe(true);
    const { buildPosixScript } = (await import(join(DIST, "launcher", "posix.js"))) as typeof import("../../src/launcher/posix.js");
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "vlad-trust-pre-")));
    try {
      const cwd = join(tmp, "wt");
      const script = buildPosixScript({ cwd, title: "t", prompt: "p", env: {} } as never);
      const line = script.split("\n").find((l) => l.includes("-e") && l.includes("trust.js"));
      expect(line).toBeDefined();
      expect(line).toContain(join("dist", "tasks", "trust.js").replaceAll("\\", "/"));
      const claudeJson = join(tmp, "claude.json");
      const env = { PATH: process.env.PATH ?? "", HOME: tmp, VLAD_CLAUDE_JSON: claudeJson };
      // Windows: gate servis PATH'inde bash yoksa (status null / ENOENT) test kırılıyordu; orada satırın argv'si doğrudan node ile koşulur (aynı dist/tasks/trust.js URL'si, aynı kayıt).
      // POSIX'te bash -c kalır: tırnaklama doğruluğunu da sınar.
      const r = IS_WIN
        ? (() => { const [exe, ...rest] = argvOf(line as string); return spawnGuarded(exe!, rest, { encoding: "utf8", env }); })()
        : spawnGuarded("bash", ["-c", line as string], { encoding: "utf8", env });
      expect(r.status, `status=${r.status} error=${r.error?.message ?? ""} stderr=${r.stderr}`).toBe(0);
      expect(r.stderr).toBe("");
      const j = JSON.parse(readFileSync(claudeJson, "utf8")) as { projects: Record<string, unknown> };
      expect(Object.keys(j.projects)).toContain(trustKey(cwd)); // ürün anahtarı bilerek `/` ile yazar (Windows'ta `\` değil)
    } finally { rmTemp(tmp); }
  });
});
