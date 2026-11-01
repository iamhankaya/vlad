import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rmTemp } from "../helpers.js";
import { makeHomePair, spawnVlad, type HomePair } from "./harness.js";

// Son kapı Codex 2. tur P1: işçi makinenin kb klonu salt okunur; hiçbir yerel yol (status işaretleme dahil) ona yazmamalı.
const CARD = `---
slug: alpha
name: Alpha
path: ${JSON.stringify(process.cwd())}
stack: [ts]
status: active
autonomy: commit
last_activity: null
last_scanned: null
---

## Özet
x
`;
const config = { machines: [{ name: "mac", os: "darwin", agent: { host: "127.0.0.1", port: 41001 } }, { name: "windows", os: "win32", agent: { host: "127.0.0.1", port: 41002 } }], brain: "mac" };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

/** Dosya yolu → "boyut:içerik" haritası; kb ağacındaki her değişiklik farkta görünür. */
function snapshot(dir: string, out: Record<string, string> = {}, base = dir): Record<string, string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) snapshot(p, out, base);
    else out[p.slice(base.length)] = readFileSync(p, "utf8");
  }
  return out;
}

function setup(): { p: HomePair; id: string } {
  const p = makeHomePair({ config });
  cleanups.push(() => rmTemp(dirname(p.brain.home)), () => p.cleanup());
  writeFileSync(join(p.brain.home, "card.md"), CARD);
  expect(spawnVlad(p.brain, ["project", "write", "alpha", "--file", join(p.brain.home, "card.md")]).code).toBe(0);
  const made = spawnVlad(p.brain, ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], { stdin: "## Tanım\nx\n" });
  expect(made.code, made.err).toBe(0);
  const id = JSON.parse(made.out).id as string;
  // beyin kb'sini işçiye kb-sync gibi kopyala; görev uzun süredir sessiz bir running (status bunu stalled işaretlerdi)
  const taskFile = join(p.brain.kb, "tasks", `${id}.md`);
  writeFileSync(taskFile, readFileSync(taskFile, "utf8").replace(/^state: queued$/m, "state: running").replace(/^updated: .*$/m, "updated: 2020-01-01T00:00:00+00:00"));
  for (const d of ["projects", "tasks"]) { mkdirSync(join(p.worker.kb, d), { recursive: true }); cpSync(join(p.brain.kb, d), join(p.worker.kb, d), { recursive: true }); }
  // süresi dolmuş bir mod penceresi: düz `mode status`/`status` bunu temizlerdi
  writeFileSync(join(p.worker.kb, "mode.json"), JSON.stringify({ night: { until: "2020-01-01T00:00:00+00:00" } }));
  return { p, id };
}

describe("işçi makinede kb'ye yazan yerel yol yok", () => {
  for (const args of [["status"], ["status", "--json"], ["status", "--summary"], ["status", "--hook"]]) {
    it(`vlad ${args.join(" ")} işçide kb'yi değiştirmez`, () => {
      const { p } = setup();
      const before = snapshot(p.worker.kb);
      const r = spawnVlad(p.worker, args);
      expect(r.code, r.err).toBe(0);
      expect(snapshot(p.worker.kb)).toEqual(before);
    });
  }

  const idx = "ID";
  const cases: string[][] = [
    ["project", "write", "beta", "--file", "-"], ["project", "set", "alpha", "gate", "x"], ["project", "note", "alpha", "n"], ["project", "summary", "alpha", "--file", "-"],
    ["finding", "add", "--project", "alpha", "--title", "t", "--severity", "orta"], ["finding", "set", "F-alpha-001", "fixed"],
    ["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-"], ["task", "ingest", idx, "--file", "-"], ["task", "resume", idx],
    ["task", "answer", idx, "a"], ["task", "set", idx, "stalled"], ["task", "deps", idx, "--clear"], ["task", "cleanup", idx], ["task", "digested", idx],
    ["mode", "night"], ["mode", "watch", "on"], ["mode", "off"], ["mode", "status"],
    ["inbox", "done", "x.md"], ["decision", "add", "--project", "alpha", "--title", "t", "--body", "b"], ["decision", "set", "D-alpha-001", "geçersiz"], ["decision", "migrate"],
    ["journal", "append", "2026-11-02", "--file", "-"], ["kb", "maintain"], ["session", "register", "x"],
    ["task", "launch", idx, "--external"],
  ];
  for (const argv of cases) {
    it(`vlad ${argv.slice(0, 2).join(" ")} işçide kb'yi değiştirmez`, () => {
      const { p, id } = setup();
      const before = snapshot(p.worker.kb);
      spawnVlad(p.worker, argv.map((a) => (a === idx ? id : a)), { stdin: "x" });
      expect(snapshot(p.worker.kb)).toEqual(before);
      expect(existsSync(join(p.worker.kb, "vlad-session.txt"))).toBe(false);
    });
  }
});
