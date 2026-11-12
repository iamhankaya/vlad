import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { addFinding, getFinding } from "../../src/findings/store.js";
import { createTask, getTask, launchTask, logTask, reportTask } from "../../src/tasks/index.js";
import { saveTaskQuiet } from "../../src/tasks/store.js";
import { setNight } from "../../src/mode/store.js";
import { closeTask, type CloseDeps } from "../../src/machines/close.js";
import { makeHome, rmTemp } from "../helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const GREEN = `node -e "process.exit(0)"`;
const RED = `node -e "console.log('kırmızı');process.exit(1)"`;

let repo: string, cfg: VladConfig, home: string;
const fake: Launcher = { async launch() { return { ok: true, method: "fake" }; } };
const kbCommit = vi.fn(() => ({ committed: true, pushed: true }));
const deps = (o: Partial<CloseDeps> = {}): Partial<CloseDeps> => ({ cfg, kbCommit, closeWorker: () => {}, ...o });

function card(gate: string | null, extra = "") {
  writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
default_branch: main
${gate ? `gate: ${JSON.stringify(gate)}\n` : ""}${extra}last_activity: null
last_scanned: null
---

## Özet
x
`);
}
beforeEach(() => {
  home = makeHome();
  const base = mkdtempSync(join(tmpdir(), "vlad-close-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = defaultConfig();
  cfg.worktreeDir = join(base, "wt");
  card(GREEN);
  kbCommit.mockClear();
});
afterEach(() => { rmTemp(dirname(repo)); rmTemp(home); });

const REPORT = (extra = "", tests = "gate yeşil; entegrasyon branch'i merge edildi, lint yeşil") =>
  `### Yapılanlar\nx\n### Test sonuçları\n${tests}\n### Kabul kriterleri\nkarşılandı\n${extra}`;

/** A launched task with one commit (file `name`) and a report, i.e. awaiting_approval. */
async function ready(o: { parent?: string; name?: string; content?: string; report?: string } = {}) {
  const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n", ...(o.parent ? { parent: o.parent, phase: "uygulama" } : {}) });
  await launchTask(t.data.id, { launcher: fake, cfg });
  const wt = getTask(t.data.id).data.worktree!;
  writeFileSync(join(wt, o.name ?? "b.txt"), o.content ?? "2");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "iş");
  reportTask(t.data.id, o.report ?? REPORT());
  return t.data.id;
}
const step = (r: { steps: { step: string; status: string }[] }, s: string) => r.steps.find((x) => x.step === s)?.status;

