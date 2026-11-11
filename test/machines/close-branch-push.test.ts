import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, launchTask, reportTask, setState } from "../../src/tasks/index.js";
import { closeTask, type CloseDeps, type CloseRemote } from "../../src/machines/close.js";
import { fetchTaskBranch, remoteBranchPush } from "../../src/machines/remote.js";
import type { BranchPushResult, RemoteTransport } from "../../src/fleet/types.js";
import { RemoteError } from "../../src/fleet/types.js";
import { makeHome, rmTemp } from "../helpers.js";

// Kabul (T20261111-51, F-vlad-314): `task close` uzak yolunun SIRASI/KARARLARI sahte CloseRemote ile; fetchTaskBranch ve
// remoteBranchPush davranışı gerçek git / sahte transport ile. Kaynak: spec raporu T20261111-49 (close akışı, senaryo 9, 13, 15, 16);
// sözleşme imzaları T20261111-50. Uygulamaya bakılmadan yazıldı: KIRMIZI başlar. Yalnız geçici dizin; gerçek ağ yok.

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const GREEN = `node -e "process.exit(0)"`;
const fake: Launcher = { async launch() { return { ok: true, method: "fake" }; } };
const kbCommit = vi.fn(() => ({ committed: true, pushed: true }));

let base: string, repo: string, cfg: VladConfig, home: string;
beforeEach(() => {
  home = makeHome();
  base = mkdtempSync(join(tmpdir(), "vlad-bp-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = defaultConfig();
  cfg.worktreeDir = join(base, "wt");
  writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(repo)}
stack: [ts]
status: active
autonomy: commit
default_branch: main
gate: ${JSON.stringify(GREEN)}
last_activity: null
last_scanned: null
---

## Özet
x
`);
  kbCommit.mockClear();
});
afterEach(() => { rmTemp(base); rmTemp(home); });

const REPORT = "### Yapılanlar\nx\n### Test sonuçları\ngate yeşil; entegrasyon branch'i merge edildi\n### Kabul kriterleri\nkarşılandı\n";
async function ready(o: { parent?: string; kind?: "dev" | "research" } = {}) {
  const t = createTask({ project: "alpha", title: "iş", kind: o.kind ?? "dev", body: "## Tanım\nx\n", ...(o.parent ? { parent: o.parent, phase: "uygulama" } : {}) });
  await launchTask(t.data.id, { launcher: fake, cfg });
  const wt = getTask(t.data.id).data.worktree!;
  writeFileSync(join(wt, "b.txt"), "2");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "iş");
  reportTask(t.data.id, REPORT);
  return { id: t.data.id, wt, head: git(wt, "rev-parse", "HEAD").trim() };
}

/** Sahte uzak: gate yeşil + gerçek head; push/fetch/merge/cleanup çağrıları sırayla `calls`'a yazılır. */
function remoteFor(head: string, calls: string[], o: Partial<CloseRemote> = {}): CloseRemote {
  return {
    machine: () => "win",
    gate: vi.fn(async () => { calls.push("gate"); return { exit: 0, stdout: "", stderr: "", head }; }),
    push: vi.fn(async (_t, _m, h): Promise<BranchPushResult> => { calls.push(`push:${h}`); return { branch: "", head: h, pushed: true, remote: "origin" }; }),
    fetch: vi.fn(async (t, h) => { calls.push(`fetch:${h}`); git(repo, "update-ref", `refs/remotes/origin/vlad/${t.data.id}`, h); }),
    preview: vi.fn(async () => { calls.push("preview"); return { log: "l", diffStat: "d", conflicts: [] }; }),
    merge: vi.fn(async () => { calls.push("remote-merge"); return { head: "c".repeat(40), merged: true }; }),
    cleanup: vi.fn(async () => { calls.push("cleanup"); }),
    ...o,
  };
}
const deps = (remote: CloseRemote): Partial<CloseDeps> => ({ cfg, kbCommit, closeWorker: () => {}, remote });
const step = (r: { steps: { step: string; status: string }[] }, s: string) => r.steps.find((x) => x.step === s)?.status;

describe("task close (sahte uzak): sıra ve karar noktaları", () => {
  it("sıra gate → push(gate'lenen sha) → fetch(aynı sha) → merge BEYİNDE; uzak merge çağrılmaz; günlüğe push satırı", async () => {
    const { id, head } = await ready();
    const calls: string[] = [];
    const remote = remoteFor(head, calls);
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, stopped_at: null });
    expect(calls.filter((c) => /^(gate|push|fetch)/.test(c))).toEqual(["gate", `push:${head}`, `fetch:${head}`]);
    expect(r.steps.map((s) => s.step)).toEqual(["precheck", "gate", "push", "fetch", "conflict", "confirm", "merge", "done", "cleanup", "findings", "kb"]);
    expect(remote.merge).not.toHaveBeenCalled();
    expect(readFileSync(join(repo, "b.txt"), "utf8")).toBe("2"); // merge beyin deposunda
    expect(git(repo, "log", "-1", "--format=%p").trim().split(" ")).toHaveLength(2);
    expect(getTask(id).data.state).toBe("done");
    expect(getTask(id).body).toContain(`branch-push: vlad/${id} @ ${head.slice(0, 12)} origin'e itildi (win)`);
  });

  it("push hatası: stopped_at push; fetch/merge çağrılmaz, beyin ana dalı ve durum değişmez", async () => {
    const { id, head } = await ready();
    const calls: string[] = [];
    const remote = remoteFor(head, calls, { push: vi.fn(async () => { throw new RemoteError("conflict", "conflict: origin'de farklı uç [diverged]"); }) });
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r).toMatchObject({ ok: false, stopped_at: "push" });
    expect(r.reason).toContain("diverged");
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(remote.merge).not.toHaveBeenCalled();
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
    expect(getTask(id).body).not.toContain("origin'e itildi");
  });

  it("fetch hatası: stopped_at fetch; merge yok", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, [], { fetch: vi.fn(async () => { throw new Error("FETCH_HEAD gate'lenen sha değil"); }) });
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r).toMatchObject({ ok: false, stopped_at: "fetch" });
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    expect(getTask(id).data.state).toBe("awaiting_approval");
  });

  it("kırmızı gate'te push/fetch çağrılmaz", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, [], { gate: vi.fn(async () => ({ exit: 1, stdout: "x", stderr: "", head })) });
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(remote.push).not.toHaveBeenCalled();
    expect(remote.fetch).not.toHaveBeenCalled();
  });

  it("senaryo 20: --head gate'lenen head'den farklıysa push öncesi durur", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, []);
    const r = await closeTask(id, { yes: true, head: "deadbee" }, deps(remote));
    expect(r).toMatchObject({ ok: false, stopped_at: "gate" });
    expect(remote.push).not.toHaveBeenCalled();
  });

  it("onay durağında (--yes yok) push+fetch yapılmıştır, merge yoktur; yeniden koşu idempotent devam eder", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, []);
    const first = await closeTask(id, {}, deps(remote));
    expect(first).toMatchObject({ ok: false, stopped_at: "confirm", head });
    expect(step(first, "push")).toBe("ok");
    expect(step(first, "fetch")).toBe("ok");
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
    const again = await closeTask(id, { yes: true, head: head.slice(0, 12) }, deps(remote));
    expect(again.ok).toBe(true);
  });

  it("origin zaten gate sha'sında (pushed:false) → hata değil, günlük satırı yine yazılır ve akış sürer", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, [], { push: vi.fn(async (_t, _m, h) => ({ branch: `vlad/${id}`, head: h, pushed: false, remote: "origin" as const })) });
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r.ok).toBe(true);
    expect(step(r, "push")).toBe("ok");
  });

  it("senaryo 9: yerel görevde push/fetch çağrılmaz, adımlar listede yok", async () => {
    const { id } = await ready();
    const remote = remoteFor("0".repeat(40), [], { machine: () => null });
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r.ok).toBe(true);
    expect(remote.push).not.toHaveBeenCalled();
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(r.steps.map((s) => s.step)).not.toContain("push");
    expect(r.steps.map((s) => s.step)).not.toContain("fetch");
  });

  it("senaryo 13: uzak FAZ görevinde (parent) op çağrılmaz; faz→çatı merge'ü bugünkü gibi işçide kalır", async () => {
    const pipe = createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" }).data.id;
    const { id, head } = await ready({ parent: pipe });
    const remote = remoteFor(head, []);
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(remote.push).not.toHaveBeenCalled();
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(remote.merge).toHaveBeenCalledTimes(1);
  });

  it("BUG (mevcut): uzak merge'e verilen görev nesnesi yeşil gate kaydını taşımalı; yoksa remoteMerge 'yeşil gate kaydı yok' diye patlar", async () => {
    const pipe = createTask({ project: "alpha", title: "çatı", kind: "pipeline", body: "" }).data.id;
    const { id, head } = await ready({ parent: pipe });
    const seen: unknown[] = [];
    const remote = remoteFor(head, [], { merge: vi.fn(async (t) => { seen.push(t.data.last_green_gate?.head ?? null); return { head: "c".repeat(40), merged: true }; }) });
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(seen).toEqual([head]); // close gate'ten sonra görevi yeniden okuyup merge'e vermeli (bayat t0 → null)
  });

  it("senaryo 16: done görevde yeniden koşu push/fetch/merge çağırmaz", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, []);
    expect((await closeTask(id, { yes: true }, deps(remote))).ok).toBe(true);
    (remote.push as ReturnType<typeof vi.fn>).mockClear();
    (remote.fetch as ReturnType<typeof vi.fn>).mockClear();
    const again = await closeTask(id, { yes: true }, deps(remote));
    expect(again.ok).toBe(true);
    expect(remote.push).not.toHaveBeenCalled();
    expect(remote.fetch).not.toHaveBeenCalled();
    expect(remote.merge).not.toHaveBeenCalled();
  });

  it("F-vlad-308 uzak kısmı: done ama gate'lenen head hedef dalda değil → precheck'te durur", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head, []);
    expect(await closeTask(id, {}, deps(remote))).toMatchObject({ stopped_at: "confirm" }); // gate kaydı (last_green_gate) yazıldı, merge yok
    setState(id, "done");
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r).toMatchObject({ ok: false, stopped_at: "precheck" });
    expect(r.reason).toMatch(/merge/i);
    expect(existsSync(join(repo, "b.txt"))).toBe(false);
  });
});

