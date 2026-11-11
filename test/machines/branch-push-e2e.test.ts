import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { front, git, makeWorld, runVlad, type World } from "../acceptance/machines-world.js";
import { rawCall, pairKey } from "../acceptance/machines-raw.js";

// F-vlad-314 uçtan uca: gerçek Agent süreci (işçi), bare kod origin'i, iki klon (işçi/beyin) ve `vlad task close` (beyin CLI'ı).
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

describe("branch-push uçtan uca (task close, uzak tek görev)", () => {
  it("gate → push → fetch → beyinde merge: iş beyin ana dalına gelir, origin'e yalnız vlad/<id> gider", async () => {
    const { w, id, origin, head } = await setup({ origin: true });
    const mainBefore = git(origin, "rev-parse", "main").trim();
    const r = await runVlad(w.brain, ["task", "close", id, "--yes", "--json"], { timeoutMs: 90_000 });
    expect(r.code, r.err + r.out).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.steps.map((s: { step: string }) => s.step)).toEqual(expect.arrayContaining(["gate", "push", "fetch", "merge", "done"]));
    expect(git(origin, "rev-parse", `vlad/${id}`).trim()).toBe(head);
    expect(git(origin, "rev-parse", "main").trim()).toBe(mainBefore); // ana dal origin'de değişmez
    expect(git(origin, "tag").trim()).toBe("");
    expect(readFileSync(join(w.brainRepo, "iş.txt"), "utf8")).toBe("uzak iş\n");
    expect(git(w.brainRepo, "branch", "--list", `vlad/${id}`).trim()).toBe(""); // yerel dal yaratılmaz
    expect(front(w.readTask(w.brain, id), "state")).toBe("done");
    expect(w.readTask(w.brain, id)).toContain(`branch-push: vlad/${id} @ ${head.slice(0, 12)}`);
    // yeniden koşu idempotent
    const again = await runVlad(w.brain, ["task", "close", id, "--yes", "--json"], { timeoutMs: 90_000 });
    expect(again.code, again.err + again.out).toBe(0);
  }, 180_000);

  it("işçide origin yok → close push'ta durur, beyne hiçbir şey gelmez", async () => {
    const { w, id } = await setup({ origin: false });
    const r = await runVlad(w.brain, ["task", "close", id, "--yes", "--json"], { timeoutMs: 90_000 });
    expect(r.code).toBe(1);
    const out = JSON.parse(r.out);
    expect(out.stopped_at).toBe("push");
    expect(out.reason).toContain("no_origin");
    expect(existsSync(join(w.brainRepo, "iş.txt"))).toBe(false);
    expect(front(w.readTask(w.brain, id), "state")).toBe("awaiting_approval");
  }, 180_000);
});
