import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { addFinding, getFinding } from "../../src/findings/store.js";
import { createTask, getTask, launchTask, reportTask } from "../../src/tasks/index.js";
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
      remote: { machine: () => "win", gate: async () => ({ exit: 1, stdout: "x", stderr: "" }), preview: async () => ({ log: "", diffStat: "", conflicts: [] }), merge, cleanup: async () => {} },
    }));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(merge).not.toHaveBeenCalled();
  });

  it("uzak yeşil gate → uzak merge + uzak cleanup", async () => {
    const id = await ready();
    const merge = vi.fn(async () => ({ head: "a".repeat(40), merged: true }));
    const cleanup = vi.fn(async () => {});
    const r = await closeTask(id, { yes: true }, deps({
      remote: { machine: () => "win", gate: async () => ({ exit: 0, stdout: "", stderr: "", head: "a".repeat(40) }), preview: async () => ({ log: "l", diffStat: "d", conflicts: [] }), merge, cleanup },
    }));
    expect(r.ok).toBe(true);
    expect(merge).toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
    expect(getTask(id).data.state).toBe("done");
  });

  it("kartın machines listesi ≥2 ise diğer makine için yeşil gate satırı yoksa durur", async () => {
    card(GREEN, "machines: [mac, win]\n");
    const id = await ready();
    const r = await closeTask(id, { yes: true }, deps({ self: "mac" }));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(r.reason).toMatch(/win/);
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });
});
