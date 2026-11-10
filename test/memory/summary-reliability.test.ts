import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { doneSummaryNote, setProjectSummary, undigestedNote } from "../../src/projects/status.js";
import { writeProject } from "../../src/projects/store.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { createTask, getTask, markDigested, setState } from "../../src/tasks/store.js";
import { makeHome } from "../helpers.js";

const card = (slug: string) => `---\nslug: ${slug}\nname: ${slug}\npath: /tmp/${slug}\nstack: [ts]\nstatus: active\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`;
// relative to now: a fixed calendar date would be a time bomb
const now = () => new Date();
const ago = (ms: number) => new Date(Date.now() - ms);
beforeEach(() => { makeHome(); });

// drives a fresh task to done through the real state machine
function doneTask(project: string, at: Date) {
  const t = createTask({ project, title: "T", kind: "dev", body: "" }, at);
  for (const s of ["running", "awaiting_approval", "done"] as const) setState(t.data.id, s, at);
  return getTask(t.data.id);
}

describe("(a) summaryStale after task set done", () => {
  it("is true with a warning when the card has no summary", () => {
    writeProject("vlad", card("vlad"));
    const t = doneTask("vlad", now());
    const n = doneSummaryNote(t);
    expect(n.summaryStale).toBe(true);
    expect(n.warnings).toEqual([expect.stringContaining("özet bayat")]);
    expect(n.warnings[0]).toContain("/digest");
  });
  it("is true when the summary predates the done task", () => {
    writeProject("vlad", card("vlad"));
    setProjectSummary("vlad", "x", ago(3600_000));
    const n = doneSummaryNote(doneTask("vlad", now()));
    expect(n.summaryStale).toBe(true);
  });
  it("is false (no warning) when the summary is current", () => {
    writeProject("vlad", card("vlad"));
    const t = doneTask("vlad", ago(3600_000));
    setProjectSummary("vlad", "x", now());
    expect(doneSummaryNote(t)).toEqual({ summaryStale: false, warnings: [] });
  });
  it("an unreadable/missing card must not break task set (no summaryStale claim)", () => {
    const t = doneTask("yok-proje", now());
    expect(doneSummaryNote(t)).toEqual({ summaryStale: null, warnings: [] });
  });
});

describe("(d) undigested done tasks warning", () => {
  it("statusSummary reports the oldest undigested done date; digested ones are left out", () => {
    writeProject("vlad", card("vlad"));
    const old = doneTask("vlad", ago(3 * 86400_000));
    const newer = doneTask("vlad", ago(3600_000));
    const s = statusSummary(defaultConfig(), now(), undefined, "linux", { mark: false });
    expect(s.undigested).toBe(2);
    expect(s.oldestUndigested).toBe(getTask(old.data.id).data.updated.slice(0, 10));
    markDigested([old.data.id]);
    const s2 = statusSummary(defaultConfig(), now(), undefined, "linux", { mark: false });
    expect(s2.undigested).toBe(1);
    expect(s2.oldestUndigested).toBe(getTask(newer.data.id).data.updated.slice(0, 10));
  });
  it("oldestUndigested is absent when nothing is waiting", () => {
    expect(statusSummary(defaultConfig(), now(), undefined, "linux", { mark: false })).not.toHaveProperty("oldestUndigested");
  });
  it("undigestedNote words the opening warning", () => {
    expect(undigestedNote(2, "2026-11-08")).toBe("2 done görev digest edilmedi (en eski: 2026-11-08)");
    expect(undigestedNote(0, null)).toBe("");
  });
});
