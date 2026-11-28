import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryGateError, memoryGate, readMemory, readMemoryState } from "../../src/memwatch/gate.js";
import { exitCodeFor } from "../../src/machines/exit.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "vlad-memwatch-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const NOW_S = Math.floor(Date.now() / 1000);
const GIB = 1024 ** 3;
/** memwatch daemon'un yazdığı biçim (native/memwatch/src/state.rs StateFile). */
function stateFile(level: "ok" | "warn" | "critical", o: { updated?: number; free?: number; reasons?: string[] } = {}): string {
  const p = join(dir, "memwatch.json");
  const updated = o.updated ?? NOW_S;
  writeFileSync(p, JSON.stringify({
    v: 1, updated, pid: 1, interval_secs: 10, rss_bytes: 2_000_000,
    last: {
      ts: updated, level, reasons: o.reasons ?? (level === "ok" ? [] : ["boş %8 < %10"]),
      system: { total_bytes: 16 * GIB, free_pct: o.free ?? 8, pressure: "normal", swap_total_bytes: 2 * GIB, swap_used_bytes: GIB },
      vlad_bytes: 3 * GIB, groups: [],
    },
    history: [], alerts: {},
  }));
  return p;
}
const now = () => NOW_S * 1000;

describe("readMemoryState", () => {
  it("reads a fresh daemon state file", () => {
    const s = readMemoryState(stateFile("critical"), now());
    expect(s?.last.level).toBe("critical");
  });
  it("treats a stale file (older than 60 s) as absent", () => {
    expect(readMemoryState(stateFile("critical", { updated: NOW_S - 61 }), now())).toBeNull();
    expect(readMemoryState(stateFile("critical", { updated: NOW_S - 60 }), now())).not.toBeNull();
  });
  it("treats a far-future timestamp, a missing, corrupt or foreign-shape file as absent", () => {
    expect(readMemoryState(stateFile("critical", { updated: NOW_S + 120 }), now())).toBeNull();
    expect(readMemoryState(join(dir, "yok.json"), now())).toBeNull();
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{bozuk");
    expect(readMemoryState(bad, now())).toBeNull();
    writeFileSync(bad, JSON.stringify({ v: 2, updated: NOW_S, last: { level: "critical" } }));
    expect(readMemoryState(bad, now())).toBeNull();
    writeFileSync(bad, JSON.stringify({ v: 1, updated: NOW_S, last: { level: "boom", reasons: [], system: {} } }));
    expect(readMemoryState(bad, now())).toBeNull();
  });
});

describe("readMemory", () => {
  it("prefers a fresh state file over running the binary", () => {
    let ran = 0;
    const r = readMemory({ statePath: stateFile("warn", { free: 15, reasons: ["boş %15 < %20"] }), now, binary: "/x/memwatch", run: () => { ran++; return { status: 0, stdout: "" }; } });
    expect(ran).toBe(0);
    expect(r).toMatchObject({ level: "warn", source: "state", reasons: ["boş %15 < %20"] });
    expect(r.summary).toContain("boş %15");
  });
  it("falls back to `memwatch check --json` when the state file is stale", () => {
    const calls: string[][] = [];
    const snap = JSON.parse(JSON.stringify({ ts: NOW_S, level: "critical", reasons: ["sistem baskısı critical"], system: { total_bytes: 16 * GIB, free_pct: 30, pressure: "critical", swap_total_bytes: 0, swap_used_bytes: 0 }, vlad_bytes: 0, groups: [] }));
    const r = readMemory({ statePath: stateFile("ok", { updated: NOW_S - 600 }), now, binary: "/x/memwatch", run: (b, a) => { calls.push([b, ...a]); return { status: 0, stdout: JSON.stringify(snap) }; } });
    expect(calls).toEqual([["/x/memwatch", "check", "--json"]]);
    expect(r).toMatchObject({ level: "critical", source: "check" });
  });
  it("is unknown (never blocks) when neither source works", () => {
    expect(readMemory({ statePath: join(dir, "yok.json"), now, binary: null }).level).toBe("unknown");
    expect(readMemory({ statePath: join(dir, "yok.json"), now, binary: "/x", run: () => ({ status: 1, stdout: "" }) }).level).toBe("unknown");
    expect(readMemory({ statePath: join(dir, "yok.json"), now, binary: "/x", run: () => ({ status: 0, stdout: "çöp" }) }).level).toBe("unknown");
    expect(readMemory({ statePath: join(dir, "yok.json"), now, binary: "/x", run: () => { throw new Error("ENOENT"); } }).level).toBe("unknown");
  });
});

describe("memoryGate", () => {
  const warns = (): { lines: string[]; warn: (l: string) => void } => { const lines: string[] = []; return { lines, warn: (l) => lines.push(l) }; };

  it("rejects critical with a 'bellek:' message and exit code 75", () => {
    const w = warns();
    const r = readMemory({ statePath: stateFile("critical"), now, binary: null });
    let err: unknown;
    try { memoryGate(r, { force: false, warn: w.warn }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MemoryGateError);
    expect((err as Error).message).toMatch(/^bellek: /);
    expect((err as Error).message).toContain("boş %8 < %10");
    expect((err as Error).message).toContain("--force");
    expect(exitCodeFor(err)).toBe(75);
  });
  it("lets critical through with --force but still warns", () => {
    const w = warns();
    memoryGate(readMemory({ statePath: stateFile("critical"), now, binary: null }), { force: true, warn: w.warn });
    expect(w.lines.join("\n")).toMatch(/bellek: .*--force/);
  });
  it("warns on warn and stays silent on ok/unknown", () => {
    const w = warns();
    memoryGate(readMemory({ statePath: stateFile("warn", { free: 15, reasons: ["boş %15 < %20"] }), now, binary: null }), { force: false, warn: w.warn });
    expect(w.lines).toHaveLength(1);
    expect(w.lines[0]).toMatch(/^bellek: uyarı/);
    memoryGate(readMemory({ statePath: stateFile("ok", { free: 60 }), now, binary: null }), { force: false, warn: w.warn });
    memoryGate({ level: "unknown", source: "none", reasons: [], summary: "" }, { force: false, warn: w.warn });
    expect(w.lines).toHaveLength(1);
  });
});
