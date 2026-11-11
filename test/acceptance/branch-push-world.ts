// Kabul fazı (T20261111-51, F-vlad-314): `branch-push` testlerinin ortak dünyası. Tester sahipliği.
// Yalnız geçici dizinler: bare origin + beyin/işçi repoları origin'in klonu; işçi Agent'ı gerçek (handleRequest), ağ yok.
// Kaynak: T20261111-49 spec raporu (op sözleşmesi, close akışı, senaryolar) + T20261111-50 sözleşme raporu.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { front, git, makeWorld, runVlad, type World } from "./machines-world.js";
import { pairKey, rawCall } from "./machines-raw.js";

export const resp = (o: Awaited<ReturnType<typeof rawCall>>) => { expect(o.kind).toBe("response"); return (o as any).resp; };

export interface BpWorld {
  w: World;
  origin: string;
  id: string;
  wt: string;
  trace: string;
  /** işçi worktree'sinde bir commit atar, yeni ucu döner */
  commit(name: string, content?: string): string;
  /** doğrudan Agent çağrısı (varsayılan: beyin kimliği) */
  op(args: object, o?: { from?: string; name?: string; opId?: string }): Promise<any>;
  /** origin'deki ref → sha haritası */
  originRefs(): Record<string, string>;
  /** git trace'indeki `git push` satırları (işçi Agent'ı) */
  pushes(): string[];
  /** origin'e dışarıdan (üçüncü klon) farklı bir commit'le `vlad/<id>` iter */
  pushForeign(): string;
}

/** Beyin + Windows işçisi; kart yolu beyin klonu, ikisinin `origin`'i aynı bare repo; görev başlatılmış, işçi dalında 1 commit var. */
export async function makeBpWorld(o: { gate?: string } = {}): Promise<BpWorld> {
  const w = await makeWorld({ cardMachines: ["windows"] });
  const origin = join(w.base, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "--bare", "-q", "-b", "main");
  git(w.brainRepo, "remote", "add", "origin", origin);
  git(w.brainRepo, "push", "-q", "origin", "main");
  rmSync(w.workerRepo, { recursive: true, force: true });
  git(w.base, "clone", "-q", origin, w.workerRepo);
  const trace = join(w.base, "worker-git-trace.log");
  writeFileSync(trace, "");
  w.worker.env.GIT_TRACE = trace; // işçi Agent'ının çalıştırdığı git komutları (argv doğrulaması)
  await w.startAgents(["worker"]);
  expect((await runVlad(w.brain, ["project", "set", w.slug, "default_branch", "main"])).code).toBe(0);
  expect((await runVlad(w.brain, ["project", "set", w.slug, "gate", o.gate ?? `node -e "process.exit(0)"`])).code).toBe(0);
  const id = await w.newTask();
  const l = await runVlad(w.brain, ["task", "launch", id, "--json"]);
  expect(l.code, l.err).toBe(0);
  const wt = front(w.readTask(w.brain, id), "worktree")!.replace(/^["']|["']$/g, "");
  const key = pairKey(w.pair.keys, "mac", "windows");
  const self = {
    w, origin, id, wt, trace,
    commit(name: string, content = "x\n") {
      writeFileSync(join(wt, name), content);
      git(wt, "add", "-A"); git(wt, "commit", "-q", "-m", `iş ${name}`);
      return git(wt, "rev-parse", "HEAD").trim();
    },
    async op(args: object, x: { from?: string; name?: string; opId?: string } = {}) {
      const from = x.from ?? "mac";
      return resp(await rawCall({ port: w.agents.worker!.port, key: x.from && x.from !== "mac" ? w.pair.keys[x.from]! : key, from, to: "windows", op: x.name ?? "branch-push", args, ...(x.opId ? { opId: x.opId } : {}) }));
    },
    originRefs() {
      const out = git(origin, "for-each-ref", "--format=%(refname) %(objectname)").trim();
      return Object.fromEntries(out ? out.split("\n").map((l) => l.split(" ") as [string, string]) : []);
    },
    pushes() { return readFileSync(trace, "utf8").split("\n").filter((l: string) => /built-in: git push /.test(l)); },
    pushForeign() {
      const other = join(w.base, "foreign");
      git(w.base, "clone", "-q", origin, other);
      writeFileSync(join(other, "yabanci.txt"), "başka\n");
      git(other, "add", "-A"); git(other, "commit", "-q", "-m", "yabancı");
      git(other, "push", "-q", "origin", `HEAD:refs/heads/vlad/${id}`);
      return git(other, "rev-parse", "HEAD").trim();
    },
  } satisfies BpWorld;
  self.commit("is.txt", "iş\n");
  // işçi Agent'ı görev dosyasını kendi kb klonundan okur (machine/worktree alanları): commit + kb-sync
  expect((await runVlad(w.brain, ["kb", "commit", "bp-hazir", "--push"])).code).toBe(0);
  const sync = await self.op({ expectSha: git(w.brain.kb, "rev-parse", "HEAD").trim() }, { name: "kb-sync" });
  expect(sync.code, JSON.stringify(sync)).toBe("ok");
  return self;
}

/** Beyin dünyasında görevi rapora bağlar (awaiting_approval): remote görev `vlad task report` ile. */
export async function report(world: BpWorld, body = "### Yapılanlar\nx\n### Test sonuçları\nyeşil\n### Kabul kriterleri\nkarşılandı\n"): Promise<void> {
  const f = join(world.w.base, `rapor-${world.id}.md`);
  writeFileSync(f, body);
  const r = await runVlad(world.w.brain, ["task", "report", world.id, "--file", f]);
  expect(r.code, r.err).toBe(0);
}
