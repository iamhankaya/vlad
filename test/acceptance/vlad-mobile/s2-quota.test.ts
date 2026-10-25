// T1 kabul: S2c (quota komutları + readyWithLimit kota). S2a/S2b henüz uygulanmadı: aşağıda atlanmış kabul testleri.
// Kaynak: plan §Kota (Max 5x), §Kayıt şemaları `quota`, §S2c. `kb/logs/quota.json` biçimi: {limited_until, reason, at}.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fail, newHome, newTask, ok, run, writeConfig, writeProjectCard } from "./helpers.js";

let home: string;
const future = (ms = 3_600_000) => new Date(Date.now() + ms).toISOString();
const past = (ms = 3_600_000) => new Date(Date.now() - ms).toISOString();
const quotaFile = () => join(home, "kb", "logs", "quota.json");
const writeQuota = (raw: string) => { mkdirSync(join(home, "kb", "logs"), { recursive: true }); writeFileSync(quotaFile(), raw); };
beforeEach(() => { home = newHome(); writeProjectCard(home); });

describe("records: quota set|show|clear (S2c)", () => {
  it("show with no marker: limited false", () => {
    const q = ok<any>(home, ["quota", "show"]);
    expect(q.limited).toBe(false);
  });
  it("set then show reports limited true with until and reason; clear removes it", () => {
    const until = future();
    ok(home, ["quota", "set", "--until", until, "--reason", "T20261024-94"]);
    const q = ok<any>(home, ["quota", "show"]);
    expect(q.limited).toBe(true);
    expect(Date.parse(q.until)).toBe(Date.parse(until));
    expect(q.reason).toBe("T20261024-94");
    ok(home, ["quota", "clear"]);
    expect(ok<any>(home, ["quota", "show"]).limited).toBe(false);
  });
  it("clear when nothing is set is not an error", () => {
    ok(home, ["quota", "clear"]);
  });
  it("set stores {limited_until, reason, at} in kb/logs/quota.json (gitignored location)", () => {
    const until = future();
    ok(home, ["quota", "set", "--until", until, "--reason", "r"]);
    const j = JSON.parse(readFileSync(quotaFile(), "utf8"));
    expect(Date.parse(j.limited_until)).toBe(Date.parse(until));
    expect(j.reason).toBe("r");
    expect(Number.isNaN(Date.parse(j.at))).toBe(false);
  });
  it("set rejects a non-ISO --until and a missing --until", () => {
    fail(home, ["quota", "set", "--until", "yarın akşam", "--reason", "r"]);
    fail(home, ["quota", "set", "--reason", "r"]);
  });
  it("records: expired marker reads as not limited", () => {
    writeQuota(JSON.stringify({ limited_until: past(), reason: "eski", at: past(2 * 3_600_000) }));
    expect(ok<any>(home, ["quota", "show"]).limited).toBe(false);
  });
  it("records: corrupt or empty quota.json treated as none with warning (show)", () => {
    for (const raw of ["", "{not json", "[]", JSON.stringify({ limited_until: "yok" })]) {
      writeQuota(raw);
      const q = ok<any>(home, ["quota", "show"]);
      expect(q.limited, `raw=${JSON.stringify(raw)}`).toBe(false);
    }
    writeQuota("{not json");
    expect(ok<any>(home, ["quota", "show"]).warnings.length).toBeGreaterThan(0);
  });
});