describe("remoteBranchPush (beyin tarafı çağrı)", () => {
  it("branch-push op'unu tam 5 alanla ve 150 sn zaman aşımıyla çağırır; yalnız `result` döner", async () => {
    const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
    const sha = "b".repeat(40);
    const call = vi.fn(async () => ({ result: { branch: `vlad/${t.data.id}`, head: sha, pushed: true, remote: "origin" } }));
    const out = await remoteBranchPush({ call } as unknown as RemoteTransport, "win", t, sha);
    expect(out).toEqual({ branch: `vlad/${t.data.id}`, head: sha, pushed: true, remote: "origin" });
    expect(call).toHaveBeenCalledTimes(1);
    const [machine, op, args, opts] = (call.mock.calls[0] as unknown) as [string, string, Record<string, unknown>, { timeoutMs: number }];
    expect(machine).toBe("win");
    expect(op).toBe("branch-push");
    expect(args).toEqual({ taskId: t.data.id, project: "alpha", repoName: "alpha", branch: `vlad/${t.data.id}`, expectHead: sha });
    expect(opts.timeoutMs).toBe(150_000);
  });
  it("RemoteError (conflict/failed) yutulmadan yayılır", async () => {
    const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
    const call = vi.fn(async () => { throw new RemoteError("failed", "failed: [push_rejected]"); });
    await expect(remoteBranchPush({ call } as unknown as RemoteTransport, "win", t, "b".repeat(40))).rejects.toMatchObject({ code: "failed" });
  });
});

