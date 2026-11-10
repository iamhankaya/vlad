// Sözleşme testleri (T20261110-03; spec T20261110-02): `vlad setup` tipleri, cevap doğrulayıcısı, envanter, --check sonuç şeması,
// çıkış kodları, config overlay/kbRepo. Yalnız ŞEKİL: iş mantığı (parça apply/check gövdeleri) uygulama fazındadır.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_ACTIONS, INVENTORY, LOCAL_CONFIG_FILE, PART_IDS, QUESTIONS, SETUP_EXIT, exitCodeFor, loadLayeredConfig, validateAnswers,
  type PartCheck, type SetupCheckResult, type SetupPart,
} from "../../src/setup/index.js";
import { validate, ValidationError } from "../../src/kb/index.js";

const root = resolve(import.meta.dirname, "..", "..");
const s1 = { role: "brain", machines: "single", kb: { mode: "local", dir: "~/dev/vlad-kb" }, roots: ["~/dev"] };
const errs = (r: ReturnType<typeof validateAnswers>) => (r.ok ? [] : r.errors).join("\n");

describe("setup sözleşmesi: çıkış kodları", () => {
  it("0 ok, 1 hata, 2 kullanım", () => {
    expect(SETUP_EXIT).toEqual({ ok: 0, failed: 1, usage: 2 });
  });
  const part = (status: PartCheck["status"], severity: PartCheck["severity"]): PartCheck => ({ part: "tools", status, severity, evidence: "e" });
  it("eksik/eski/çakışan + error → 1; ok/n/a → 0", () => {
    expect(exitCodeFor([part("ok", "error"), part("n/a", "error")], false)).toBe(0);
    for (const st of ["eksik", "eski", "çakışan"] as const) expect(exitCodeFor([part(st, "error")], false)).toBe(1);
  });
  it("warn/info yalnız --strict ile hata sayılır (info asla)", () => {
    expect(exitCodeFor([part("eksik", "warn")], false)).toBe(0);
    expect(exitCodeFor([part("eksik", "warn")], true)).toBe(1);
    expect(exitCodeFor([part("eksik", "info")], true)).toBe(0);
  });
});

describe("setup sözleşmesi: parça kimlikleri ve envanter", () => {
  it("parça kimlikleri spec'teki küme", () => {
    expect([...PART_IDS].sort()).toEqual(
      ["agent", "cli", "config", "global-skills", "hooks", "kb", "launcher", "mac-main", "memory", "permissions", "plugins", "repo-skills", "tools"],
    );
  });
  it("her parçanın en az bir envanter kaydı var; kayıt kimlikleri tekil", () => {
    expect(PART_IDS.filter((p) => !INVENTORY.some((i) => i.part === p))).toEqual([]);
    const ids = INVENTORY.map((i) => i.id);
    expect(ids.filter((id, n) => ids.indexOf(id) !== n)).toEqual([]);
  });
  it("kayıt şekli: kaynak, zorunluluk, platform, kontrol türü dolu", () => {
    for (const i of INVENTORY) {
      expect(i.label, i.id).toBeTruthy();
      expect(i.source.ref, i.id).toBeTruthy();
      expect(["zorunlu", "isteğe bağlı", "bilgi"]).toContain(i.required);
      expect(i.platforms.length, i.id).toBeGreaterThan(0);
      expect(i.check.kind, i.id).toBeTruthy();
    }
  });
  it("global skill'ler (vlad-worker, ci-triage) zorunlu ve dosya yolu ~/.claude/skills altında", () => {
    const g = INVENTORY.filter((i) => i.part === "global-skills");
    expect(g.map((i) => i.id).sort()).toEqual(expect.arrayContaining(["global-skills:ci-triage", "global-skills:vlad-worker"]));
    for (const i of g) expect(i.target?.scope).toBe("claude-dir");
  });
});

describe("setup sözleşmesi: parça arayüzü", () => {
  it("SetupPart: check + apply, uninstall isteğe bağlı", () => {
    const p = {
      id: "tools",
      check: async () => ({ part: "tools", status: "ok", severity: "error", evidence: "-" }),
      apply: async () => ({ part: "tools", changed: false, actions: [], backups: [] }),
    } satisfies SetupPart;
    expect(typeof p.check).toBe("function");
  });
  it("onay gerektiren eylem kümesi sabit", () => {
    expect([...CONFIRM_ACTIONS].sort()).toEqual(["agent-install", "kb-repo-create", "keygen", "mac-main-install", "permissions-write", "plugins-write"]);
  });
});