describe("task close: yerel tek görev", () => {
  it("F-vlad-309: 'kısmen … açık kalır' satırı bulguyu kapatmaz, uyarır", async () => {
    const f = addFinding({ project: "alpha", severity: "orta", source: "T20261101-01", title: "kısmi bulgu" }).data.id;
    const id = await ready({ report: REPORT(`### Kapatılan bulgular\n- ${f} — kısmen: yarısı; bulgu açık kalır\n`) });
    const r = await closeTask(id, { yes: true }, deps());
    expect(getFinding(f).data.state).toBe("open");
    expect(r.warnings.join("\n")).toMatch(new RegExp(`${f}.*kısmi`));
  });
  it("gate + merge + done + cleanup + bulgu + kb commit tek komutta; --yes ile", async () => {
    const f = addFinding({ project: "alpha", severity: "orta", source: "T20261101-01", title: "kapanacak bulgu" }).data.id;
    const id = await ready({ report: REPORT(`### Kapatılan bulgular\n- ${f} — fixed — b.txt:1\n- F-alpha-999 — fixed — yok\n`) });
    const wt = getTask(id).data.worktree!;
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: true, stopped_at: null });
    expect(r.steps.map((s) => s.step)).toEqual(["precheck", "gate", "conflict", "confirm", "merge", "done", "cleanup", "findings", "kb"]);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("2");
    expect(git(repo, "log", "-1", "--format=%p").trim().split(" ")).toHaveLength(2); // --no-ff merge commit
    expect(getTask(id).data).toMatchObject({ state: "done", worktree: null });
    expect(existsSync(wt)).toBe(false);
    expect(getFinding(f).data).toMatchObject({ state: "fixed", fixed_by: id });
    expect(r.warnings.join("\n")).toMatch(/F-alpha-999/);
    expect(kbCommit).toHaveBeenCalledWith(expect.stringContaining(id));
  });

  it("--yes yok ve yetki penceresi kapalıysa merge öncesi durur; hiçbir şey değişmez", async () => {
    const id = await ready();
    const r = await closeTask(id, {}, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "confirm" });
    expect(step(r, "gate")).toBe("ok");
    expect(step(r, "conflict")).toBe("ok");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
    expect(r.summary).toMatch(/b\.txt/); // özet: diff --stat
  });

  it("gece modu açık, gate yeşil, açık P1 yok → sormadan sürer", async () => {
    setNight({ until: new Date(Date.now() + 3_600_000).toISOString() });
    const id = await ready();
    const r = await closeTask(id, {}, deps());
    expect(r.ok).toBe(true);
    expect(getTask(id).data.state).toBe("done");
  });

  it("gece modu açık ama göreve ait açık yüksek bulgu varsa sorar (durur)", async () => {
    setNight({ until: new Date(Date.now() + 3_600_000).toISOString() });
    const id = await ready();
    addFinding({ project: "alpha", severity: "yüksek", source: id, title: "P1" });
    const r = await closeTask(id, {}, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "confirm" });
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("gece modunda bile raporun Açık noktalar'ında kritik/yüksek varsa sorar", async () => {
    setNight({ until: new Date(Date.now() + 3_600_000).toISOString() });
    const id = await ready({ report: REPORT("### Açık noktalar\n- [yüksek] kaldı — x\n") });
    const r = await closeTask(id, {}, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "confirm" });
  });

  it("görev worktree'sinde commit'siz değişiklik varsa gate koşmaz (yeşil sahte olmasın)", async () => {
    const id = await ready();
    writeFileSync(join(getTask(id).data.worktree!, "b.txt"), "kirli");
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(r.reason).toMatch(/commit'siz/);
  });

  it("kırmızı gate'te durur; merge/done yok, çıktı gate özetini taşır", async () => {
    card(RED);
    const id = await ready();
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(r.reason).toMatch(/kırmızı/);
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
    expect(kbCommit).not.toHaveBeenCalled();
  });

  it("kartta gate yoksa durur", async () => {
    card(null);
    const id = await ready();
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(r.reason).toMatch(/gate tanımlı değil/);
  });

  it("çakışmada durur; hedef dal ve görev değişmez", async () => {
    const id = await ready({ name: "a.txt", content: "görev" });
    writeFileSync(join(repo, "a.txt"), "ana");
    git(repo, "commit", "-am", "ana değişti");
    const head = git(repo, "rev-parse", "HEAD");
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "conflict" });
    expect(r.reason).toMatch(/a\.txt/);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("rapor yoksa/awaiting_approval değilse precheck'te durur", async () => {
    const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
    await launchTask(t.data.id, { launcher: fake, cfg });
    const r = await closeTask(t.data.id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "precheck" });
    expect(r.reason).toMatch(/awaiting_approval/);
  });

  it("hedef dal kirliyse ya da başka dalda ise merge etmez", async () => {
    const id = await ready();
    writeFileSync(join(repo, "kirli.txt"), "x");
    git(repo, "add", "kirli.txt");
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "merge" });
    expect(r.reason).toMatch(/temiz değil/);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("done görevde yeniden koşu yalnız kalan adımları (cleanup, bulgu, kb) tamamlar", async () => {
    const id = await ready();
    const first = await closeTask(id, { yes: true }, deps({ kbCommit: () => { throw new Error("ağ yok"); } }));
    expect(first).toMatchObject({ ok: false, stopped_at: "kb" });
    expect(getTask(id).data.state).toBe("done");
    const again = await closeTask(id, { yes: true }, deps());
    expect(again.ok).toBe(true);
    expect(step(again, "merge")).toBe("skipped");
    expect(step(again, "kb")).toBe("ok");
  });
});

