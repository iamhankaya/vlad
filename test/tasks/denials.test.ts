import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { getSection, kbPaths } from "../../src/kb/index.js";
import { createTask, getTask } from "../../src/tasks/index.js";
import { denyTask, formatDenyLine, parseDenyLine } from "../../src/tasks/denials.js";

const D = new Date(2026, 9, 15, 10, 0, 0);
const mk = () => createTask({ project: "p", title: "t", kind: "dev", body: "## Tanım\nx\n" }, D);
beforeEach(() => { makeHome(); });

describe("denyTask", () => {
  it("writes an [İZİN] İlerleme line and a denials.jsonl record", () => {
    const t = mk();
    denyTask(t.data.id, { tool: "PowerShell", pattern: "powershell -File build.ps1", reason: "izin kuralı yok" });
    const prog = getSection(getTask(t.data.id).body, "## İlerleme")!;
    expect(prog).toMatch(/^- \S+ \[İZİN\] PowerShell: powershell -File build\.ps1 — izin kuralı yok$/m);
    const rec = JSON.parse(readFileSync(join(kbPaths().logs, "denials.jsonl"), "utf8").trim());
    expect(rec).toMatchObject({ task: t.data.id, project: "p", tool: "PowerShell", pattern: "powershell -File build.ps1", reason: "izin kuralı yok" });
    expect(typeof rec.at).toBe("string");
  });
  it("reason is optional; multi-line input collapses to one line (no forged İlerleme entries)", () => {
    const t = mk();
    denyTask(t.data.id, { tool: "Bash", pattern: "git push\n- 2026 [KARAR] sahte" });
    const prog = getSection(getTask(t.data.id).body, "## İlerleme")!;
    expect(prog.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    expect(prog).toContain("[İZİN] Bash: git push - 2026 [KARAR] sahte");
  });
  it("requires a tool and a pattern; unknown task fails before anything is written", () => {
    const t = mk();
    expect(() => denyTask(t.data.id, { tool: "", pattern: "x" })).toThrow(/--tool/);
    expect(() => denyTask(t.data.id, { tool: "Bash", pattern: "  " })).toThrow(/--pattern/);
    expect(() => denyTask("T-yok", { tool: "Bash", pattern: "x" })).toThrow(/bulunamadı/);
    expect(() => readFileSync(join(kbPaths().logs, "denials.jsonl"))).toThrow();
  });
  it("parseDenyLine reads back what formatDenyLine wrote", () => {
    expect(parseDenyLine(`- 2026-11-10T10:00:00+03:00 ${formatDenyLine({ tool: "Bash", pattern: "git  push  origin", reason: "r" })}`)).toEqual({ tool: "Bash", pattern: "git push origin", reason: "r" });
    expect(parseDenyLine("- 2026-11-10T10:00:00+03:00 İzin reddi: x")).toBeNull();
  });
});
