// Kabul (T20261110-04; spec T20261110-02): `vlad setup` tek makine senaryoları S1, S2, S3, S7. Temiz HOME, gerçek dist/cli.js, sahte araçlar.
// Uygulama (T20261110-05) gelene dek KIRMIZI olması beklenir: `vlad setup` komutu henüz yok.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KB_GITIGNORE } from "../../src/kb/commit.js";
import { backups, makeSandbox, mtimes, s1Answers, snapshot } from "../support/setup-sandbox.js";

const jsonOf = (s: string) => JSON.parse(s);

describe("S1: Mac, tek makine, yerel kb (mutlu yol)", () => {
  const sb = makeSandbox({ platform: "darwin" });
  const run = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb))]);

  it("çıkış 0", () => { expect(run.code, run.err + run.out).toBe(0); });
  it("settings.json oluşur: yalnız VLAD SessionEnd girişi (timeout>=10), kullanıcı kalıpsız", () => {
    const s = sb.settings();
    const cmds = (s.hooks?.SessionEnd ?? []).flatMap((e: any) => e.hooks ?? []);
    expect(cmds).toHaveLength(1);
    expect(cmds[0].command).toContain("session-report.js");
    expect(cmds[0].timeout).toBeGreaterThanOrEqual(10);
    expect(Object.keys(s.hooks)).toEqual(["SessionEnd"]);
  });
  it("global skill'ler kurulur (vlad-worker, ci-triage)", () => {
    for (const n of ["vlad-worker", "ci-triage"]) expect(existsSync(join(sb.claudeDir, "skills", n, "SKILL.md")), n).toBe(true);
  });
  it("vlad.config.local.json var; machines/brain yok; kbDir sandbox içinde", () => {
    const f = join(sb.vladHome, "vlad.config.local.json");
    expect(existsSync(f)).toBe(true);
    const c = jsonOf(readFileSync(f, "utf8"));
    // tracked vlad.config.json (kopya) machines+brain taşır: tek makine overlay'i bunları açıkça siler (null)
    expect(c.machines).toBeNull();
    expect(c.brain).toBeNull();
    expect(c.kbDir).toBe(sb.kbDir);
  });
  it("kb dizini git repo ve .gitignore yerel-durum satırlarını içerir", () => {
    expect(existsSync(join(sb.kbDir, ".git"))).toBe(true);
    const gi = readFileSync(join(sb.kbDir, ".gitignore"), "utf8").split(/\r?\n/);
    for (const l of KB_GITIGNORE) expect(gi, l).toContain(l);
  });
  it("tracked vlad.config.json değişmez", () => {
    expect(readFileSync(join(sb.vladHome, "vlad.config.json"), "utf8")).toBe(readFileSync(join(import.meta.dirname, "..", "..", "vlad.config.json"), "utf8"));
  });
  it("setup --check çıkış 0 ve --json şemaya uyar", () => {
    const c = sb.run(["setup", "--check", "--json"]);
    expect(c.code, c.err + c.out).toBe(0);
    const j = jsonOf(c.out);
    expect(j).toMatchObject({ version: 1, platform: "darwin", exit: 0, ok: true });
    expect(j.parts.map((p: any) => p.part)).toEqual(expect.arrayContaining(["cli", "global-skills", "hooks", "config", "kb", "tools"]));
  });
  it("status --summary boş kb özeti basar", () => {
    const st = sb.run(["status", "--no-mark", "--summary"]);
    expect(st.code, st.err).toBe(0);
    expect(st.out).toMatch(/İşlenmemiş 0 rapor, 0 aktif görev/);
  });
});

describe("S2: Windows, tek makine (platform simülasyonu)", () => {
  const sb = makeSandbox({ platform: "win32" });
  const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb, { launcher: "auto" }))]);
  it("çıkış 0; Agent/menü adımları tek makinede atlanır, onaysız schtasks/reg çağrısı yok", () => {
    expect(r.code, r.err + r.out).toBe(0);
    expect(sb.calls().filter((c) => /^(schtasks|reg|launchctl)\b/.test(c))).toEqual([]);
    expect(r.out + r.err).toMatch(/atlan/i);
  });
  it("--check yeşil; agent parçası n/a ya da ok (eksik değil); config'te machines yok", () => {
    const c = sb.run(["setup", "--check", "--json"]);
    expect(c.code, c.err + c.out).toBe(0);
    const agent = jsonOf(c.out).parts.find((p: any) => p.part === "agent");
    expect(["n/a", "ok"]).toContain(agent.status);
    expect(jsonOf(readFileSync(join(sb.vladHome, "vlad.config.local.json"), "utf8")).machines).toBeNull();
  });
});

describe("S3: idempotens", () => {
  const sb = makeSandbox({ platform: "darwin" });
  const args = ["setup", "--yes", "--answers", sb.answers(s1Answers(sb))];
  it("ikinci koşu: içerik/mtime aynı, ikinci yedek yok, çıktı 'zaten güncel'", async () => {
    const first = sb.run(args);
    expect(first.code, first.err + first.out).toBe(0);
    const dirs = [sb.claudeDir, sb.kbDir]; // vladHome kopyası büyük: yalnız kişisel katman dosyaları ayrıca karşılaştırılır
    const local = join(sb.vladHome, "vlad.config.local.json");
    const localBefore = readFileSync(local, "utf8"), localM = statSync(local).mtimeMs;
    const trees = dirs.map((d) => [snapshot(d), mtimes(d)] as const);
    const bak = backups(sb.claudeDir);
    await new Promise((r) => setTimeout(r, 1100)); // mtime yazımı ayırt edilsin (saniye çözünürlüklü yedek adı da)
    const second = sb.run(args);
    expect(second.code, second.err + second.out).toBe(0);
    dirs.forEach((d, i) => {
      expect(snapshot(d), d).toEqual(trees[i]![0]);
      expect(mtimes(d), d).toEqual(trees[i]![1]);
    });
    expect(readFileSync(local, "utf8")).toBe(localBefore);
    expect(statSync(local).mtimeMs).toBe(localM);
    expect(backups(sb.claudeDir)).toEqual(bak);
    expect(second.out).toMatch(/zaten güncel/);
  });
});

describe("S7: eksik build (dist/ yok)", () => {
  const sb = makeSandbox({ platform: "darwin", withDist: false });
  it("--check: cli eksik + 'npm run build' önerisi, çıkış 1; hook sessiz-boş uyarısı", () => {
    expect(existsSync(join(sb.vladHome, "dist"))).toBe(false);
    const c = sb.run(["setup", "--check", "--json"]);
    expect(c.code, c.err + c.out).toBe(1);
    const parts = jsonOf(c.out).parts;
    const cli = parts.find((p: any) => p.part === "cli");
    expect(cli.status).toBe("eksik");
    expect(cli.fix).toContain("npm run build");
    const hooks = parts.find((p: any) => p.part === "hooks");
    expect(hooks.evidence + JSON.stringify(hooks.items ?? [])).toMatch(/dist/);
  });
});
