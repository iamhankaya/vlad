import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listRolesWithWarnings } from "../../src/roles/store.js";
import { makeHome } from "../helpers.js";

const dir = resolve(import.meta.dirname, "..", "..", "roles");

describe("repo roles/", () => {
  beforeEach(() => { makeHome(); }); // schemas come from the throwaway home (a copy of the repo's)

  it("the eleven roles pass the schema with the spec's kinds, skills, model and all four sections", () => {
    const { roles, warnings } = listRolesWithWarnings(dir);
    expect(warnings).toEqual([]);
    expect(Object.fromEntries(roles.map((r) => [r.slug, r.kind]))).toEqual({
      analyst: "advisory", architect: "advisory", designer: "executor", developer: "executor", devops: "executor", finans: "advisory",
      "game-developer": "executor", "game-director": "executor", growth: "advisory", pazarlama: "advisory", tester: "executor",
    });
    for (const r of roles) {
      expect(Array.isArray(r.skills), `${r.slug} skills`).toBe(true);
      expect(r.skills.length, `${r.slug} skills`).toBeGreaterThan(0);
      expect(r.model, `${r.slug} model`).toBe("sonnet");
      const body = readFileSync(r.file, "utf8");
      for (const h of ["## Sorumluluk", "## Yetki", "## Kaynaklar", "## Çıktı"]) expect(body, `${r.slug} ${h}`).toContain(h);
    }
  });

  it("architect carries ### Sistem tasarımı scaled by exposure; analyst carries ### Sistem etkisi", () => {
    const read = (n: string) => readFileSync(resolve(dir, `${n}.md`), "utf8");
    const arch = read("architect");
    expect(arch).toContain("### Sistem tasarımı");
    for (const w of ["exposure", "local", "network", "internet", "açık nokta"]) expect(arch, w).toContain(w);
    const analyst = read("analyst");
    expect(analyst).toContain("### Sistem etkisi");
    expect(analyst).toContain("exposure");
  });

  it("specs and scan skill document exposure and its difference from local_only", () => {
    const root = resolve(dir, "..");
    const read = (p: string) => readFileSync(resolve(root, p), "utf8");
    for (const p of [
      "docs/superpowers/specs/2026-10-15-vlad-roles-design.md",
      "docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md",
    ]) {
      const t = read(p);
      expect(t, p).toContain("exposure");
      expect(t, p).toContain("local_only");
      expect(t, p).toContain("Sistem tasarımı");
    }
    const scan = read(".claude/skills/scan/SKILL.md");
    expect(scan).toContain("exposure");
    expect(scan).toContain("exposure belirsiz");
  });
});

describe("devops role and prova phase", () => {
  const root = resolve(dir, "..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");
  it("devops carries the rehearsal scenarios and the three report sections", () => {
    const body = read("roles/devops.md");
    for (const w of ["umask 077", "bash -s < script", "pipefail", "grep -q", "SIGPIPE", "Boş volume", "Yedek alma", "İdempotent", "Yetkisiz kullanıcı",
      "### Prova matrisi", "### Bulunan hatalar", "### Prova edilemeyenler", "Docker", "Dışa etkili eylem yok"]) expect(body, w).toContain(w);
  });
  it("delegate proposes and status gates on the prova phase; specs and docs list it", () => {
    const delegate = read(".claude/skills/delegate/SKILL.md");
    expect(delegate).toContain("`prova`");
    expect(delegate).toContain("devops");
    const status = read(".claude/skills/status/SKILL.md");
    expect(status).toContain("`prova`");
    expect(status).toMatch(/prova.*kırmızı/s);
    expect(read("docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md")).toContain("`prova`");
    expect(read("docs/superpowers/specs/2026-10-15-vlad-roles-design.md")).toContain("`devops`");
    for (const p of ["CLAUDE.md", "README.md"]) expect(read(p), p).toContain("devops");
  });
});

describe("test hygiene rules", () => {
  for (const slug of ["tester", "developer", "devops"]) {
    it(`${slug} carries the four hygiene rules`, () => {
      const body = readFileSync(resolve(dir, `${slug}.md`), "utf8");
      expect(body).toContain("Test hijyeni");
      expect(body).toMatch(/duvar saati/i);
      expect(body).toMatch(/FakeClock/);
      expect(body).toMatch(/önbellek/);
      expect(body).toMatch(/flake/);
    });
  }
});

