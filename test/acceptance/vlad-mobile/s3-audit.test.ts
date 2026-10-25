// T1 kabul: S3b (audit) — plan §Kayıt şemaları `audit`, §S3b. kb/audit/YYYY-MM.jsonl, action_id tekil.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { fail, kbFiles, newHome, ok, sha40, tmp } from "./helpers.js";

let home: string;
beforeEach(() => { home = newHome(); });

const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const month = (iso: string) => iso.slice(0, 7);
const entry = (o: Record<string, unknown> = {}) => ({
  ts: new Date().toISOString(), action_id: `A-${Math.random().toString(36).slice(2, 10)}`, kind: "merge_phase", repo: "acme/alpha",
  pr: 42, head_sha: sha40(), approver: { type: "device", id: "dev-1" }, result: "merged", ...o,
});
const add = (e: object) => ok<any>(home, ["audit", "add", "--file", "-"], { input: JSON.stringify(e) });
const addFail = (e: object | string) => fail(home, ["audit", "add", "--file", "-"], { input: typeof e === "string" ? e : JSON.stringify(e) });
const list = (extra: string[] = []) => ok<any>(home, ["audit", "list", ...extra]);

describe("records: audit (S3b)", () => {
  it("records: audit monthly file — one jsonl per ts month, entries land by their ts", () => {
    const now = new Date().toISOString(), old = ago(45);
    expect(month(now)).not.toBe(month(old));
    add(entry({ ts: now, action_id: "A-now" }));
    add(entry({ ts: old, action_id: "A-old" }));
    expect(kbFiles(home, "audit")).toEqual([`${month(old)}.jsonl`, `${month(now)}.jsonl`].sort());
    const lines = readFileSync(join(home, "kb", "audit", `${month(now)}.jsonl`), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).action_id).toBe("A-now");
  });
  it("add accepts --file <path> as well as stdin and optional merge_sha/detail", () => {
    const f = join(tmp("vlad-aud-"), "a.json");
    writeFileSync(f, JSON.stringify(entry({ action_id: "A-file", merge_sha: sha40("b"), detail: "ayrıntı İ" })));
    ok(home, ["audit", "add", "--file", f]);
    const e = list().entries.find((x: any) => x.action_id === "A-file");
    expect(e).toMatchObject({ merge_sha: sha40("b"), detail: "ayrıntı İ", approver: { type: "device", id: "dev-1" } });
  });
  it("grant approver type is accepted", () => {
    add(entry({ action_id: "A-grant", approver: { type: "grant", id: "G-001" } }));
    expect(list().entries[0].approver).toEqual({ type: "grant", id: "G-001" });
  });
  it("records: audit rejects invalid line — each missing required field", () => {
    for (const k of ["ts", "action_id", "kind", "repo", "pr", "head_sha", "approver", "result"]) {
      const e: Record<string, unknown> = entry({ action_id: `A-miss-${k}` });
      delete e[k];
      addFail(e);
    }
    expect(list().entries).toEqual([]);
  });
  it("records: audit rejects bad types (approver.type enum, pr, ts, malformed json, non-object)", () => {
    addFail(entry({ approver: { type: "robot", id: "x" } }));
    addFail(entry({ approver: { type: "device" } }));
    addFail(entry({ pr: "kırk iki" }));
    addFail(entry({ ts: "dün" }));
    addFail("{bozuk json");
    addFail("[1,2]");
    addFail("");
    expect(list().entries).toEqual([]);
    expect(kbFiles(home, "audit")).toEqual([]);
  });
  it("records: audit duplicate action_id rejected (error names the id, first line kept)", () => {
    add(entry({ action_id: "A-dup", result: "merged" }));
    const e = addFail(entry({ action_id: "A-dup", result: "failed" }));
    expect(e.error).toContain("A-dup");
    const got = list().entries.filter((x: any) => x.action_id === "A-dup");
    expect(got).toHaveLength(1);
    expect(got[0].result).toBe("merged");
  });
  it("audit action_id is unique across months too", () => {
    add(entry({ action_id: "A-x", ts: ago(45) }));
    addFail(entry({ action_id: "A-x", ts: new Date().toISOString() }));
    expect(list().entries).toHaveLength(1);
  });
  it("records: audit list warns on corrupt line without crash", () => {
    add(entry({ action_id: "A-1" }));
    const f = join(home, "kb", "audit", kbFiles(home, "audit")[0]);
    appendFileSync(f, "{bu satır bozuk\n");
    appendFileSync(f, JSON.stringify({ ts: "x", action_id: "A-bad" }) + "\n");
    add(entry({ action_id: "A-2" }));
    const l = list();
    expect(l.entries.map((e: any) => e.action_id).sort()).toEqual(["A-1", "A-2"]);
    expect(l.warnings.length).toBeGreaterThanOrEqual(1);
  });
  it("list --since keeps only later entries (relative times)", () => {
    add(entry({ action_id: "A-old", ts: ago(10) }));
    add(entry({ action_id: "A-new", ts: ago(1) }));
    expect(list(["--since", ago(5)]).entries.map((e: any) => e.action_id)).toEqual(["A-new"]);
    expect(list(["--since", ago(20)]).entries).toHaveLength(2);
    fail(home, ["audit", "list", "--since", "geçen hafta"]);
  });
  it("list on an empty kb returns empty entries and no warnings", () => {
    expect(list()).toMatchObject({ entries: [], warnings: [] });
  });
  it("hostile action_id / detail values are stored as data (one line per entry)", () => {
    const e = entry({ action_id: "A-inj", detail: 'x"\n{"action_id":"A-forged"}' });
    add(e);
    const f = join(home, "kb", "audit", kbFiles(home, "audit")[0]);
    expect(readFileSync(f, "utf8").trim().split("\n")).toHaveLength(1);
    expect(list().entries.map((x: any) => x.action_id)).toEqual(["A-inj"]);
  });
});
