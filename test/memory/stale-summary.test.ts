import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { setProjectSummary, staleSummaries, staleSummaryText } from "../../src/projects/status.js";
import { writeProject } from "../../src/projects/store.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { createTask } from "../../src/tasks/store.js";
import { makeHome } from "../helpers.js";

const card = (slug: string, status = "active") => `---\nslug: ${slug}\nname: ${slug}\npath: /tmp/${slug}\nstack: [ts]\nstatus: ${status}\nautonomy: commit\nlast_activity: null\nlast_scanned: null\n---\n\n## Özet\nx\n`;
const T1 = new Date(2026, 9, 30, 12, 0, 0);
const later = new Date(T1.getTime() + 3600_000);
beforeEach(() => { makeHome(); });

describe("stale summaries", () => {
  it("counts and names bayat and yok active projects; güncel ones are left out", () => {
    for (const s of ["bayat-p", "yok-p", "taze-p"]) writeProject(s, card(s));
    setProjectSummary("bayat-p", "x", T1);
    setProjectSummary("taze-p", "x", T1);
    createTask({ project: "bayat-p", title: "Yeni", kind: "dev", body: "" }, later);
    const list = staleSummaries();
    expect(list).toEqual([{ slug: "bayat-p", state: "bayat", newer: 1 }, { slug: "yok-p", state: "yok", newer: 0 }]);
    expect(staleSummaryText(list)).toBe("bayat-p (1 kayıt), yok-p (özet yok)");
  });
  it("archived (and paused) projects are not counted", () => {
    writeProject("eski", card("eski", "archived"));
    writeProject("dur", card("dur", "paused"));
    expect(staleSummaries()).toEqual([]);
  });
  it("statusSummary exposes staleSummaries (--json field)", () => {
    writeProject("vlad", card("vlad"));
    const s = statusSummary(defaultConfig(), new Date(), undefined, "linux", { mark: false });
    expect(s.staleSummaries).toEqual([{ slug: "vlad", state: "yok", newer: 0 }]);
  });
});
