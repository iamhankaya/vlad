// Kabul (T20261111-51, F-vlad-314): `branch-push` op'u gerçek işçi Agent'ında (handleRequest), bare origin + klonlarla.
// Kaynak: spec raporu T20261111-49 "Op sözleşmesi" + senaryolar 1-8, 11, 12, 17-19; kabul kriterleri 1-6. Uygulamaya bakılmadan yazıldı: KIRMIZI başlar.
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { git, runVlad } from "./machines-world.js";
import { makeBpWorld, type BpWorld } from "./branch-push-world.js";

let b: BpWorld | undefined;
afterEach(async () => { await b?.w.cleanup(); b = undefined; });
const T = 120_000;
const args = (x: BpWorld, head: string, extra: object = {}) => ({ taskId: x.id, project: x.w.slug, repoName: x.w.repoName, branch: `vlad/${x.id}`, expectHead: head, ...extra });
const head = (x: BpWorld) => git(x.wt, "rev-parse", "HEAD").trim();

describe("branch-push (agent): mutlu yol ve idempotans", () => {
  it("senaryo 1: yalnız vlad/<id> origin'e gider; yanıt 4 alan, URL/yol yok; main/tag yok", async () => {
    b = await makeBpWorld();
    const h = head(b);
    git(b.wt, "tag", "yerel-etiket", h); // etiketler yolculuğa katılmaz
    const before = b.originRefs();
    const r = await b.op(args(b, h));
    expect(r.code, JSON.stringify(r)).toBe("ok");
    expect(Object.keys(r.result).sort()).toEqual(["branch", "head", "pushed", "remote"]);
    expect(r.result).toEqual({ branch: `vlad/${b.id}`, head: h, pushed: true, remote: "origin" });
    expect(JSON.stringify(r)).not.toContain(b.origin);
    expect(b.originRefs()).toEqual({ ...before, [`refs/heads/vlad/${b.id}`]: h });
    expect(Object.keys(b.originRefs()).some((k) => k.startsWith("refs/tags/"))).toBe(false);
  }, T);

  it("kabul 2: push argv'si tam biçimde: `origin <sha>:refs/heads/vlad/<id>`, force/+/tags/mirror/all/delete yok", async () => {
    b = await makeBpWorld();
    const h = head(b);
    expect((await b.op(args(b, h))).code).toBe("ok");
    const pushes = b.pushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain(`origin ${h}:refs/heads/vlad/${b.id}`);
    expect(pushes[0]).not.toMatch(/--force|--force-with-lease|--tags|--mirror|--all|--delete|--prune| -f\b| \+\S| :refs/);
  }, T);

  it("senaryo 7: origin zaten expectHead'de → pushed:false, ikinci push yok", async () => {
    b = await makeBpWorld();
    const h = head(b);
    expect((await b.op(args(b, h))).result.pushed).toBe(true);
    const again = await b.op(args(b, h));
    expect(again.code, JSON.stringify(again)).toBe("ok");
    expect(again.result).toEqual({ branch: `vlad/${b.id}`, head: h, pushed: false, remote: "origin" });
    expect(b.pushes()).toHaveLength(1);
  }, T);

  it("senaryo 17: aynı opId ile yeniden gönderim (zaman aşımı sonrası) günlükten aynı yanıtı verir, ikinci push yok", async () => {
    b = await makeBpWorld();
    const h = head(b);
    const first = await b.op(args(b, h), { opId: "bp-replay-0001" });
    const second = await b.op(args(b, h), { opId: "bp-replay-0001" });
    expect(first.code).toBe("ok");
    expect(second.code).toBe("ok");
    expect(second.result).toEqual(first.result);
    expect(b.pushes()).toHaveLength(1);
  }, T);

  it("origin'deki uç dalın atası ise fast-forward push (force'suz)", async () => {
    b = await makeBpWorld();
    const h1 = head(b);
    expect((await b.op(args(b, h1))).code).toBe("ok");
    const h2 = b.commit("ikinci.txt");
    const r = await b.op(args(b, h2));
    expect(r.code, JSON.stringify(r)).toBe("ok");
    expect(r.result.pushed).toBe(true);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBe(h2);
  }, T);
});

