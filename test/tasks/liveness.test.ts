import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig, nowIso, writeDoc } from "../../src/kb/index.js";
import { createTask, getTask, setState } from "../../src/tasks/index.js";
import { markSilentWorkers, transcriptMtime, type LivenessProbe } from "../../src/tasks/liveness.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { makeHome } from "../helpers.js";

const MIN = 60_000;
const now = new Date("2026-10-26T12:00:00+03:00");
let configDir: string;

beforeEach(() => {
  makeHome();
  configDir = mkdtempSync(join(tmpdir(), "vlad-live-"));
});

/** Rewrites the task file with `updated` set `ageMin` minutes before `now` (saveTask would stamp the real clock). */
function age(id: string, ageMin: number, patch: Record<string, unknown> = {}) {
  const t = getTask(id);
  writeDoc(t.file, { ...t.data, ...patch, updated: nowIso(new Date(now.getTime() - ageMin * MIN)) }, t.body);
}
/** Running local dev task whose last file update was `ageMin` minutes before `now`. */
function runningLocal(ageMin: number, worktree = "C:\\x\\wt\\T1") {
  const t = createTask({ project: "alpha", title: "t", kind: "dev", body: "" });
  setState(t.data.id, "running", { worktree });
  age(t.data.id, ageMin);
  return t.data.id;
}
const probe = (o: Partial<LivenessProbe>): LivenessProbe => ({ alive: () => true, transcriptMtime: () => null, ...o });
const stalledIds = (p: LivenessProbe, cfg = defaultConfig()) => markSilentWorkers(now, cfg, p, "win32").map((t) => t.data.id);

describe("markSilentWorkers", () => {
  it("stalls a task whose worker process is gone and which has been silent past the grace", () => {
    const id = runningLocal(30);
    expect(stalledIds(probe({ alive: () => false }))).toEqual([id]);
    expect(getTask(id).data.state).toBe("stalled");
  });
  it("leaves a freshly launched task alone even before its process shows up", () => {
    runningLocal(1);
    expect(stalledIds(probe({ alive: () => false }))).toEqual([]);
  });
  it("stalls a living process whose transcript and task file are older than the silence limit", () => {
    const id = runningLocal(20);
    expect(stalledIds(probe({ transcriptMtime: () => now.getTime() - 20 * MIN }))).toEqual([id]);
  });
  it("a fresh transcript keeps a task running even when the task file is old", () => {
    runningLocal(120);
    expect(stalledIds(probe({ transcriptMtime: () => now.getTime() - 2 * MIN }))).toEqual([]);
  });
  it("honors workerSilentMinutes from the config", () => {
    const id = runningLocal(20);
    const cfg = { ...defaultConfig(), workerSilentMinutes: 30 };
    expect(stalledIds(probe({}), cfg)).toEqual([]);
    expect(stalledIds(probe({}), { ...cfg, workerSilentMinutes: 10 })).toEqual([id]);
  });
  it("process list unavailable (null) → only the silence rule applies", () => {
    runningLocal(10);
    expect(stalledIds(probe({ alive: () => null }))).toEqual([]);
  });
  it("never touches cloud tasks, pipelines or tasks without a worktree", () => {
    const cloud = runningLocal(300);
    age(cloud, 300, { session_id: "session_abc" });
    const pipe = createTask({ project: "alpha", title: "p", kind: "pipeline", body: "" });
    setState(pipe.data.id, "running");
    age(pipe.data.id, 300);
    const noWt = createTask({ project: "alpha", title: "n", kind: "dev", body: "" });
    setState(noWt.data.id, "running");
    age(noWt.data.id, 300);
    expect(stalledIds(probe({ alive: () => false }))).toEqual([]);
  });
  it("is a no-op outside Windows", () => {
    runningLocal(300);
    expect(markSilentWorkers(now, defaultConfig(), probe({ alive: () => false }), "linux")).toEqual([]);
  });
  it("statusSummary reports the silent worker in newlyStalled", () => {
    const id = runningLocal(300);
    expect(statusSummary(defaultConfig(), now, probe({ alive: () => false }), "win32").newlyStalled).toContain(id);
  });
});

describe("transcriptMtime", () => {
  it("returns the newest .jsonl mtime of the worktree's project dir, null when absent", () => {
    const wt = "C:\\dev\\vlad-wt\\T9";
    expect(transcriptMtime(wt, configDir)).toBeNull();
    const dir = join(configDir, "projects", "C--dev-vlad-wt-T9");
    mkdirSync(dir, { recursive: true });
    const a = join(dir, "a.jsonl");
    const b = join(dir, "b.jsonl");
    writeFileSync(a, "{}");
    writeFileSync(b, "{}");
    utimesSync(a, new Date(1_000_000), new Date(1_000_000));
    utimesSync(b, new Date(5_000_000), new Date(5_000_000));
    expect(transcriptMtime(wt, configDir)).toBe(5_000_000);
  });
});
