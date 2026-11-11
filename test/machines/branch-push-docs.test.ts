import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_DOCS } from "../../src/commands/docs-data.js";

// Kabul (T20261111-51, F-vlad-314, kabul kriteri 4): yeni CLI yüzeyi yok, ama `task close` davranışı değişir ve işçide git push
// önkoşulu doğar; belge + docs-data güncel olmalı. Uygulamaya bakılmadan yazıldı: KIRMIZI başlar.
const root = resolve(import.meta.dirname, "../..");
const read = (f: string) => readFileSync(resolve(root, f), "utf8");

describe("docs: uzak görev push/fetch akışı", () => {
  it("docs-data `task close` uzak akışı anlatır: branch-push, origin, fetch, merge beyinde, force yok", () => {
    const d = COMMAND_DOCS["task close"];
    expect(d).toMatch(/branch-push/);
    expect(d).toMatch(/origin/);
    expect(d).toMatch(/fetch/);
    expect(d).toMatch(/beyin/i);
  });
  it("docs/commands.md aynı metni taşır (üretilmiş belge güncel)", () => {
    const t = read("docs/commands.md");
    expect(t).toMatch(/branch-push/);
    expect(t).toMatch(/`task close`|vlad task close/);
  });
  it("docs-data `task merge` uzak görevde close'a yönlendirir ya da farkı yazar (işçide yalnız yerel merge)", () => {
    expect(COMMAND_DOCS["task merge"]).toMatch(/close|branch-push|origin/);
  });
  it("docs/machines-setup.md işçide etkileşimsiz git push kimliği önkoşulunu ve branch-push'u anlatır (spec açık soru 6)", () => {
    const t = read("docs/machines-setup.md");
    expect(t).toMatch(/branch-push/);
    expect(t).toMatch(/push/i);
    expect(t).toMatch(/origin/);
  });
  it("docs/machines-agent-security.md yeni yazma yüzeyini (vlad/T… ad alanı, force'suz, brain→worker) belgeler", () => {
    const t = read("docs/machines-agent-security.md");
    expect(t).toMatch(/branch-push/);
    expect(t).toMatch(/force/i);
  });
});