describe("work notes (## Çalışma notları) wiring", () => {
  const root = resolve(dir, "..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");
  it("every role's Kaynaklar and vlad-worker tell workers to read the card's Çalışma notları", () => {
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".md"))) {
      expect(read(`roles/${f}`), f).toContain("`## Çalışma notları`");
    }
    expect(read("global/skills/vlad-worker/SKILL.md")).toContain("## Çalışma notları");
  });
  it("digest records findings and keeps the notes; status runs the retro", () => {
    const digest = read(".claude/skills/digest/SKILL.md");
    expect(digest).toContain("vlad finding add");
    expect(digest).toContain("Açık noktalar");
    expect(digest).toContain("`## Çalışma notları`'na **dokunma**");
    const status = read(".claude/skills/status/SKILL.md");
    for (const w of ["### Retro", "vlad project note", "Ne iyi gitti", "Ne sürtündü", "Ders", "roles/"]) expect(status, w).toContain(w);
  });
  it("CLAUDE.md, README and specs document the finding and note commands", () => {
    for (const p of ["CLAUDE.md", "README.md", "docs/superpowers/specs/2026-10-15-vlad-core-design.md"]) {
      expect(read(p), p).toContain("vlad finding");
      expect(read(p), p).toContain("Çalışma notları");
    }
    expect(read("CLAUDE.md")).toContain("vlad project write|set|note|list");
    expect(read("docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md")).toContain("## 15. Bulgu kaydı ve retro");
  });
});

describe("team improvement rules (sözleşme, itiraz, entegrasyon kontrolü, erken denetim, fixture)", () => {
  const root = resolve(dir, "..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");

  it("delegate adds the sözleşme phase to tam/özellik and lists it in phase names", () => {
    const delegate = read(".claude/skills/delegate/SKILL.md");
    expect(delegate).toMatch(/\| `tam` \|.*developer:sözleşme/);
    expect(delegate).toMatch(/\| `özellik` \|.*developer:sözleşme/);
    expect(delegate).toContain("`sözleşme`");
    expect(delegate).toMatch(/atlanabilir/);
    const spec = read("docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md");
    expect(spec).toMatch(/\| `tam` \|.*developer:sözleşme/);
    expect(spec).toContain("## 18.");
  });

  it("test objection flows through ask: developer, worker, status and tester agree", () => {
    for (const f of ["roles/developer.md", "global/skills/vlad-worker/SKILL.md"]) {
      const t = read(f);
      expect(t, f).toContain("Test itirazı");
      expect(t, f).toContain("vlad task ask");
    }
    expect(read(".claude/skills/status/SKILL.md")).toContain("Test itirazı");
    expect(read("roles/tester.md")).toContain("Test itirazı");
    expect(read("roles/developer.md")).not.toMatch(/yanlış görünüyorsa raporda "açık nokta"/);
  });

  it("worker runs the pre-integration check; status checks it at the gate", () => {
    const worker = read("global/skills/vlad-worker/SKILL.md");
    expect(worker).toContain("Entegrasyon öncesi kontrol");
    expect(worker).toMatch(/vlad\/<parent>.*merge/s);
    expect(read(".claude/skills/status/SKILL.md")).toContain("Entegrasyon öncesi kontrol");
  });

  it("architect has the shared-files table; tester and developer obey it", () => {
    expect(read("roles/architect.md")).toContain("### Paylaşılan dosyalar ve ad alanları");
    expect(read("roles/tester.md")).toContain("Paylaşılan dosyalar ve ad alanları");
    expect(read("roles/developer.md")).toContain("Paylaşılan dosyalar ve ad alanları");
  });

  it("early audit, UI self-check and security review are specified consistently", () => {
    const delegate = read(".claude/skills/delegate/SKILL.md");
    expect(delegate).toContain("Erken (ara) denetim");
    expect(delegate).toContain("Güvenlik incelemesi");
    expect(delegate).toContain("security-review");
    expect(read("roles/designer.md")).toContain("ara denetim");
    expect(read("roles/developer.md")).toMatch(/Chromium\/Playwright/);
    const status = read(".claude/skills/status/SKILL.md");
    expect(status).toContain("Güvenlik incelemesi");
    expect(status).toContain("security-review");
    expect(read("CLAUDE.md")).toContain("güvenlik incelemesi");
  });

  it("security review is tiered: critical/high blocks, lower go to findings, 1 round, strict exceptions", () => {
    for (const f of [".claude/skills/status/SKILL.md", ".claude/skills/delegate/SKILL.md"]) {
      const t = read(f);
      expect(t, f).toContain("Kademeli güvenlik kuralı");
      expect(t, f).toMatch(/kritik\/yüksek[^.]*merge/);
      expect(t, f).toMatch(/orta\/düşük\/bilgi[^.]*değişiklik turu açılmaz/);
      expect(t, f).toContain("en çok 1 güvenlik değişiklik turu");
      expect(t, f).toMatch(/exposure[^.]*internet/);
      expect(t, f).toMatch(/sır/);
    }
    expect(read("CLAUDE.md")).toMatch(/kritik\/yüksek[^.]*merge[^.]*orta\/düşük/);
  });

  it("roles ask for real response fixtures on external-API work", () => {
    for (const r of ["analyst", "architect", "tester", "developer"]) {
      expect(read(`roles/${r}.md`), r).toMatch(/gerçek (yanıt|fixture)/);
    }
    expect(read(".claude/skills/delegate/SKILL.md")).toContain("fixture");
  });
});