describe("task close: pipeline fazı", () => {
  const pipe = () => createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" }).data.id;

  it("hedef vlad/<çatı> entegrasyon worktree'si; ana dala dokunmaz", async () => {
    const p = pipe();
    const id = await ready({ parent: p });
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: true, target: `vlad/${p}` });
    const iwt = getTask(p).data.worktree!;
    expect(readFileSync(join(iwt, "b.txt"), "utf8")).toBe("2");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });

  it("raporda entegrasyon branch'i kanıtı yoksa precheck'te durur", async () => {
    const p = pipe();
    const id = await ready({ parent: p, report: REPORT("", "gate yeşil") });
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "precheck" });
    expect(r.reason).toMatch(/entegrasyon/);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });
});

describe("task close: uzak görev ve çok makine", () => {
  it("uzak gate kırmızıysa durur, merge çağrılmaz", async () => {
    const id = await ready();
    const merge = vi.fn();
    const r = await closeTask(id, { yes: true }, deps({
      remote: { machine: () => "win", gate: async () => ({ exit: 1, stdout: "x", stderr: "" }), push: async () => ({ branch: "", head: "", pushed: false, remote: "origin" }), fetch: async () => {}, preview: async () => ({ log: "", diffStat: "", conflicts: [] }), merge, cleanup: async () => {} },
    }));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(merge).not.toHaveBeenCalled();
  });

  /** Uzak işçi taklidi: gate gerçek worktree head'ini döner; push/fetch/merge/cleanup izlenir (merge yerel olmalı). */
  const win = (id: string, o: Partial<CloseDeps["remote"]> = {}) => {
    const head = () => git(getTask(id).data.worktree!, "rev-parse", "HEAD").trim();
    const calls: string[] = [];
    const remote: CloseDeps["remote"] = {
      machine: () => "win",
      gate: async () => { calls.push("gate"); return { exit: 0, stdout: "", stderr: "", head: head() }; },
      push: async (_t, _m, h) => { calls.push(`push:${h.slice(0, 7)}`); return { branch: `vlad/${id}`, head: h, pushed: true, remote: "origin" }; },
      fetch: async (_t, h) => { calls.push(`fetch:${h.slice(0, 7)}`); },
      preview: async () => { calls.push("preview"); return { log: "", diffStat: "", conflicts: [] }; },
      merge: async () => { calls.push("remote-merge"); return { head: "a".repeat(40), merged: true }; },
      cleanup: async () => { calls.push("cleanup"); },
      ...o,
    };
    return { remote, calls, head };
  };

  it("uzak tek görev: gate → push → fetch → beyinde merge (uzak merge yok) → uzak cleanup; günlükte push satırı", async () => {
    const id = await ready();
    const w = win(id);
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: true, stopped_at: null });
    const h = w.head().slice(0, 7);
    expect(w.calls).toEqual(["gate", `push:${h}`, `fetch:${h}`, "cleanup"]);
    expect(r.steps.map((x) => x.step).slice(0, 5)).toEqual(["precheck", "gate", "push", "fetch", "conflict"]);
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("2");
    expect(getTask(id).data.state).toBe("done");
    expect(getTask(id).body).toMatch(new RegExp(`branch-push: vlad/${id} @ ${w.head().slice(0, 12)} origin'e itildi \\(win\\)`));
  });

  it("push hatasında stopped_at push: fetch/merge yok, görev awaiting_approval", async () => {
    const id = await ready();
    const w = win(id, { push: async () => { throw new Error("failed: [auth] kimlik yok"); } });
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: false, stopped_at: "push" });
    expect(r.reason).toMatch(/auth/);
    expect(w.calls).toEqual(["gate"]);
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("fetch hatasında stopped_at fetch: merge yok", async () => {
    const id = await ready();
    const w = win(id, { fetch: async () => { throw new Error("FETCH_HEAD farklı"); } });
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: false, stopped_at: "fetch" });
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("--head gate'lenen sha'dan farklıysa push'tan ÖNCE durur", async () => {
    const id = await ready();
    const w = win(id);
    const r = await closeTask(id, { yes: true, head: "deadbee" }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(w.calls).toEqual(["gate"]);
  });

  it("çakışma önizlemesi beyinde: çakışırsa stopped_at conflict, merge yok", async () => {
    const id = await ready({ name: "a.txt", content: "other" });
    writeFileSync(join(repo, "a.txt"), "main-change");
    git(repo, "commit", "-am", "main değişti");
    const w = win(id);
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: false, stopped_at: "conflict" });
    expect(w.calls).not.toContain("remote-merge");
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("onay yoksa push/fetch/preview çağrılmadan confirm'de durur; --yes ile tek push", async () => {
    const id = await ready();
    let n = 0;
    const w = win(id, { push: async (_t, _m, h) => ({ branch: `vlad/${id}`, head: h, pushed: n++ === 0, remote: "origin" }) });
    const first = await closeTask(id, {}, deps({ remote: w.remote }));
    expect(first).toMatchObject({ stopped_at: "confirm" });
    expect(n).toBe(0);
    expect(w.calls).toEqual(["gate"]);
    const again = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(again.ok).toBe(true);
    expect(n).toBe(1);
  });

  it("F-vlad-320: uzak teslimde merge'ten ÖNCE işçi dal ucu gate'lenen sha'ya karşı yeniden doğrulanır (confirm sonrası, merge öncesi)", async () => {
    const id = await ready();
    const w = win(id, { verifyTip: async (_t, _m, h) => { calls.push(`verify:${h.slice(0, 7)}`); } });
    const calls = w.calls;
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r.ok).toBe(true);
    const h = w.head().slice(0, 7);
    expect(calls).toEqual(["gate", `push:${h}`, `fetch:${h}`, `verify:${h}`, "cleanup"]);
  });

  it.each([["stale_tip", "failed: [stale_tip] işçide vlad/x ucu gate'lenen sha'dan farklı"], ["başka hata", "failed: [no_origin] işçi origin'e ulaşamadı"]])("F-vlad-320: doğrulama %s döndürünce merge/done/cleanup yok, görev awaiting_approval kalır", async (_n, msg) => {
    const id = await ready();
    const mainBefore = git(repo, "rev-parse", "HEAD").trim();
    const w = win(id, { verifyTip: async () => { throw new Error(msg); } });
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: false, stopped_at: "merge" });
    expect(r.reason).toContain(msg);
    expect(w.calls).not.toContain("cleanup");
    expect(getTask(id).data.state).toBe("awaiting_approval");
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(mainBefore);
  });

  it("F-vlad-320: işçi taklidinde verifyTip yoksa doğrulama atlanır, akış eskisi gibi", async () => {
    const id = await ready();
    const w = win(id); // verifyTip tanımsız
    expect((await closeTask(id, { yes: true }, deps({ remote: w.remote }))).ok).toBe(true);
  });

  it("pipeline fazı (parent var) uzakta eskisi gibi: push/fetch yok, merge işçide", async () => {
    const p = createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" }).data.id;
    const id = await ready({ parent: p });
    const w = win(id);
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r.ok).toBe(true);
    expect(w.calls).toEqual(["gate", "preview", "remote-merge", "cleanup"]);
  });

  it("done uzak görev yeniden koşusu: push/fetch yok; gate'lenen head hedefte değilse precheck durur", async () => {
    const id = await ready();
    const w = win(id);
    await closeTask(id, { yes: true }, deps({ remote: w.remote, kbCommit }));
    const t = getTask(id);
    w.calls.length = 0;
    expect((await closeTask(id, { yes: true }, deps({ remote: w.remote }))).ok).toBe(true);
    expect(w.calls).toEqual(["cleanup"].filter(() => t.data.worktree));
    // kayıtlı yeşil head ana dalda yoksa: merge edilmemiş
    const t2 = getTask(id);
    t2.data.last_green_gate = { head: "c".repeat(40), target: "task", at: new Date().toISOString() };
    saveTaskQuiet(t2);
    const r = await closeTask(id, { yes: true }, deps({ remote: w.remote }));
    expect(r).toMatchObject({ ok: false, stopped_at: "precheck" });
    expect(r.reason).toMatch(/merge edilmemiş/);
  });

  it("kartın machines listesi ≥2 ise diğer makine için yeşil gate satırı yoksa durur", async () => {
    card(GREEN, "machines: [mac, win]\n");
    const id = await ready();
    const r = await closeTask(id, { yes: true, allMachines: true }, deps({ self: "mac" }));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(r.reason).toMatch(/win/);
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });

  it("çok makine kanıtı commit'e bağlı: eski sha'lı satır geçersiz, güncel sha'lı satır geçer", async () => {
    card(GREEN, "machines: [mac, win]\n");
    const id = await ready();
    const wt = getTask(id).data.worktree!;
    const head = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    logTask(id, `Gate win: yeşil ${"0".repeat(12)}`);
    const stale = await closeTask(id, { yes: true, allMachines: true }, deps({ self: "mac" }));
    expect(stale).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(stale.reason).toMatch(/win/);
    logTask(id, `Gate win: yeşil ${head.slice(0, 12)}`);
    const ok = await closeTask(id, { yes: true, allMachines: true }, deps({ self: "mac" }));
    expect(ok.ok).toBe(true);
  });

  it("P1: gate sürerken dala gelen commit gate'siz merge edilmez", async () => {
    card(`node -e "require('child_process').execSync('echo broken > c.txt && git add c.txt && git -c user.name=T -c user.email=t@t commit -qm late')"`);
    const id = await ready();
    const r = await closeTask(id, { yes: true }, deps());
    expect(r).toMatchObject({ ok: false, stopped_at: "merge" });
    expect(r.reason).toMatch(/gate'ten sonra değişti/);
    expect(existsSync(join(repo, "c.txt"))).toBe(false);
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("confirm durağı gate'lenen head'i basar; --head farklıysa durur, aynıysa merge eder", async () => {
    const id = await ready();
    const wt = getTask(id).data.worktree!;
    const head = git(wt, "rev-parse", "HEAD").trim();
    const first = await closeTask(id, {}, deps());
    expect(first).toMatchObject({ stopped_at: "confirm", head });
    expect(first.reason).toContain(`--head ${head.slice(0, 12)}`);
    const bad = await closeTask(id, { yes: true, head: "deadbee" }, deps());
    expect(bad).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    const ok = await closeTask(id, { yes: true, head: head.slice(0, 12) }, deps());
    expect(ok.ok).toBe(true);
    expect(ok.head).toBe(head);
  });

  it("çok makine: son kapı değilse eksik satır yalnız uyarı, --allMachines ile durur", async () => {
    card(GREEN, "machines: [mac, win]\n");
    const id = await ready();
    const warn = await closeTask(id, {}, deps({ self: "mac" }));
    expect(warn.stopped_at).toBe("confirm");
    expect(warn.warnings.join("\n")).toMatch(/win/);
    const strict = await closeTask(id, { yes: true, allMachines: true }, deps({ self: "mac" }));
    expect(strict).toMatchObject({ ok: false, stopped_at: "gate" });
  });

  it("pipeline çatı kapanış raporu olmadan precheck'ten geçer", async () => {
    const t = createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "## Tanım\nx\n" });
    await launchTask(t.data.id, { launcher: fake, cfg }).catch(() => {});
    const r = await closeTask(t.data.id, { yes: true }, deps());
    expect(r.reason ?? "").not.toMatch(/kapanış raporu yok/);
  });
});
