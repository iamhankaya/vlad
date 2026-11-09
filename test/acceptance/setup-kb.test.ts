// Kabul (T20261110-04; spec T20261110-02): kb modları S11 ve boş kb ile ilk oturum S10; S14'ün dış-eylem onayı. Sahte gh (FAKE_LOG), yerel bare repo.
// Uygulama (T20261110-05) gelene dek KIRMIZI olması beklenir.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gitInit, makeSandbox, s1Answers } from "../support/setup-sandbox.js";

const ghCalls = (sb: ReturnType<typeof makeSandbox>, re: RegExp) => sb.calls().filter((c) => c.startsWith("gh ") && re.test(c));
const ALL_PUSH = /(^|\s)push(\s|$)/;

describe("S11: kb modları", () => {
  it("(a) github-new + onay yok → repo OLUŞTURULMAZ", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const a = s1Answers(sb, { kb: { mode: "github-new", dir: sb.kbDir, remote: "acme/vlad-kb" } });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(a)]);
    expect(ghCalls(sb, /repo create/)).toEqual([]);
    expect(r.out + r.err).toMatch(/onay|confirm|kb-repo-create/);
  });
  it("(b) onayla → gh repo create <ad> --private; push YAPILMAZ", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const a = s1Answers(sb, { kb: { mode: "github-new", dir: sb.kbDir, remote: "acme/vlad-kb" }, confirm: ["kb-repo-create"] });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(a)]);
    expect(r.code, r.err + r.out).toBe(0);
    const create = ghCalls(sb, /repo create/);
    expect(create).toHaveLength(1);
    expect(create[0]).toMatch(/acme\/vlad-kb/);
    expect(create[0]).toContain("--private");
    expect(create[0]).not.toMatch(/--public|--internal/);
    expect(sb.calls().filter((c) => ALL_PUSH.test(c))).toEqual([]);
    expect(existsSync(join(sb.kbDir, ".git"))).toBe(true);
  });
  it("(c) existing + var olan boş repo → klonlanır", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const bare = join(sb.root, "remote-kb.git");
    gitInit(bare, "--bare");
    // `https://github.com/acme/vlad-kb` → yerel bare (hem git hem sahte gh klonu için)
    writeFileSync(join(sb.home, ".gitconfig"), `[url "${bare}"]\n\tinsteadOf = https://github.com/acme/vlad-kb\n\tinsteadOf = https://github.com/acme/vlad-kb.git\n`);
    const a = s1Answers(sb, { kb: { mode: "existing", dir: sb.kbDir, remote: "acme/vlad-kb" } });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(a)], { env: { FAKE_GH_BARE: bare } });
    expect(r.code, r.err + r.out).toBe(0);
    expect(existsSync(join(sb.kbDir, ".git"))).toBe(true);
    expect(readFileSync(join(sb.kbDir, ".gitignore"), "utf8")).toContain("inbox/");
    expect(ghCalls(sb, /repo create/)).toEqual([]);
  });
  it("(d) existing + erişim yok → hata, kb dizini/config yazılmaz", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const a = s1Answers(sb, { kb: { mode: "existing", dir: sb.kbDir, remote: "acme/yok-repo" } });
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(a)], { env: { FAKE_GH_VIEW_FAIL: "1", FAKE_GH_BARE: join(sb.root, "yok.git") } });
    expect(r.code).toBe(1);
    expect(existsSync(sb.kbDir)).toBe(false);
    expect(existsSync(join(sb.vladHome, "vlad.config.local.json"))).toBe(false);
  });
  it("kb.mode=path: var olan git dizini kullanılır, dizin içeriğine dokunulmaz", () => {
    const sb = makeSandbox({ platform: "darwin" });
    gitInit(sb.kbDir);
    writeFileSync(join(sb.kbDir, "notlar.md"), "kullanıcı notu\n");
    const r = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb, { kb: { mode: "path", dir: sb.kbDir } }))]);
    expect(r.code, r.err + r.out).toBe(0);
    expect(readFileSync(join(sb.kbDir, "notlar.md"), "utf8")).toBe("kullanıcı notu\n");
  });
});

describe("S14: dış eylemler onaysız yapılmaz", () => {
  it("--yes + onaysız tam kurulum: launchctl/schtasks/reg/gh repo create/push çağrısı yok", () => {
    const sb = makeSandbox({ platform: "darwin" });
    const a = s1Answers(sb, { agentboot: true, mainsession: true, kb: { mode: "github-new", dir: sb.kbDir, remote: "acme/vlad-kb" } });
    sb.run(["setup", "--yes", "--answers", sb.answers(a)]);
    expect(sb.calls().filter((c) => /^(launchctl|schtasks|reg) /.test(c) || /repo create/.test(c) || ALL_PUSH.test(c))).toEqual([]);
  });
});

describe("S10: boş kb ile ilk oturum", () => {
  const sb = makeSandbox({ platform: "darwin" });
  const setup = sb.run(["setup", "--yes", "--answers", sb.answers(s1Answers(sb))]);
  it("kurulum sonrası kb'de kullanıcı kartı/kararı/günlüğü yok", () => {
    expect(setup.code, setup.err + setup.out).toBe(0);
    for (const d of ["projects", "decisions", "journal", "findings", "tasks"]) {
      const p = join(sb.kbDir, d);
      if (existsSync(p)) expect(readdirSync(p).filter((f) => !f.startsWith(".") && f !== "archive"), d).toEqual([]);
    }
  });
  for (const args of [["status", "--no-mark", "--summary"], ["project", "list", "--json"], ["task", "list", "--json"], ["role", "list", "--json"], ["decision", "list", "--json"], ["kb", "lint", "--json"]]) {
    it(`vlad ${args.join(" ")} boş kb ile hatasız`, () => {
      const r = sb.run(args);
      expect(r.code, r.err).toBe(0);
      expect(r.err).not.toMatch(/hata|error/i);
    });
  }
  it("açılış özeti 'hepsi 0' dalına düşer", () => {
    const r = sb.run(["status", "--no-mark", "--summary"]);
    expect(r.out).toMatch(/İşlenmemiş 0 rapor, 0 aktif görev/);
  });
});