describe("game/mobile roles and short-writing rule", () => {
  const root = resolve(dir, "..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");

  it("game-developer covers the Godot toolchain and defers project lessons to the card", () => {
    const body = read("roles/game-developer.md");
    for (const w of ["Godot 4", "GDScript", "gdlint", "gdformat", "GUT", "headless", "baseline", "Android export", "`## Çalışma notları`"]) expect(body, w).toContain(w);
  });

  it("game-director is read-only for production code, writes docs/review and asks for play notes", () => {
    const body = read("roles/game-director.md");
    for (const w of ["docs/review/", "--write-movie", "vlad task ask", "oynanış notu", "roadmap", "şimdi", "kaynak URL"]) expect(body, w).toContain(w);
  });

  it("game roles generate visuals/icons with Codex, short video with Gemini, show the user first and note source/model", () => {
    for (const r of ["game-developer", "game-director"]) {
      const body = read(`roles/${r}.md`);
      for (const w of ["codex exec", "Gemini", "kullanıcıya göster", "model notu"]) expect(body, `${r}: ${w}`).toContain(w);
    }
  });

  it("growth only drafts: no accounts, posts or contact", () => {
    const body = read("roles/growth.md");
    for (const w of ["ASO", "SEO", "Discord", "TikTok", "haftalık", "hesap açmaz", "paylaşım yapmaz", "iletişime geçmez"]) expect(body, w).toContain(w);
  });

  it("designer keeps the web rules and gains a mobile section; pazarlama gains a game section split with growth", () => {
    const d = read("roles/designer.md");
    for (const w of ["docs/design/", "`tasarım`", "`denetim`", "Jetpack Compose", "Material 3", "48dp", "edge-to-edge", "TalkBack", "Roborazzi", "Paparazzi", ".claude/skills"]) expect(d, w).toContain(w);
    const p = read("roles/pazarlama.md");
    for (const w of ["konumlandırma", "lansman", "monetizasyon", "`growth`"]) expect(p, w).toContain(w);
  });

  it("vlad-worker carries the short-writing rule without changing the report template; CLAUDE.md lists the new roles", () => {
    const w = read("global/skills/vlad-worker/SKILL.md");
    expect(w).toContain("Kısa yazım");
    expect(w).toContain("kararların gerekçesi");
    for (const h of ["### Yapılanlar", "### Test sonuçları", "### Kabul kriterleri", "### Açık noktalar"]) expect(w, h).toContain(h);
    expect(read("src/tasks/cloud.ts")).toContain("Kısa yaz");
    const c = read("CLAUDE.md");
    for (const r of ["game-developer", "game-director", "growth"]) expect(c, r).toContain(r);
  });
});

describe("ponytail (vendored, developer + game-developer only)", () => {
  const root = resolve(dir, "..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf8");
  const SOURCE_BLOB = "d64edd32265ba21cbf5270158f04e97d96925f27"; // DietrichGebert/ponytail@09c434a skills/ponytail/SKILL.md

  it("SKILL.md is byte-identical to the source blob; only SOURCE.md and LICENSE sit beside it", () => {
    const body = Buffer.from(read(".claude/skills/ponytail/SKILL.md").replace(/\r\n/g, "\n"), "utf8");
    const sha = createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
    expect(sha).toBe(SOURCE_BLOB);
    expect(readdirSync(resolve(root, ".claude/skills/ponytail")).sort()).toEqual(["LICENSE", "SKILL.md", "SOURCE.md"]);
    const source = read(".claude/skills/ponytail/SOURCE.md");
    for (const w of ["github.com/DietrichGebert/ponytail", "09c434ab73ca43761c5d8b0c5d341926c2fba710", SOURCE_BLOB, "MIT"]) expect(source, w).toContain(w);
    expect(read(".claude/skills/ponytail/LICENSE")).toContain("MIT License");
  });

  it("only developer and game-developer list ponytail in skills", () => {
    const { roles } = listRolesWithWarnings(dir);
    expect(roles.filter((r) => r.skills.includes("ponytail")).map((r) => r.slug).sort()).toEqual(["developer", "game-developer"]);
  });

  it("both roles state the priority rules: TDD/gate first, tests for behavior change, full level only, skipped items in Açık noktalar", () => {
    for (const r of ["developer", "game-developer"]) {
      const body = read(`roles/${r}.md`);
      for (const w of ["ponytail", "gate", "davranış değişikliği = test", "yalnız `full`", "vlad task ask", "### Açık noktalar"]) expect(body, `${r}: ${w}`).toContain(w);
    }
  });

  it("CLAUDE.md notes the trial in the roles paragraph", () => {
    const c = read("CLAUDE.md");
    expect(c).toContain("ponytail");
    expect(c).toMatch(/ponytail.*deneme/);
  });
});