describe("branch-push (agent): hata yolları — origin değişmez", () => {
  it("senaryo 6: origin'de ata olmayan farklı sha → conflict [diverged], origin'deki yabancı uç korunur", async () => {
    b = await makeBpWorld();
    const foreign = b.pushForeign();
    const r = await b.op(args(b, head(b)));
    expect(r.code).toBe("conflict");
    expect(r.error).toContain("[diverged]");
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBe(foreign);
    expect(b.pushes()).toHaveLength(0);
  }, T);

  it("senaryo 8: dal ucu expectHead değil → failed [stale_tip]; push yok", async () => {
    b = await makeBpWorld();
    const old = head(b);
    b.commit("sonradan.txt");
    const r = await b.op(args(b, old));
    expect(r.code).toBe("failed");
    expect(r.error).toContain("[stale_tip]");
    expect(b.pushes()).toHaveLength(0);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBeUndefined();
  }, T);

  it("işçi reposunda origin yok → failed [no_origin]", async () => {
    b = await makeBpWorld();
    git(b.w.workerRepo, "remote", "remove", "origin");
    const r = await b.op(args(b, head(b)));
    expect(r.code).toBe("failed");
    expect(r.error).toContain("[no_origin]");
    expect(b.pushes()).toHaveLength(0);
  }, T);

  it("senaryo 19: origin erişilemez → failed; hata iletisi URL/yol/gizli parça sızdırmaz", async () => {
    b = await makeBpWorld();
    const secret = "GIZLI-SUNUCU-7431";
    git(b.w.workerRepo, "remote", "set-url", "origin", `https://kullanici:parola@${secret}.invalid/depo.git`);
    const r = await b.op(args(b, head(b)));
    expect(r.code).toBe("failed");
    const blob = JSON.stringify(r);
    for (const leak of [secret, "parola", b.origin, b.w.workerRepo, b.wt]) expect(blob).not.toContain(leak);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBeUndefined();
  }, T);
});

describe("branch-push (agent): reddedilen girdiler — git çalışmaz, origin değişmez", () => {
  it("senaryo 2-5, 18: başka dal/ref, refspec biçimleri, ek alan, kötü sha → bad_request", async () => {
    b = await makeBpWorld();
    const h = head(b);
    const before = b.originRefs();
    const attempts: object[] = [
      args(b, h, { branch: "main" }),
      args(b, h, { branch: "refs/heads/main" }),
      args(b, h, { branch: `vlad/${b.id}:main` }),
      args(b, h, { branch: `+vlad/${b.id}` }),
      args(b, h, { branch: "vlad/T20990101-99" }), // başka görevin dalı
      args(b, h, { branch: "../../main" }),
      args(b, h, { force: true }),
      args(b, h, { refspec: `+${h}:refs/heads/main` }),
      args(b, h, { remote: "evil" }),
      args(b, h, { tags: true }),
      args(b, h, { path: b.w.brainRepo }),
      args(b, "main"),
      args(b, "HEAD"),
      args(b, h.slice(0, 7)),
      args(b, h.toUpperCase()),
    ];
    for (const a of attempts) {
      const r = await b.op(a);
      expect(r.code, JSON.stringify(a)).toBe("bad_request");
    }
    expect(b.pushes()).toHaveLength(0);
    expect(b.originRefs()).toEqual(before);
  }, T);

  it("senaryo 11: bilinmeyen görev ve başka makinenin görevi → forbidden/not_found", async () => {
    b = await makeBpWorld();
    const h = head(b);
    const ghost = await b.op({ ...args(b, h), taskId: "T20990101-77", branch: "vlad/T20990101-77" });
    expect(["forbidden", "not_found"]).toContain(ghost.code);
    b.w.setFront(b.id, { machine: "mac" });
    expect((await runVlad(b.w.brain, ["kb", "commit", "bp-baska-makine", "--push"])).code).toBe(0);
    const sync = await b.op({ expectSha: git(b.w.brain.kb, "rev-parse", "HEAD").trim() }, { name: "kb-sync" });
    expect(sync.code, JSON.stringify(sync)).toBe("ok");
    const other = await b.op(args(b, h));
    expect(["forbidden", "not_found"]).toContain(other.code);
    expect(b.pushes()).toHaveLength(0);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBeUndefined();
  }, T);

  it("senaryo 12: konsol/işçi/kendi kimliği op'u çağıramaz (kimlikte düşer); origin değişmez", async () => {
    b = await makeBpWorld();
    const h = head(b);
    for (const from of ["windows", "desktop"]) {
      const r = await b.op(args(b, h), { from });
      expect(r.code, from).toBe("auth");
    }
    expect(b.pushes()).toHaveLength(0);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBeUndefined();
  }, T);

  it("görev başlatma kaydı/worktree kaybolduysa (dal yok) → hata, origin'e ref yazılmaz", async () => {
    b = await makeBpWorld();
    const h = head(b);
    git(b.w.workerRepo, "worktree", "remove", "--force", b.wt);
    git(b.w.workerRepo, "branch", "-D", `vlad/${b.id}`);
    rmSync(b.wt, { recursive: true, force: true });
    const r = await b.op(args(b, h));
    expect(["not_found", "failed", "forbidden"]).toContain(r.code);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBeUndefined();
  }, T);
});