describe("tasks: quota in `task ready` (S2c)", () => {
  const mk = (n: number) => Array.from({ length: n }, () => newTask(home));

  it("ready --json stays backward compatible without quota (old fields intact, quota.limited false)", () => {
    const [a] = mk(1);
    const r = ok<any>(home, ["task", "ready"]);
    expect(r.tasks.map((t: any) => t.id)).toEqual([a]);
    expect(r.held_by_limit).toEqual([]);
    expect(r).toHaveProperty("running");
    expect(r).toHaveProperty("maxParallel");
    expect(r.quota.limited).toBe(false);
  });
  it("tasks: quota holds all ready as held_by_limit reason quota", () => {
    const ids = mk(2);
    const until = future();
    ok(home, ["quota", "set", "--until", until, "--reason", "r"]);
    const r = ok<any>(home, ["task", "ready"]);
    expect(r.tasks).toEqual([]);
    expect(r.held_by_limit.map((t: any) => t.id).sort()).toEqual([...ids].sort());
    expect(r.held_by_limit.every((t: any) => t.reason === "quota")).toBe(true);
    expect(r.quota.limited).toBe(true);
    expect(Date.parse(r.quota.until)).toBe(Date.parse(until));
  });
  it("tasks: quota expired clears — tasks ready again", () => {
    const [a] = mk(1);
    writeQuota(JSON.stringify({ limited_until: past(), reason: "eski", at: past(7_200_000) }));
    const r = ok<any>(home, ["task", "ready"]);
    expect(r.tasks.map((t: any) => t.id)).toEqual([a]);
    expect(r.held_by_limit).toEqual([]);
    expect(r.quota.limited).toBe(false);
  });
  it("tasks: quota cleared by `quota clear` releases the hold", () => {
    const [a] = mk(1);
    ok(home, ["quota", "set", "--until", future(), "--reason", "r"]);
    ok(home, ["quota", "clear"]);
    expect(ok<any>(home, ["task", "ready"]).tasks.map((t: any) => t.id)).toEqual([a]);
  });
  it("tasks: quota beats maxParallel reason", () => {
    // maxParallel 1 + iki hazır görev: kota yokken biri 'limit' ile tutulur; kota varken ikisi de 'quota'
    writeConfig(home, { maxParallel: 1 });
    mk(2);
    const noQuota = ok<any>(home, ["task", "ready"]);
    expect(noQuota.tasks).toHaveLength(1);
    expect(noQuota.held_by_limit).toHaveLength(1);
    expect(noQuota.held_by_limit[0].reason).toBe("limit");
    ok(home, ["quota", "set", "--until", future(), "--reason", "r"]);
    const q = ok<any>(home, ["task", "ready"]);
    expect(q.tasks).toEqual([]);
    expect(q.held_by_limit).toHaveLength(2);
    expect(q.held_by_limit.every((t: any) => t.reason === "quota")).toBe(true);
  });
  it("tasks: corrupt or empty quota.json treated as none with warning (ready)", () => {
    const [a] = mk(1);
    for (const raw of ["", "{not json"]) {
      writeQuota(raw);
      const r = ok<any>(home, ["task", "ready"]);
      expect(r.tasks.map((t: any) => t.id), `raw=${JSON.stringify(raw)}`).toEqual([a]);
      expect(r.quota.limited).toBe(false);
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
  it("tasks: unknown reason ignored — an unfamiliar reason text still holds with reason 'quota'", () => {
    // varsayım (plan 'tasks: unknown reason ignored' maddesinin yorumu): quota.json `reason` serbest metindir;
    // held_by_limit[].reason yalnız "limit"|"quota" olur.
    const [a] = mk(1);
    writeQuota(JSON.stringify({ limited_until: future(), reason: "müzik kutusu ½ 🚀", at: past(1000) }));
    const r = ok<any>(home, ["task", "ready"]);
    expect(r.held_by_limit.map((t: any) => [t.id, t.reason])).toEqual([[a, "quota"]]);
  });
  it("tasks: quota applies per --parent as well", () => {
    const pid = ok<any>(home, ["task", "new", "--project", "alpha", "--title", "P", "--kind", "pipeline", "--body-file", "-"], { input: "## Tanım\nx\n" }).id;
    ok(home, ["task", "new", "--project", "alpha", "--title", "F", "--kind", "dev", "--parent", pid, "--phase", "uygulama", "--body-file", "-"], { input: "## Tanım\nx\n" });
    ok(home, ["quota", "set", "--until", future(), "--reason", "r"]);
    const r = ok<any>(home, ["task", "ready", "--parent", pid]);
    expect(r.tasks).toEqual([]);
    expect(r.held_by_limit.length).toBeGreaterThan(0);
  });
  it("quota show/set work without kb/logs existing", () => {
    const h2 = newHome();
    rmSync(join(h2, "kb", "logs"), { recursive: true, force: true });
    ok(h2, ["quota", "set", "--until", future(), "--reason", "r"]);
    expect(ok<any>(h2, ["quota", "show"]).limited).toBe(true);
  });
});

// --- S2a / S2b: henüz entegrasyonda yok. Gerekçe: S2a (Linux ProcessLauncher) ve S2b (worker tap, relaunch) uygulanmadı;
// CLI'dan görünen sözleşmeleri atlanmış test olarak kaydedildi. Uygulama gelince `describe.skip` -> `describe`.
describe.skip("launcher: S2a — Linux ProcessLauncher (uygulanmadı)", () => {
  it("launcher: auto on linux resolves process (dry-run mode 'process')", () => {
    writeConfig(home, { launcher: "auto" });
    const id = newTask(home);
    expect(ok<any>(home, ["task", "launch", id, "--dry-run"]).mode).toBe("process");
  });
  it("config launcher accepts 'process'", () => {
    writeConfig(home, { launcher: "process" });
    ok(home, ["task", "list"]);
  });
  it("launcher: no skip-permissions flag anywhere (dry-run output)", () => {
    writeConfig(home, { launcher: "process" });
    const id = newTask(home);
    expect(JSON.stringify(ok<any>(home, ["task", "launch", id, "--dry-run"]))).not.toContain("dangerously-skip-permissions");
  });
  it("launcher: systemd-run missing -> stable error key (exit 1)", () => {
    writeConfig(home, { launcher: "process" });
    const id = newTask(home);
    fail(home, ["task", "launch", id], { env: { PATH: "/nonexistent" } });
  });
});
describe.skip("tasks: S2b — worker tap / relaunch (uygulanmadı)", () => {
  it("tasks: relaunch without session_id explicit error", () => {
    const id = newTask(home);
    fail(home, ["task", "relaunch", id]);
  });
  it("tasks: relaunch on other host rejected", () => {
    const id = newTask(home);
    fail(home, ["task", "relaunch", id], { env: { VLAD_MACHINE: "baska" } });
  });
  it("launcher: tap ignores unknown and partial lines (stdin stream-json)", () => {
    const id = newTask(home);
    const r = run(home, ["worker", "tap", id], { input: 'garip\n{"type":"x"}\n{"type":"sys' });
    expect(r.code).toBe(0);
  });
  it.todo("launcher: limit event writes quota (gerçek sınır olayı fixture'ı D0A'dan gelmeli; sentetik gövde yazılmadı)");
});
