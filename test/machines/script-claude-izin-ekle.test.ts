import { spawnGuarded as spawnSync } from "../support/spawn-vlad.js";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateScriptManifest } from "../../src/agent/scripts/manifest.js";

// agent-scripts/claude-izin-ekle.ps1 (T20261124-02): yalnız win32, sabit izin listesi, ayarlara idempotent ekleme.
// Betik mantığı yalnız pwsh varsa koşar (Mac'te pwsh yok → atlanır; gerçek doğrulama Windows PowerShell 5.1'de).
const root = resolve(import.meta.dirname, "../..");
const manifest = validateScriptManifest(JSON.parse(readFileSync(resolve(root, "agent-scripts/manifest.json"), "utf8")));
const entry = manifest.scripts.filter((s) => s.name === "claude-izin-ekle");
const body = readFileSync(resolve(root, "agent-scripts/claude-izin-ekle.ps1"), "utf8");

const EXPECTED = [
  "Bash(git fetch origin vlad/*)", "PowerShell(git fetch origin vlad/*)", "Bash(git reset --hard FETCH_HEAD)", "PowerShell(git reset --hard FETCH_HEAD)",
  "Bash(git checkout --detach FETCH_HEAD)", "PowerShell(git checkout --detach FETCH_HEAD)",
  "Bash(powershell -NoProfile -File build.ps1*)", "PowerShell(powershell -NoProfile -File build.ps1*)", "PowerShell(.\\build.ps1*)", "PowerShell(./build.ps1*)",
  "Bash(npm ci*)", "PowerShell(npm ci*)", "Bash(npm test*)", "PowerShell(npm test*)", "Bash(npm run build*)", "PowerShell(npm run build*)",
  "Bash(npm run lint*)", "PowerShell(npm run lint*)", "Bash(npx vitest run*)", "PowerShell(npx vitest run*)", "Bash(dotnet test*)", "PowerShell(dotnet test*)",
  "Bash(bash tools/gate.sh*)", "Bash(pip install -q -r tools/ci/requirements-ci.txt*)", "PowerShell(pip install -q -r tools/ci/requirements-ci.txt*)",
  "PowerShell(winget install --id OpenJS.NodeJS*)", "PowerShell(winget install --id Microsoft.VisualStudio.2022.BuildTools*)",
];

describe("claude-izin-ekle kaydı", () => {
  it("yalnız win32, write, parametresiz, kısa zaman aşımı, selfUpdate kapalı", () => {
    expect(entry.map((e) => e.platform)).toEqual(["win32"]);
    expect(entry[0]).toMatchObject({ class: "write", selfUpdate: false, params: [], timeoutSec: 60, outputMaxKb: 16, file: "agent-scripts/claude-izin-ekle.ps1" });
  });
  it("betik sabit listeyi birebir içerir (27 kural) ve dışarıdan kural almaz", () => {
    const quoted = [...body.matchAll(/^\s*'([^']+)'\s*,?\s*$/gm)].map((m) => m[1]);
    expect(quoted).toEqual(EXPECTED);
    expect(body).not.toMatch(/VLAD_PARAM|VLAD_ROOTS/);
  });
  it("davranış sözleşmesi: yedek, BOM'suz UTF-8, yeniden ayrıştırma doğrulaması, sonuç satırı", () => {
    expect(body).toContain("settings.json.bak-");
    expect(body).toMatch(/UTF8Encoding\(\$false\)/);
    expect(body).toMatch(/yeniden ayristir/i);
    expect(body).toContain("@@VLAD-RESULT@@");
  });
});

const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function run(home: string) {
  const r = spawnSync("pwsh", ["-NoProfile", "-File", resolve(root, "agent-scripts/claude-izin-ekle.ps1")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home } });
  const line = r.stdout.split("\n").find((l) => l.startsWith("@@VLAD-RESULT@@ "));
  return { code: r.status, res: line ? JSON.parse(line.slice(16)) : null, stderr: r.stderr };
}
describe.skipIf(pwsh.status !== 0)("claude-izin-ekle mantığı (pwsh)", () => {
  const mk = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "vlad-cie-"))); dirs.push(d); return d; };
  const settings = (h: string) => join(h, ".claude", "settings.json");
  it("ayar yok: {} ile başlar, 27 kural ekler; ikinci koşu 0 ekler", () => {
    const h = mk();
    expect(run(h).res).toMatchObject({ ok: true, added: 27 });
    expect(JSON.parse(readFileSync(settings(h), "utf8")).permissions.allow).toEqual(EXPECTED);
    expect(run(h).res).toMatchObject({ ok: true, added: 0 });
  });
  it("var olan ayar: yedek alır, diğer anahtarlara ve mevcut kurallara dokunmaz, kopya yok", () => {
    const h = mk();
    mkdirSync(join(h, ".claude"));
    writeFileSync(settings(h), JSON.stringify({ model: "x", permissions: { allow: ["Bash(ls)", EXPECTED[0]], deny: ["Bash(rm *)"] } }));
    expect(run(h).res).toMatchObject({ ok: true, added: 26 });
    const j = JSON.parse(readFileSync(settings(h), "utf8"));
    expect(j.model).toBe("x");
    expect(j.permissions.deny).toEqual(["Bash(rm *)"]);
    expect(j.permissions.allow.slice(0, 2)).toEqual(["Bash(ls)", EXPECTED[0]]);
    expect(new Set(j.permissions.allow).size).toBe(j.permissions.allow.length);
    expect(readdirSync(join(h, ".claude")).some((n) => n.startsWith("settings.json.bak-"))).toBe(true);
  });
  it("bozuk JSON: dokunmaz, hata verir", () => {
    const h = mk();
    mkdirSync(join(h, ".claude"));
    writeFileSync(settings(h), "{ bozuk");
    expect(run(h).code).not.toBe(0);
    expect(readFileSync(settings(h), "utf8")).toBe("{ bozuk");
  });
});