describe("fetchTaskBranch (beyinde gerçek git; bare origin)", () => {
  /** repo = origin'in klonu; origin'de vlad/<id> dalı `tip`'te. */
  async function withOrigin() {
    const origin = join(base, "origin.git");
    mkdirSync(origin);
    git(origin, "init", "--bare", "-b", "main");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "origin", "main");
    const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
    const other = join(base, "uzak-klon");
    git(base, "clone", origin, other);
    writeFileSync(join(other, "x.txt"), "x");
    git(other, "add", ".");
    git(other, "commit", "-m", "uzak iş");
    git(other, "push", "origin", `HEAD:refs/heads/vlad/${t.data.id}`);
    return { t, origin, tip: git(other, "rev-parse", "HEAD").trim() };
  }
  it("dal beklenen sha'da → çözülür; nesne beyne gelir, yerel refs/heads/vlad/<id> yaratılmaz", async () => {
    const { t, tip } = await withOrigin();
    await expect(fetchTaskBranch(t, tip)).resolves.toBeUndefined();
    expect(git(repo, "cat-file", "-t", tip).trim()).toBe("commit");
    expect(git(repo, "branch", "--list", `vlad/${t.data.id}`).trim()).toBe("");
  });
  it("senaryo 15: FETCH_HEAD beklenen sha'dan farklı → hata (merge'e geçilmez)", async () => {
    const { t } = await withOrigin();
    await expect(fetchTaskBranch(t, "a".repeat(40))).rejects.toThrow();
  });
  it("origin'de dal yok → hata", async () => {
    const { t } = await withOrigin();
    git(join(base, "origin.git"), "update-ref", "-d", `refs/heads/vlad/${t.data.id}`);
    await expect(fetchTaskBranch(t, "a".repeat(40))).rejects.toThrow();
  });
  it("beyin deposunda origin yok → hata", async () => {
    const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
    await expect(fetchTaskBranch(t, "a".repeat(40))).rejects.toThrow();
  });
});
