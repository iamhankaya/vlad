import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const doc = readFileSync(join(process.cwd(), "docs", "mac-ci-runner.md"), "utf8");

describe("docs/mac-ci-runner.md", () => {
  it("F-vlad-249: runner'dan önce chmod 700 ~ ve sudo -u vlad-ci doğrulaması", () => {
    expect(doc).toContain("chmod 700 ~");
    expect(doc).toMatch(/sudo -u vlad-ci ls ~/);
    expect(doc.indexOf("chmod 700 ~")).toBeLessThan(doc.indexOf("## Kurulum (vlad-ci hesabında)"));
  });
  it("F-vlad-251: token pbpaste ile değil read -rs ile verilir; keychain uyarısı var", () => {
    expect(doc).not.toContain("pbpaste |");
    expect(doc).toContain("read -rs");
    expect(doc).toMatch(/anahtar zinciri|keychain/i);
    expect(doc).toMatch(/workflow kod\w* (açık|erişebilir)/i);
  });
});
