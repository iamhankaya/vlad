// V02 doğrulama bulgusu: kb kilidinin geçici dosyaları (`.vlad.lock.<pid>-<rnd>.tmp`, `.vlad.lock.break`, `.vlad.lock.stale-*`)
// kb .gitignore'ında yok → eşzamanlı `kb commit` (git add .) bu dosyaya takılıp "unable to index file" ile düşer ya da dosyayı commit'ler.
// Geçici dünyada, sahte kaynakla; gerçek kb'ye dokunmaz.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, makeWorld, runVlad, type World } from "./machines-world.js";

let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });

describe("machines:V — kb kilit geçici dosyaları commit'e girmez", () => {
  it.each([".vlad.lock.4242-abc123.tmp", ".vlad.lock.break", ".vlad.lock.stale-4242-abc123"])("%s kb commit'e girmez", async (name) => {
    w = await makeWorld({ cardMachines: ["windows"] });
    const kb = w.brain.kb;
    writeFileSync(join(kb, name), "{}");
    writeFileSync(join(kb, "ornek.md"), "x\n"); // commit edilecek gerçek bir değişiklik
    const r = await runVlad(w.brain, ["kb", "commit", "v02"]);
    expect(r.code, r.err).toBe(0);
    const files = git(kb, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    expect(files).toContain("ornek.md");
    expect(files, `kilit geçici dosyası commit'lendi: ${name}`).not.toContain(name);
  }, 60_000);
});
