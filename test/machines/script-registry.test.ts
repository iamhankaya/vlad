import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateScriptManifest } from "../../src/agent/scripts/manifest.js";

// Gerçek agent-scripts/ kayıt defteri: manifest geçerli, karmalar dosya baytlarıyla eşleşir, .ps1 ASCII, tehlikeli kalıp yok.
const root = resolve(import.meta.dirname, "../..");
const manifest = validateScriptManifest(JSON.parse(readFileSync(resolve(root, "agent-scripts/manifest.json"), "utf8")));

describe("agent-scripts kayıt defteri", () => {
  it("repo-guncelle her platformda kayıtlı, write sınıfı, selfUpdate kapalı", () => {
    for (const p of ["win32", "darwin", "linux"]) {
      const e = manifest.scripts.find((s) => s.name === "repo-guncelle" && s.platform === p);
      expect(e, p).toBeDefined();
      expect(e!.class).toBe("write");
      expect(e!.selfUpdate).toBe(false);
    }
  });
  it("sha256 dosya baytlarıyla eşleşir (eski ise: node scripts/agent-scripts-sha.mjs --write)", () => {
    for (const e of manifest.scripts) {
      const sha = createHash("sha256").update(readFileSync(resolve(root, e.file))).digest("hex");
      expect(sha, `${e.name}/${e.platform}`).toBe(e.sha256);
    }
  });
  it("betikler ASCII (PS 5.1 BOM'suz dosyayı ANSI okur) ve CRLF içermez", () => {
    for (const e of manifest.scripts) {
      const b = readFileSync(resolve(root, e.file));
      expect(b.every((x) => x < 0x80), e.file).toBe(true);
      expect(b.includes(13), `${e.file} CR`).toBe(false);
    }
  });
  it("iex / Invoke-Expression / eval yok", () => {
    for (const e of manifest.scripts) {
      const t = readFileSync(resolve(root, e.file), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
      expect(t, e.file).not.toMatch(/\biex\b|Invoke-Expression|\beval\b/i);
    }
  });
});