describe("setup sözleşmesi: soru şeması", () => {
  it("soru kimlikleri tekil ve her sorunun yazıldığı yer + varsayılan açıklaması var", () => {
    const ids = QUESTIONS.map((q) => q.id);
    expect(ids.filter((id, n) => ids.indexOf(id) !== n)).toEqual([]);
    for (const q of QUESTIONS) {
      expect(q.prompt, q.id).toBeTruthy();
      expect(q.writes, q.id).toBeTruthy();
      expect(["config-local", "local-json", "claude-settings", "kb", "script", "none"]).toContain(q.writes);
    }
  });
  it("sırlar için soru türü 'secret' yalnız keys", () => {
    expect(QUESTIONS.filter((q) => q.type === "secret").map((q) => q.id)).toEqual(["keys"]);
  });
  it("mevcut değeri sessizce ezmeyen soru: 'neverOverwrite' main/ctx.main", () => {
    expect(QUESTIONS.filter((q) => q.neverOverwrite).map((q) => q.id).sort()).toEqual(["ctx.main", "models.main"]);
  });
});

describe("setup sözleşmesi: --answers doğrulayıcı", () => {
  it("S1 mutlu yol cevapları geçerli", () => {
    const r = validateAnswers(s1, { platform: "darwin" });
    expect(r.ok, errs(r)).toBe(true);
  });
  it("bilinmeyen anahtar (üst ve iç) reddedilir, yol ile", () => {
    expect(errs(validateAnswers({ ...s1, bogus: 1 }, { platform: "darwin" }))).toContain("bogus");
    expect(errs(validateAnswers({ ...s1, kb: { mode: "local", nope: 1 } }, { platform: "darwin" }))).toContain("kb.nope");
  });
  it("keys yalnız generate|stdin; gerçek anahtar değeri reddedilir ve hata metnine SIZMAZ", () => {
    const key = "a".repeat(64);
    const r = validateAnswers({ ...s1, keys: key }, { platform: "darwin" });
    expect(r.ok).toBe(false);
    expect(errs(r)).toContain("keys");
    expect(errs(r)).not.toContain(key);
    expect(validateAnswers({ ...s1, keys: "generate" }, { platform: "darwin" }).ok).toBe(true);
    expect(validateAnswers({ ...s1, keys: "stdin" }, { platform: "darwin" }).ok).toBe(true);
  });
  it("agent.host genel IPv4 reddedilir, özel kabul (S8)", () => {
    const multi = (host: string) => ({ ...s1, machines: "multi", machine: { name: "mac", agent: { host, port: 7437 } } });
    expect(errs(validateAnswers(multi("8.8.8.8"), { platform: "darwin" }))).toContain("machine.agent.host");
    expect(validateAnswers(multi("192.168.1.35"), { platform: "darwin" }).ok).toBe(true);
  });
  it("çok makinede machine.name zorunlu; ad deseni ^[a-z][a-z0-9-]*$", () => {
    expect(errs(validateAnswers({ ...s1, machines: "multi" }, { platform: "darwin" }))).toContain("machine.name");
    expect(errs(validateAnswers({ ...s1, machines: "multi", machine: { name: "Mac Book" } }, { platform: "darwin" }))).toContain("machine.name");
  });
  it("agent.port 1024-65535", () => {
    const r = validateAnswers({ ...s1, machines: "multi", machine: { name: "mac", agent: { host: "10.0.0.2", port: 80 } } }, { platform: "darwin" });
    expect(errs(r)).toContain("machine.agent.port");
  });
  it("role=worker tek makineyle çelişir", () => {
    expect(errs(validateAnswers({ ...s1, role: "worker" }, { platform: "darwin" }))).toContain("role");
  });
  it("Linux'ta role=brain reddedilir (kullanıcı kararı 2026-11-10; allowUnsupported etkisiz); worker geçer", () => {
    expect(errs(validateAnswers(s1, { platform: "linux" }))).toContain("linux");
    expect(validateAnswers(s1, { platform: "linux", allowUnsupported: true }).ok).toBe(false); // bayrak artık etkisiz
    const w = { ...s1, role: "worker", machines: "multi", machine: { name: "pi", agent: { host: "10.0.0.5", port: 7437 } } };
    expect(validateAnswers(w, { platform: "linux" }).ok).toBe(true);
  });
  it("kb modları: github-new/existing remote ister (owner/name); local remote almaz; path dir ister", () => {
    const k = (kb: object) => validateAnswers({ ...s1, kb }, { platform: "darwin" });
    expect(errs(k({ mode: "github-new" }))).toContain("kb.remote");
    expect(errs(k({ mode: "existing", remote: "not-a-repo" }))).toContain("kb.remote");
    expect(k({ mode: "github-new", remote: "me/vlad-kb" }).ok).toBe(true);
    expect(errs(k({ mode: "local", remote: "me/vlad-kb" }))).toContain("kb.remote");
    expect(errs(k({ mode: "path" }))).toContain("kb.dir");
    expect(errs(k({ mode: "local", push: true }))).toContain("kb.push");
  });
  it("cloud.kb=readonly kb.remote ister", () => {
    expect(errs(validateAnswers({ ...s1, cloud: { kb: "readonly" } }, { platform: "darwin" }))).toContain("cloud.kb");
  });
  it("ctx.worker autocompact aralığı; models enum; worktreeDir {repo} kuralı; maxParallel >=1", () => {
    const r = (o: object) => errs(validateAnswers({ ...s1, ...o }, { platform: "darwin" }));
    expect(r({ ctx: { worker: "50k" } })).toContain("ctx.worker");
    expect(validateAnswers({ ...s1, ctx: { worker: "300k" } }, { platform: "darwin" }).ok).toBe(true);
    expect(r({ models: { roles: "gpt" } })).toContain("models.roles");
    expect(r({ worktreeDir: "C:\\dev\\{repo}-wt" })).toContain("worktreeDir");
    expect(r({ limits: { maxParallel: 0 } })).toContain("limits.maxParallel");
  });
  it("confirm yalnız bilinen eylemler", () => {
    expect(errs(validateAnswers({ ...s1, confirm: ["rm-rf"] }, { platform: "darwin" }))).toContain("confirm");
    expect(validateAnswers({ ...s1, confirm: ["kb-repo-create", "agent-install"] }, { platform: "darwin" }).ok).toBe(true);
  });
  it("nesne olmayan girdi hata verir (çökmez)", () => {
    for (const bad of [null, [], "x", 3]) expect(validateAnswers(bad, { platform: "darwin" }).ok).toBe(false);
  });
});

