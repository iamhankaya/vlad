import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { countInbox, listInbox, listInboxWithWarnings, markDone } from "../../src/inbox/inbox.js";
import { makeHome } from "../helpers.js";

let home: string;
beforeEach(() => { home = makeHome(); });

const rec = (id: string) => ({
  session_id: id, cwd: "C:\\x", project: null, task_id: null, transcript_path: null, reason: "exit",
  ended: "2026-10-15T21:10:00+03:00", git: null, excerpt: [], user_message_count: 2,
});

describe("inbox", () => {
  it("lists, counts and marks done", () => {
    const a = "20261015T100000-a.json", b = "20261015T110000-b.json";
    writeFileSync(join(home, "kb", "inbox", a), JSON.stringify(rec("a")));
    writeFileSync(join(home, "kb", "inbox", b), JSON.stringify(rec("b")));
    writeFileSync(join(home, "kb", "inbox", "20261015T120000-bad.json"), "{bozuk");
    expect(countInbox()).toBe(2);
    expect(listInbox().map((x) => x.file)).toEqual([a, b]);
    markDone([a]);
    expect(countInbox()).toBe(1);
    expect(existsSync(join(home, "kb", "inbox", "processed", a))).toBe(true);
  });
  it("listInboxWithWarnings reports broken files", () => {
    writeFileSync(join(home, "kb", "inbox", "20261015T100000-a.json"), JSON.stringify(rec("a")));
    writeFileSync(join(home, "kb", "inbox", "20261015T120000-bad.json"), "{bozuk");
    const r = listInboxWithWarnings();
    expect(r.items.map((x) => x.file)).toEqual(["20261015T100000-a.json"]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("20261015T120000-bad.json");
  });
  it("markDone throws for missing file", () => {
    expect(() => markDone(["nope.json"])).toThrow();
  });
});
