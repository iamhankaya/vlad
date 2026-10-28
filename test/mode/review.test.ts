import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scanTranscript } from "../../src/audit/skills.js";
import { kbPaths } from "../../src/kb/index.js";
import { modeLine, modeStatus, setNight, setWatch } from "../../src/mode/store.js";
import { makeHome } from "../helpers.js";

const now = new Date("2026-10-28T23:30:00+03:00");
beforeEach(() => { makeHome(); });

const bash = (c: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: c } }] } });

describe("review fixes", () => {
  it("modeLine shows the end date, so a window that rolled into tomorrow is visible", () => {
    setNight({ until: "08:00" }, now);
    expect(modeLine(now)).toMatch(/10-29 08:00/);
  });

  it("a night entry without projects (hand-edited file) does not crash", () => {
    writeFileSync(join(kbPaths().kb, "mode.json"), JSON.stringify({ night: { until: "2099-01-01T00:00:00+03:00" } }));
    expect(modeStatus(now).night?.projects).toEqual([]);
    expect(modeLine(now)).toMatch(/gece modu etkin/);
  });

  it("watch off drops an elapsed night so it is not announced twice", () => {
    setNight({ until: "23:45" }, now);
    setWatch(false, new Date(now.getTime() + 20 * 60_000));
    expect(modeStatus(now).expired).toBe(false);
  });

  it("git push detection: real pushes only", () => {
    const pushed = (c: string) => scanTranscript(bash(c)).pushed;
    expect(pushed("git push -u origin vlad/T1")).toBe(true);
    expect(pushed("git -C wt push origin vlad/T1")).toBe(true);
    expect(pushed("git add . && git push -u origin vlad/T1")).toBe(true);
    expect(pushed('git commit -m "fix push retry"')).toBe(false);
    expect(pushed("git log --grep push")).toBe(false);
    expect(pushed("git stash push")).toBe(false);
    expect(pushed("git status && echo push")).toBe(false);
  });
});