describe("setup sözleşmesi: --check --json sonuç şeması", () => {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "setup-check.schema.json"), "utf8"));
  const v = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const ok: SetupCheckResult = {
    version: 1, platform: "darwin", strict: false, exit: 0, ok: true,
    parts: [{ part: "cli", status: "ok", severity: "error", evidence: "cli.js var" }],
  };
  it("geçerli sonuç kabul edilir", () => { expect(v(ok), JSON.stringify(v.errors)).toBe(true); });
  it("eksik parça düzeltme komutu taşıyabilir", () => {
    expect(v({ ...ok, exit: 1, ok: false, parts: [{ part: "cli", status: "eksik", severity: "error", evidence: "derleme çıktısı yok", fix: "npm run build" }] })).toBe(true);
  });
  it("bilinmeyen durum / parça / ek alan reddedilir", () => {
    expect(v({ ...ok, parts: [{ ...ok.parts[0], status: "belki" }] })).toBe(false);
    expect(v({ ...ok, parts: [{ ...ok.parts[0], part: "xyz" }] })).toBe(false);
    expect(v({ ...ok, extra: 1 })).toBe(false);
    expect(v({ ...ok, exit: 2 })).toBe(false);
  });
  it("şema anahtar/sır alanı içermez", () => {
    expect(JSON.stringify(schema).toLowerCase()).not.toMatch(/"(key|secret|token|password)"/);
  });
});

describe("setup sözleşmesi: config overlay ve kbRepo", () => {
  it("overlay dosya adı", () => { expect(LOCAL_CONFIG_FILE).toBe("vlad.config.local.json"); });
  it("loadLayeredConfig tek okuyucu olarak dışa açık", () => { expect(typeof loadLayeredConfig).toBe("function"); });
  it("config şeması kbRepo (owner/name) kabul eder, bozuk adı reddeder", () => {
    const home = root; // repo kökünün schemas/ klasörü (geçici home gerekmez)
    const base = {
      roots: ["/x"], ignore: [], defaultAutonomy: "commit", staleAfterHours: 6, launcher: "auto", worktreeDir: "{repo}-wt", projects: {},
    };
    expect(() => validate("config", { ...base, kbRepo: "me/vlad-kb" }, home)).not.toThrow();
    expect(() => validate("config", { ...base, kbRepo: "no-slash" }, home)).toThrow(ValidationError);
  });
});
