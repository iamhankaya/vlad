import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { addAudit, listAudit } from "../../src/audit/store.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
beforeEach(() => {
  home = makeHome();
});

const SHA = "a".repeat(40);
const entry = (over: Record<string, unknown> = {}) => ({
  ts: "2026-10-24T10:00:00+03:00",
  action_id: "A-1",
  kind: "merge_phase",
  repo: "iamhankaya/vlad",
  pr: 46,
  head_sha: SHA,
  approver: { type: "device", id: "D-1" },
  result: "merged",
  merge_sha: "b".repeat(40),
  ...over,
});
const auditDir = () => join(home, "kb", "audit");

const vlad = (args: string[], input?: string) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe("records: audit", () => {
  it("records: audit monthly file", () => {
    addAudit(entry());
    addAudit(entry({ action_id: "A-2", ts: "2026-10-31T23:59:59+03:00" }));
    addAudit(entry({ action_id: "A-3", ts: "2026-11-01T00:00:00+03:00" }));
    expect(readdirSync(auditDir()).sort()).toEqual(["2026-10.jsonl", "2026-11.jsonl"]);
    const oct = readFileSync(join(auditDir(), "2026-10.jsonl"), "utf8").split("\n").filter(Boolean);
    expect(oct).toHaveLength(2);
    expect(JSON.parse(oct[0]!).action_id).toBe("A-1");
    expect(listAudit().entries.map((e) => e.action_id)).toEqual(["A-1", "A-2", "A-3"]);
  });

  it("records: audit rejects invalid line", () => {
    for (const bad of [
      entry({ head_sha: "xyz" }),
      entry({ approver: { type: "robot", id: "x" } }),
      entry({ repo: "no-slash" }),
      entry({ pr: 0 }),
      entry({ extra: 1 }),
      entry({ ts: "yesterday" }),
      entry({ action_id: "" }),
      entry({ kind: "format_disk" }),
      entry({ detail: "x".repeat(2001) }),
    ]) {
      expect(() => addAudit(bad)).toThrow(/doğrulama hatası/);
    }
    const { action_id: _drop, ...noId } = entry();
    expect(() => addAudit(noId)).toThrow(/doğrulama hatası/);
    expect(existsSync(auditDir()) ? readdirSync(auditDir()) : []).toEqual([]);
    // via the CLI: stderr JSON error, exit 1
    const r = vlad(["audit", "add", "--file", "-", "--json"], JSON.stringify(entry({ head_sha: "zz" })));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/doğrulama/);
  });

  it("records: audit list warns on corrupt line without crash", () => {
    addAudit(entry());
    const file = join(auditDir(), "2026-10.jsonl");
    writeFileSync(file, readFileSync(file, "utf8") + "{not json\n" + JSON.stringify({ ts: "x" }) + "\n");
    addAudit(entry({ action_id: "A-2" }));
    const { entries, warnings } = listAudit();
    expect(entries.map((e) => e.action_id)).toEqual(["A-1", "A-2"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/2026-10\.jsonl:2/);
    expect(warnings[1]).toMatch(/2026-10\.jsonl:3/);
    const r = vlad(["audit", "list", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.entries).toHaveLength(2);
    expect(j.warnings).toHaveLength(2);
    expect(vlad(["audit", "list"]).out).toMatch(/uyarı:/);
  });

  it("records: audit duplicate action_id rejected", () => {
    addAudit(entry());
    expect(() => addAudit(entry({ result: "other" }))).toThrow(/action_id zaten var: A-1/);
    // also across months
    expect(() => addAudit(entry({ ts: "2026-12-01T00:00:00+03:00" }))).toThrow(/action_id zaten var/);
    expect(listAudit().entries).toHaveLength(1);
    const r = vlad(["audit", "add", "--file", "-", "--json"], JSON.stringify(entry()));
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/zaten var/);
  });

  it("records: audit list --since filters by ts", () => {
    addAudit(entry({ action_id: "A-1", ts: "2026-10-01T00:00:00+03:00" }));
    addAudit(entry({ action_id: "A-2", ts: "2026-10-20T00:00:00+03:00" }));
    expect(listAudit({ since: "2026-10-10T00:00:00+03:00" }).entries.map((e) => e.action_id)).toEqual(["A-2"]);
    expect(() => listAudit({ since: "dün" })).toThrow(/--since/);
    expect(vlad(["audit", "list", "--since", "2026-10-10", "--json"]).code).toBe(0);
  });

  it("records: audit list on empty kb", () => {
    expect(listAudit()).toEqual({ entries: [], warnings: [] });
    mkdirSync(auditDir(), { recursive: true });
    expect(listAudit().entries).toEqual([]);
  });

  it("records: 50 concurrent audit add keep every line intact", async () => {
    const run = (n: number) => new Promise<number>((res) => {
      const p = spawn("node", [cli, "audit", "add", "--file", "-", "--json"], { env: { ...process.env, VLAD_HOME: home } });
      p.stdin.end(JSON.stringify(entry({ action_id: `A-${n}`, detail: "x".repeat(2000) })));
      p.on("exit", (c) => res(c ?? -1));
    });
    const codes = await Promise.all(Array.from({ length: 50 }, (_, i) => run(i)));
    expect(codes.every((c) => c === 0)).toBe(true);
    const { entries, warnings } = listAudit();
    expect(warnings).toEqual([]);
    expect(new Set(entries.map((e) => e.action_id)).size).toBe(50);
    expect(existsSync(join(home, "kb", ".vlad.lock"))).toBe(false);
  }, 60_000);
});
