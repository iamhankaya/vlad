import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { front, git, makeWorld, runVlad, type World } from "../acceptance/machines-world.js";
import { rawCall, pairKey } from "../acceptance/machines-raw.js";

// T20261111-53 doğrulama (F-vlad-314) — ek uçtan uca senaryolar. Kurulum branch-push-e2e.test.ts ile aynı: gerçek Agent süreci (işçi), bare kod origin'i, iki klon (işçi/beyin) ve `vlad task close` (beyin CLI'ı).
// Yalnız geçici dizinler; gerçek kaynağa dokunmaz.
let w: World | undefined;
afterEach(async () => { await w?.cleanup(); w = undefined; });
const GATE = `node -e "process.exit(0)"`;

async function setup(o: { origin: boolean }) {
  w = await makeWorld({ cardMachines: ["windows"] });
  await w.startAgents(["worker"]);
  const origin = join(mkdtempSync(join(tmpdir(), "vlad-bp-e2e-")), "code.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-b", "main");
  // iki repo aynı geçmişi paylaşsın: işçi main'i origin'e iter, beyin onu alıp hizalanır
  git(w.workerRepo, "remote", "add", "origin", origin);
  git(w.workerRepo, "push", "-q", "origin", "main");
  git(w.brainRepo, "remote", "add", "origin", origin);
  git(w.brainRepo, "fetch", "-q", "origin");
  git(w.brainRepo, "reset", "-q", "--hard", "origin/main");
  if (!o.origin) git(w.workerRepo, "remote", "remove", "origin");
  for (const a of [["gate", GATE], ["default_branch", "main"]]) {
    const r = await runVlad(w.brain, ["project", "set", w.slug, a[0]!, a[1]!]);
    expect(r.code, r.err).toBe(0);
  }
  const id = await w.newTask();
  const l = await runVlad(w.brain, ["task", "launch", id, "--json"]);
  expect(l.code, l.err).toBe(0);
  const wt = front(w.readTask(w.brain, id), "worktree")!.replace(/^["']|["']$/g, "");
  writeFileSync(join(wt, "iş.txt"), "uzak iş\n");
  git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", "iş");
  const head = git(wt, "rev-parse", "HEAD").trim();
  const rep = join(w.base, "rapor.md");
  writeFileSync(rep, "### Yapılanlar\nx\n### Test sonuçları\nyeşil\n### Kabul kriterleri\nok\n");
  expect((await runVlad(w.brain, ["task", "report", id, "--file", rep])).code).toBe(0);
  const c = await runVlad(w.brain, ["kb", "commit", "gate", "--push"]);
  expect(c.code, c.err).toBe(0);
  const sync = await rawCall({ port: w.agents.worker!.port, key: pairKey(w.pair.keys, "mac", "windows"), from: "mac", to: "windows", op: "kb-sync", args: { expectSha: git(w.brain.kb, "rev-parse", "HEAD").trim() } });
  expect((sync as any).resp.code).toBe("ok");
  return { w, id, origin, head, wt };
}

const closeJson = async (id: string, extra: string[] = []) => runVlad(w!.brain, ["task", "close", id, ...extra, "--json"], { timeoutMs: 90_000 });
const originRefs = (origin: string) => git(origin, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n").sort();

describe("branch-push doğrulama (uçtan uca, gerçek Agent)", () => {
  it("onay durağı: --yes yokken push+fetch yapılır ama merge/done yok; ardından --yes ile tamamlanır (idempotent), cleanup işçide worktree'yi siler", async () => {
    const { w: world, id, origin, head, wt } = await setup({ origin: true });
    expect(world).toBe(w);
    const r1 = await closeJson(id);
    const o1 = JSON.parse(r1.out);
    expect(o1.stopped_at).toBe("confirm");
    expect(o1.steps.map((s: { step: string }) => s.step)).toEqual(expect.arrayContaining(["gate", "push", "fetch"]));
    expect(o1.steps.map((s: { step: string }) => s.step)).not.toContain("merge");
    expect(git(origin, "rev-parse", `vlad/${id}`).trim()).toBe(head);
    expect(existsSync(join(w!.brainRepo, "iş.txt"))).toBe(false);
    expect(front(w!.readTask(w!.brain, id), "state")).toBe("awaiting_approval");
    const before = originRefs(origin);
    const r2 = await closeJson(id, ["--yes"]);
    expect(r2.code, r2.err + r2.out).toBe(0);
    const o2 = JSON.parse(r2.out);
    const cleanup = o2.steps.find((s: { step: string }) => s.step === "cleanup");
    expect(cleanup?.status, JSON.stringify(o2.steps)).toBe("ok");
    expect(existsSync(wt)).toBe(false); // işçi worktree'si silindi; iş origin + beyinde duruyor
    expect(readFileSync(join(w!.brainRepo, "iş.txt"), "utf8")).toBe("uzak iş\n");
    expect(originRefs(origin)).toEqual(before); // ikinci koşu origin'e yeni ref eklemedi
  }, 240_000);

  it("origin'de ayrışmış (ata olmayan) vlad/<id> varsa: close push'ta durur, origin değişmez (force yok), beyine bir şey gelmez", async () => {
    const { w: world, id, origin } = await setup({ origin: true });
    expect(world).toBe(w);
    const other = join(w!.base, "baska-klon");
    git(w!.base, "clone", "-q", origin, other);
    writeFileSync(join(other, "yabanci.txt"), "başkası\n");
    git(other, "add", "-A"); git(other, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "yabancı");
    git(other, "push", "-q", "origin", `HEAD:refs/heads/vlad/${id}`);
    const before = originRefs(origin);
    const r = await closeJson(id, ["--yes"]);
    expect(r.code).toBe(1);
    const o = JSON.parse(r.out);
    expect(o.stopped_at).toBe("push");
    expect(o.reason).toContain("diverged");
    expect(originRefs(origin)).toEqual(before);
    expect(existsSync(join(w!.brainRepo, "iş.txt"))).toBe(false);
    expect(existsSync(join(w!.brainRepo, "yabanci.txt"))).toBe(false);
    expect(front(w!.readTask(w!.brain, id), "state")).toBe("awaiting_approval");
  }, 240_000);

  it("kırmızı gate: push yapılmaz, origin'de vlad/<id> oluşmaz", async () => {
    const { w: world, id, origin } = await setup({ origin: true });
    expect(world).toBe(w);
    const red = await runVlad(w!.brain, ["project", "set", w!.slug, "gate", `node -e "process.exit(3)"`]);
    expect(red.code, red.err).toBe(0);
    const r = await closeJson(id, ["--yes"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).stopped_at).toBe("gate");
    expect(originRefs(origin).some((l) => l.includes(`vlad/${id}`))).toBe(false);
  }, 240_000);
});
