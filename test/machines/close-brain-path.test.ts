import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type VladConfig } from "../../src/kb/index.js";
import type { Launcher } from "../../src/launcher/index.js";
import { writeProject } from "../../src/projects/store.js";
import { createTask, getTask, launchTask, reportTask } from "../../src/tasks/index.js";
import { closeTask, type CloseDeps, type CloseRemote } from "../../src/machines/close.js";
import { fetchTaskBranch } from "../../src/machines/remote.js";
import { makeHome, rmTemp } from "../helpers.js";

// F-vlad-200 çözümü (kart yolu başka OS'tan → beynin roots'undaki repo) uzak close'un beyin tarafında da geçerli olmalı:
// fetch, conflict önizlemesi, merge ve "zaten done" ancestry kontrolü aynı yardımcıyla çözülür. Yalnız geçici dizin.
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", ...args], { cwd, stdio: "pipe", encoding: "utf8" });
const fake: Launcher = { async launch() { return { ok: true, method: "fake" }; } };
const kbCommit = vi.fn(() => ({ committed: true, pushed: true }));
const FOREIGN = "C:\\dev\\alpha"; // bu makinede yok

let base: string, repo: string, cfg: VladConfig, home: string;
beforeEach(() => {
  home = makeHome();
  base = mkdtempSync(join(tmpdir(), "vlad-bpath-"));
  repo = join(base, "alpha");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "1");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "first");
  cfg = { ...defaultConfig(), worktreeDir: join(base, "wt"), brain: "mac",
    machines: [{ name: "mac", os: "darwin", agent: { port: 7437 }, roots: [base] }] } as VladConfig;
  writeProject("alpha", `---
slug: alpha
name: Alpha
path: ${JSON.stringify(FOREIGN)}
stack: [ts]
status: active
autonomy: commit
default_branch: main
gate: ${JSON.stringify(`node -e "process.exit(0)"`)}
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
async function ready() {
  const t = createTask({ project: "alpha", title: "iş", kind: "dev", body: "## Tanım\nx\n" });
  await launchTask(t.data.id, { launcher: fake, cfg });
  const wt = getTask(t.data.id).data.worktree!;
  writeFileSync(join(wt, "b.txt"), "2");
  git(wt, "add", ".");
  git(wt, "commit", "-m", "iş");
  reportTask(t.data.id, REPORT);
  return { id: t.data.id, head: git(wt, "rev-parse", "HEAD").trim() };
}
function remoteFor(head: string): CloseRemote {
  return {
    machine: () => "win",
    gate: vi.fn(async () => ({ exit: 0, stdout: "", stderr: "", head })),
    push: vi.fn(async (_t, _m, h) => ({ branch: "", head: h, pushed: true, remote: "origin" })),
    fetch: vi.fn(async (t, h) => { git(repo, "update-ref", `refs/remotes/origin/vlad/${t.data.id}`, h); }),
    preview: vi.fn(async () => ({ log: "", diffStat: "", conflicts: [] })),
    merge: vi.fn(async () => ({ head: "c".repeat(40), merged: true })),
    cleanup: vi.fn(async () => {}),
    verifyTip: vi.fn(async () => {}), // F-vlad-328: verifyTip zorunlu
  };
}
const deps = (remote: CloseRemote): Partial<CloseDeps> => ({ cfg, kbCommit, closeWorker: () => {}, remote });

describe("uzak close: Windows yollu kart, beyin Mac (roots)", () => {
  it("fetch→conflict önizleme→merge beyindeki roots reposunda çalışır; zaten-done yeniden koşusu ancestry'yi aynı yoldan çözer", async () => {
    const { id, head } = await ready();
    const remote = remoteFor(head);
    const r = await closeTask(id, { yes: true }, deps(remote));
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, stopped_at: null });
    expect(existsSync(join(repo, "b.txt"))).toBe(true); // merge roots reposunda
    expect(git(repo, "log", "-1", "--format=%p").trim().split(" ")).toHaveLength(2);
    expect(r.steps.find((s) => s.step === "conflict")?.status).toBe("ok");
    const again = await closeTask(id, { yes: true }, deps(remoteFor(head)));
    expect(again.steps.find((s) => s.step === "precheck")?.status, JSON.stringify(again)).toBe("ok"); // ancestry yanlış 'merge edilmemiş' demez
  });

  it("zaten done + head ana dalda değil → ancestry roots reposunda doğru reddeder", async () => {
    const { id, head } = await ready();
    await closeTask(id, { yes: true }, deps(remoteFor(head)));
    git(repo, "reset", "--hard", "HEAD~1"); // merge geri alındı: head artık main'de değil
    const again = await closeTask(id, { yes: true }, deps(remoteFor(head)));
    expect(again.reason).toContain("merge edilmemiş");
  });

  it("fetchTaskBranch(task, head, cfg): origin'den roots reposuna çeker", async () => {
    const { id, head } = await ready();
    const origin = join(base, "origin.git");
    git(base, "init", "--bare", origin);
    git(repo, "remote", "add", "origin", origin);
    git(getTask(id).data.worktree!, "push", origin, `HEAD:refs/heads/vlad/${id}`);
    await expect(fetchTaskBranch(getTask(id), head, cfg)).resolves.toBeUndefined();
  });
});
