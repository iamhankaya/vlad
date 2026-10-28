import { beforeEach, describe, expect, it } from "vitest";
import { nowIso, writeDoc } from "../../src/kb/index.js";
import { askTask, createTask, getTask, logTask, setState } from "../../src/tasks/index.js";
import { idleTasks } from "../../src/tasks/liveness.js";
import { makeHome } from "../helpers.js";

const MIN = 60_000;
const now = new Date("2026-10-28T23:30:00+03:00");

beforeEach(() => { makeHome(); });

/** Sets `updated` to `ageMin` before `now` (saveTask stamps the real clock). */
function age(id: string, ageMin: number) {
  const t = getTask(id);
  writeDoc(t.file, { ...t.data, updated: nowIso(new Date(now.getTime() - ageMin * MIN)) }, t.body);
}
const mk = (title = "t") => createTask({ project: "alpha", title, kind: "dev", body: "" }).data.id;

describe("idleTasks", () => {
  it("lists running and blocked tasks quiet for at least N minutes, longest first, with branch and last log", () => {
    const run = mk("run");
    setState(run, "running", { branch: `vlad/${run}`, worktree: "wt-dir" });
    logTask(run, "kaldığım yer: test");
    age(run, 45);
    const blk = mk("blk");
    setState(blk, "running");
    askTask(blk, "soru?");
    age(blk, 90);
    const fresh = mk("fresh");
    setState(fresh, "running");
    age(fresh, 5);
    const queued = mk("queued");
    age(queued, 500);

    const r = idleTasks(now, 30);
    expect(r.map((x) => x.id)).toEqual([blk, run]);
    expect(r[1]).toMatchObject({ state: "running", project: "alpha", idle_minutes: 45, branch: `vlad/${run}` });
    expect(r[1].last_log).toMatch(/kaldığım yer: test/);
    expect(r[0].state).toBe("blocked");
  });

  it("skips pipeline umbrella tasks and uses the boundary inclusively", () => {
    const p = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "" }).data.id;
    setState(p, "running");
    age(p, 600);
    const t = mk();
    setState(t, "running");
    age(t, 30);
    expect(idleTasks(now, 30).map((x) => x.id)).toEqual([t]);
  });
});
