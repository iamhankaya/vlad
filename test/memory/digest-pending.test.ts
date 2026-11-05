import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/kb/index.js";
import { addPending, countPending, donePending, listPending } from "../../src/digest/pending.js";
import { statusSummary } from "../../src/tasks/launch.js";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

let home: string;
beforeEach(() => { home = makeHome(); });

describe("digest pending (library, temp kb)", () => {
  it("adds, lists, closes; ids are sequential and closed items leave the open list", () => {
    expect(listPending()).toEqual([]);
    const a = addPending({ text: "Karar emin değil: WebSocket", task: "T1", project: "alpha" });
    const b = addPending({ text: "Kullanıcı kararı bekliyor: lisans" });
    expect([a.id, b.id]).toEqual(["DP-001", "DP-002"]);
    expect(countPending()).toBe(2);
    donePending("DP-001", "kullanıcı onayladı");
    expect(listPending().map((i) => i.id)).toEqual(["DP-002"]);
    const all = listPending(true);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ state: "done", note: "kullanıcı onayladı" });
  });
  it("rejects empty text, unknown id and double close", () => {
    expect(() => addPending({ text: "  " })).toThrow(/boş/);
    expect(() => donePending("DP-009")).toThrow(/bulunamadı/);
    addPending({ text: "x" });
    donePending("DP-001");
    expect(() => donePending("DP-001")).toThrow(/zaten kapalı/);
  });
  it("statusSummary reports the open count", () => {
    addPending({ text: "a" });
    addPending({ text: "b" });
    donePending("DP-001");
    const s = statusSummary(defaultConfig(), new Date(), undefined, "linux", { mark: false });
    expect(s.pendingDigest).toBe(1);
  });
});

describe("vlad digest pending (CLI)", { timeout: 30_000 }, () => {
  const vlad = (args: string[]) => {
    const r = spawnVlad({ args, env: { VLAD_HOME: home } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  it("add/list/done end to end and status --summary shows the count", () => {
    const add = vlad(["digest", "pending", "add", "--text", "karar emin değil", "--task", "T1", "--json"]);
    expect(add.code, add.err).toBe(0);
    expect(JSON.parse(add.out).id).toBe("DP-001");
    const sum = vlad(["status", "--summary", "--no-mark", "--json"]);
    expect(sum.code, sum.err).toBe(0);
    expect(JSON.parse(sum.out).pendingDigest).toBe(1);
    expect(JSON.parse(sum.out).summary).toContain("1 onay bekleyen digest maddesi");
    const list = JSON.parse(vlad(["digest", "pending", "list", "--json"]).out);
    expect(list.items).toHaveLength(1);
    expect(vlad(["digest", "pending", "done", "DP-001", "--note", "tamam", "--json"]).code).toBe(0);
    expect(JSON.parse(vlad(["digest", "pending", "list", "--json"]).out).items).toEqual([]);
    expect(JSON.parse(vlad(["status", "--summary", "--no-mark", "--json"]).out).summary).not.toContain("onay bekleyen digest");
    expect(vlad(["digest", "pending", "done", "DP-404", "--json"]).code).toBe(1);
  });
});
