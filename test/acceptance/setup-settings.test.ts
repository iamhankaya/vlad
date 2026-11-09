// Kabul (T20261110-04; spec T20261110-02): ~/.claude/settings.json birleşimi ve korunumu — S4, S5, S6, S12, S14 (izin kalıpları).
// Uygulama (T20261110-05) gelene dek KIRMIZI olması beklenir.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backups, makeSandbox, s1Answers, snapshot } from "../support/setup-sandbox.js";

const userSettings = () => ({
  model: "opus",
  autoMode: { environment: ["kullanıcıya özel metin"] },
  hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo kullanici-hook" }] }] },
  permissions: { allow: ["Bash(ls:*)"] },
});

describe("S4: var olan kullanıcı ayarı korunur", () => {
  it("kullanıcı anahtarları/kalıpları korunur, yalnız eksik VLAD girişi eklenir, tek yedek alınır", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const orig = userSettings();
    sb.writeSettings(orig);
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb))]);
    expect(r.code, r.err + r.out).toBe(0);
    const s = sb.settings();
    expect(s.model).toBe("opus");
    expect(s.autoMode).toEqual(orig.autoMode);
    expect(s.permissions.allow).toContain("Bash(ls:*)");
    const cmds = s.hooks.SessionEnd.flatMap((e: any) => e.hooks.map((h: any) => h.command));
    expect(cmds).toContain("echo kullanici-hook");
    expect(cmds.filter((c: string) => c.includes("session-report.js"))).toHaveLength(1);
    const bak = backups(sb.claudeDir);
    expect(bak).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(sb.claudeDir, bak[0]!), "utf8"))).toEqual(orig); // yedek özgün içerik
  });
  it("ters timeout'lu mevcut VLAD hook'u 'çakışan' raporlanır ve değiştirilmez", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const cmd = `node "${join(sb.vladHome, "dist", "hooks", "session-report.js").replace(/\\/g, "/")}"`;
    sb.writeSettings({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: cmd, timeout: 3 }] }] } });
    const before = readFileSync(join(sb.claudeDir, "settings.json"), "utf8");
    const c = sb.run(["setup", "--check", "--json"]);
    const hooks = JSON.parse(c.out).parts.find((p: any) => p.part === "hooks");
    expect(hooks.status).toBe("çakışan");
    expect(c.code).toBe(1);
    expect(readFileSync(join(sb.claudeDir, "settings.json"), "utf8")).toBe(before);
  });
});

describe("S5: bozuk settings.json", () => {
  it("kurulum durur, dosyaya yazmaz, çıkış 1, yol mesajda", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const f = sb.writeSettings('{ "model": "opus", ');
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb))]);
    expect(r.code).toBe(1);
    expect(r.err + r.out).toContain("settings.json");
    expect(readFileSync(f, "utf8")).toBe('{ "model": "opus", ');
    expect(backups(sb.claudeDir)).toEqual([]);
    expect(existsSync(join(sb.vladHome, "vlad.config.local.json"))).toBe(false);
  });
});

describe("S6: yükseltme drift'i", () => {
  it("--check global-skills: eski (çıkış 1); --upgrade --yes eşitler; elle değişen dosya yedeklenir", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const ok = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb))]);
    expect(ok.code, ok.err + ok.out).toBe(0);
    const skill = join(sb.claudeDir, "skills", "vlad-worker", "SKILL.md");
    const repoText = readFileSync(join(sb.vladHome, "global", "skills", "vlad-worker", "SKILL.md"), "utf8");
    writeFileSync(skill, "# elle değiştirilmiş eski sürüm\n");
    const c = sb.run(["setup", "--check", "--json"]);
    expect(c.code).toBe(1);
    expect(JSON.parse(c.out).parts.find((p: any) => p.part === "global-skills").status).toBe("eski");
    const up = sb.run(["setup", "--upgrade", "--yes"]);
    expect(up.code, up.err + up.out).toBe(0);
    expect(readFileSync(skill, "utf8")).toBe(repoText);
    expect(up.out).toMatch(/vlad-worker/); // fark/üzerine yazma gösterilir
    const kept = Object.entries(snapshot(sb.claudeDir)).filter(([k]) => /bak/.test(k) && /vlad-worker/.test(k));
    expect(kept.length, "elle değişen dosya yedeklenmeli").toBeGreaterThan(0);
    expect(sb.run(["setup", "--check"]).code).toBe(0);
  });
});

describe("S12: kullanıcının kendi kurulumu etkilenmez", () => {
  it("--check ve --dry-run hiçbir dosyayı değiştirmez; overlay yokken tracked config bayt aynı", () => {
    const sb = makeSandbox({ platform: "darwin" });
    sb.writeSettings(userSettings());
    mkdirSync(join(sb.claudeDir, "skills", "vlad-worker"), { recursive: true });
    writeFileSync(join(sb.claudeDir, "skills", "vlad-worker", "SKILL.md"), "eski\n");
    const before = [snapshot(sb.claudeDir), snapshot(sb.vladHome)];
    const c = sb.run(["setup", "--check", "--json"]);
    expect([0, 1]).toContain(c.code);
    expect(() => JSON.parse(c.out)).not.toThrow();
    const d = sb.run(["setup", "--dry-run", "--yes", "--answers", sb.answers(s1Answers(sb))]);
    expect(d.code, d.err + d.out).toBe(0);
    expect([snapshot(sb.claudeDir), snapshot(sb.vladHome)]).toEqual(before);
    expect(existsSync(join(sb.vladHome, "vlad.config.local.json"))).toBe(false);
    expect(existsSync(sb.kbDir)).toBe(false);
  });
});

describe("S14: izin kalıpları yalnız en dar liste", () => {
  it("perms:true + confirm permissions-write: geniş kalıp yazılmaz; vlad-worker push kalıpları var", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb, { perms: true, autonomy: "pr", confirm: ["permissions-write"] }))]);
    expect(r.code, r.err + r.out).toBe(0);
    const allow: string[] = sb.settings().permissions?.allow ?? [];
    expect(allow).toContain("Bash(git push origin vlad/*)");
    for (const bad of ["Bash(*)", "Bash(git push:*)", "Bash(git:*)", "Bash"]) expect(allow, bad).not.toContain(bad);
  });
  it("perms:true ama confirm yok: --yes izin yazmayı ATLAMAZ → izin kalıbı yazılmaz", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb, { perms: true, autonomy: "pr" }))]);
    expect(r.code, r.err + r.out).toBe(0);
    const allow: string[] = sb.settings().permissions?.allow ?? [];
    expect(allow.some((p) => p.startsWith("Bash(git push"))).toBe(false);
  });
});
