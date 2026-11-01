import { describe, expect, it } from "vitest";
import { consoleExecTimeoutMs, validateConsoleArgv } from "../../src/agent/console-catalog.js";

// Son kapı P2-4: konsoldan `task gate|merge-preview|merge` çalışmalı; uzun gate 110 sn exec sınırına takılmamalı.
describe("konsol kataloğu — kapı komutları", () => {
  it("task gate / merge-preview / merge katalogda; sınıfları: gate+merge yazma (günlüğe girer), merge-preview okuma", () => {
    expect(validateConsoleArgv(["task", "gate", "T1", "--target", "task"]).entry).toMatchObject({ path: ["task", "gate"], kind: "write" });
    expect(validateConsoleArgv(["task", "merge-preview", "T1", "--into", "main"]).entry).toMatchObject({ kind: "read" });
    expect(validateConsoleArgv(["task", "merge", "T1", "--message", "m"]).entry).toMatchObject({ kind: "write" });
  });
  it("exec zaman aşımı: gate işçinin gate sınırından (25 dk) ve uzak çağrıdan (30 dk) uzun; merge 330 sn çağrıdan uzun; diğerleri 110 sn", () => {
    expect(consoleExecTimeoutMs(["task", "gate", "T1"])).toBeGreaterThan(30 * 60_000);
    expect(consoleExecTimeoutMs(["task", "merge", "T1"])).toBeGreaterThan(330_000);
    expect(consoleExecTimeoutMs(["task", "list"])).toBe(110_000);
  });
});
