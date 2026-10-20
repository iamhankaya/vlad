import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
const architect = read("roles/architect.md");
const analyst = read("roles/analyst.md");
const rolesSpec = read("docs/superpowers/specs/2026-10-15-vlad-roles-design.md");
const pipelineSpec = read("docs/superpowers/specs/2026-10-16-vlad-pipeline-design.md");
const scan = read(".claude/skills/scan/SKILL.md");
const schema = JSON.parse(read("schemas/project.schema.json"));

/** The bullet under `### Sistem tasarımı` that starts with "- `<mode>`:" (architect) */
const archBullet = (mode: string) => architect.split("\n").find((l) => l.trim().startsWith(`- \`${mode}\``) && l.includes("—")) ?? "";
/** The roles-spec table row for a mode */
const specRow = (mode: string) => rolesSpec.split("\n").find((l) => l.startsWith(`| \`${mode}\``)) ?? "";

const LOCAL = ["süreç modeli", "veri/dosya saklama", "yetkiler", "kurtarma", "dağıtım"];
const INTERNET = ["veri akışı", "depolama/cache", "ölçeklenme", "gerçek zamanlı topoloji", "auth/güvenlik", "altyapı", "hata senaryoları", "maliyet"];
const NETWORK = ["veri akışı", "yetki/kimlik doğrulama", "depolama", "hata senaryoları"];

describe("exposure: role/spec text matches the schema and each other", () => {
  it("the enum in the schema is exactly the three modes every document names", () => {
    expect(schema.properties.exposure.enum).toEqual(["local", "network", "internet"]);
    for (const t of [architect, analyst, pipelineSpec, scan]) expect(t).toContain("local | network | internet");
  });

  it("architect and roles spec list the same required topics per mode", () => {
    for (const [mode, topics] of [["local", LOCAL], ["network", NETWORK], ["internet", INTERNET]] as const) {
      expect(archBullet(mode), `architect ${mode}`).not.toBe("");
      expect(specRow(mode), `spec ${mode}`).not.toBe("");
      for (const t of topics) {
        expect(archBullet(mode), `architect ${mode}: ${t}`).toContain(t);
        expect(specRow(mode), `spec ${mode}: ${t}`).toContain(t);
      }
    }
  });

  it("depth ordering holds: local is short, internet full, network in between", () => {
    expect(archBullet("local")).toContain("kısa");
    expect(archBullet("internet")).toContain("tam");
    expect(archBullet("network")).toMatch(/`local` ile `internet` arası/);
    // local must not demand internet-only topics
    for (const t of ["ölçeklenme", "gerçek zamanlı topoloji", "maliyet"]) expect(archBullet("local"), t).not.toContain(t);
  });

  it("empty field is never guessed: architect, analyst, spec and scan all say so", () => {
    expect(architect).toMatch(/### Açık noktalar`'a "exposure belirsiz/);
    expect(analyst).toMatch(/exposure. boşsa tahmin etme.*"exposure belirsiz"/);
    expect(rolesSpec).toContain('"exposure belirsiz"');
    expect(pipelineSpec).toContain("exposure belirsiz");
    expect(scan).toMatch(/tahmin etme; kullanıcıya sor/);
  });

  it("no-impact work gets a one-line rationale in both roles", () => {
    expect(architect).toContain("tek satır gerekçe");
    expect(analyst).toContain("tek satır gerekçe");
  });

  it("every file that mentions exposure keeps the local_only distinction the right way round", () => {
    for (const [n, t] of [["architect", architect], ["roles spec", rolesSpec], ["pipeline spec", pipelineSpec], ["scan", scan]] as const) {
      expect(t, n).toContain("local_only");
      expect(t, n).toMatch(/bulutta derlen/);
      expect(t, n).toMatch(/kim erişir|kimin eriştiğini|erişim kapsamı/);
    }
  });

  it("analyst's Sistem etkisi sits between Senaryolar and Fazlar; architect's between Bileşenler and Arayüzler", () => {
    const idx = (t: string, h: string) => t.indexOf(h);
    const a = (h: string) => idx(analyst, `- \`${h}\` —`);
    expect(a("### Senaryolar")).toBeGreaterThan(-1);
    expect(a("### Senaryolar")).toBeLessThan(a("### Sistem etkisi"));
    expect(a("### Sistem etkisi")).toBeLessThan(a("### Fazlar"));
    const item = (h: string) => idx(architect, `- \`${h}\` —`); // Çıktı list items, not prose mentions
    expect(item("### Bileşenler")).toBeGreaterThan(-1);
    expect(item("### Bileşenler")).toBeLessThan(item("### Sistem tasarımı"));
    expect(item("### Sistem tasarımı")).toBeLessThan(item("### Arayüzler"));
  });

  it("pipeline spec: tam uses Sistem tasarımı, özellik uses Sistem etkisi, and the roles spec cross-reference exists", () => {
    expect(pipelineSpec).toMatch(/`tam` döngüsünde[^.]*Sistem tasarımı/);
    expect(pipelineSpec).toMatch(/`özellik` döngüsünde[^.]*Sistem etkisi/);
    expect(pipelineSpec).toContain("roller spec'i §4");
    expect(rolesSpec).toMatch(/^## 4\. /m);
  });
});

describe("exposure: workflow wiring (delegate, tester, developer)", () => {
  const delegate = read(".claude/skills/delegate/SKILL.md");
  const tester = read("roles/tester.md");
  const developer = read("roles/developer.md");

  it("delegate shows exposure in both drafts, uses it for cycle choice, and flags unknown", () => {
    expect(delegate.match(/\*\*Exposure:\*\*/g)?.length).toBe(2);
    expect(delegate).toMatch(/`exposure` işareti[^\n]*en az `özellik`/);
    expect(delegate).toContain("exposure belirsiz");
  });
  it("tester reads Sistem tasarımı/Sistem etkisi failure scenarios as test candidates", () => {
    expect(tester).toContain("### Sistem tasarımı");
    expect(tester).toContain("### Sistem etkisi");
    expect(tester).toMatch(/test senaryosu adayı/);
  });
  it("developer reports conformance to the system design", () => {
    expect(developer).toContain("sistem tasarımına uyum");
    expect(developer).toMatch(/uyuldu \/ sapıldı/);
  });
  it("both specs describe the wiring", () => {
    for (const s of [rolesSpec, pipelineSpec]) {
      expect(s).toContain("sistem tasarımına uyum");
    }
    expect(rolesSpec).toContain("test adayı");
    expect(pipelineSpec).toContain("test adayı");
  });
});
