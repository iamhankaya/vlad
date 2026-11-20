import { spawnGuarded } from "../support/spawn-vlad.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueNotice, markDone, defaultNotifyDir } from "../../src/monitor/notify.js";
import { makeHome } from "../helpers.js";
import { isolatedEnv } from "../isolate-env.js";

const cli = resolve(import.meta.dirname, "..", "..", "dist", "cli.js");
let home: string, fakeHome: string;
beforeEach(() => { home = makeHome(); fakeHome = mkdtempSync(join(tmpdir(), "vlad-nhome-")); });
afterEach(() => { rmSync(fakeHome, { recursive: true, force: true }); });
const run = (args: string[]) => {
  const env = { ...isolatedEnv(), VLAD_HOME: home, HOME: fakeHome, USERPROFILE: fakeHome } as Record<string, string | undefined>;
  delete env.VLAD_KB_DIR;
  const r = spawnGuarded("node", [cli, ...args], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const dir = () => defaultNotifyDir(fakeHome);
const n = (task: string, ts: number) => enqueueNotice(dir(), { ts, kind: "alert", server: "medialog", task });

describe("status --summary monitor bildirimi", () => {
  it("kuyruk boşken satır ve JSON alanı sessiz", () => {
    const j = JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out);
    expect(j.summary).not.toContain("monitor bildirimi");
    expect(j.monitorNotices).toEqual({ count: 0, items: [] });
  });
  it("dolu kuyruk: satır en çok 3 kimlik + …; --hook metninde de; done --all sonrası kaybolur", () => {
    for (let i = 1; i <= 4; i++) n(`T20261120-0${i}`, i);
    const j = JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out);
    expect(j.monitorNotices.count).toBe(4);
    expect(j.summary).toContain("4 monitor bildirimi (T20261120-01, T20261120-02, T20261120-03, …)");
    const hook = JSON.parse(run(["status", "--summary", "--hook", "--no-mark"]).out);
    expect(hook.systemMessage).toContain("4 monitor bildirimi");
    markDone(dir(), "all");
    expect(JSON.parse(run(["status", "--summary", "--json", "--no-mark"]).out).summary).not.toContain("monitor bildirimi");
  });
  it("bozuk dosya SessionStart'ı düşürmez", () => {
    n("T20261120-01", 1);
    require("node:fs").writeFileSync(join(dir(), "kotu__alert__T9.json"), "{x");
    const r = run(["status", "--summary", "--hook", "--no-mark"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).systemMessage).toContain("1 monitor bildirimi (T20261120-01)");
  });
});
