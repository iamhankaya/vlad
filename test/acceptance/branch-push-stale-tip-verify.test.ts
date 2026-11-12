// Doğrulama (T20261112-02, F-vlad-320): gerçek bare origin + gerçek işçi Agent'ı (handleRequest).
// branch-push sonrası işçi ucu ilerlerse `cleanup` expectHead ile reddeder; worktree ve yeni commit korunur.
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "./machines-world.js";
import { makeBpWorld, type BpWorld } from "./branch-push-world.js";

let b: BpWorld | undefined;
afterEach(async () => { await b?.w.cleanup(); b = undefined; });
const T = 120_000;
const base = (x: BpWorld) => ({ taskId: x.id, project: x.w.slug, repoName: x.w.repoName, terminal: true });

describe("F-vlad-320 (agent, gerçek git): push sonrası ilerleyen işçi ucu", () => {
  it("push edilen sha ile cleanup → silinir (eşit uç, regresyon yok)", async () => {
    b = await makeBpWorld();
    const h = git(b.wt, "rev-parse", "HEAD").trim();
    const p = await b.op({ taskId: b.id, project: b.w.slug, repoName: b.w.repoName, branch: `vlad/${b.id}`, expectHead: h });
    expect(p.code, JSON.stringify(p)).toBe("ok");
    const c = await b.op({ ...base(b), expectHead: h }, { name: "cleanup" });
    expect(c.code, JSON.stringify(c)).toBe("ok");
    expect(existsSync(b.wt)).toBe(false);
  }, T);

  it("push sonrası işçi yeni commit atar → cleanup failed [stale_tip]; worktree ve yeni uç durur, origin gate'lenen sha'da kalır", async () => {
    b = await makeBpWorld();
    const h = git(b.wt, "rev-parse", "HEAD").trim();
    expect((await b.op({ taskId: b.id, project: b.w.slug, repoName: b.w.repoName, branch: `vlad/${b.id}`, expectHead: h })).code).toBe("ok");
    const advanced = b.commit("push-sonrasi.txt");
    const c = await b.op({ ...base(b), expectHead: h }, { name: "cleanup" });
    expect(c.code).toBe("failed");
    expect(c.error).toContain("[stale_tip]");
    expect(existsSync(b.wt)).toBe(true);
    expect(git(b.wt, "rev-parse", "HEAD").trim()).toBe(advanced);
    expect(b.originRefs()[`refs/heads/vlad/${b.id}`]).toBe(h);
  }, T);
});
