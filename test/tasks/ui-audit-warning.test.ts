import { Writable } from "node:stream";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { buildProgram } from "../../src/cli/program.js";
import type { CliCtx } from "../../src/cli/program.js";
import { createTask, getTask, setState, uiAuditWarning } from "../../src/tasks/index.js";

beforeEach(() => {
  const home = makeHome();
  mkdirSync(join(home, "roles"), { recursive: true });
  writeFileSync(join(home, "roles", "developer.md"), "---\nslug: developer\ntitle: T\nkind: executor\nsummary: s\n---\n");
});

const WITH_AUDIT = "### Test sonuçları\n- impeccable audit: 2 bulgu (0/0/1/1), 2/0\n";
const NO_AUDIT = "### Test sonuçları\n- gate yeşil\n";
const UI_BODY = "## Tanım\nEkranı düzelt. UI öz-kontrol zorunlu.\n";

describe("uiAuditWarning (T20261122-55)", () => {
  it("warns when a developer task asks for UI self-check and the report has no 'impeccable audit:' line", () => {
    expect(uiAuditWarning({ role: "developer", body: UI_BODY }, NO_AUDIT)).toMatch(/impeccable audit:/);
    expect(uiAuditWarning({ role: "game-developer", body: UI_BODY }, NO_AUDIT)).toMatch(/impeccable audit:/);
  });
  it("is silent when the line is present, the role is not a developer role, or the task does not ask for UI self-check", () => {
    expect(uiAuditWarning({ role: "developer", body: UI_BODY }, WITH_AUDIT)).toBeNull();
    expect(uiAuditWarning({ role: "tester", body: UI_BODY }, NO_AUDIT)).toBeNull();
    expect(uiAuditWarning({ role: "developer", body: "## Tanım\nBackend işi\n" }, NO_AUDIT)).toBeNull();
    expect(uiAuditWarning({ role: null, body: UI_BODY }, NO_AUDIT)).toBeNull();
  });
  it("ignores UI mentions in İlerleme/Sorular/rapor sections, but sees the preamble before the first heading", () => {
    const body = "## Tanım\nBackend\n\n## İlerleme\n- x UI öz-kontrol yapıldı\n\n## Önceki raporlar\nimpeccable audit çalıştır\n";
    expect(uiAuditWarning({ role: "developer", body }, NO_AUDIT)).toBeNull();
    expect(uiAuditWarning({ role: "developer", body: "UI öz-kontrol zorunlu.\n\n## Tanım\nx\n" }, NO_AUDIT)).not.toBeNull();
  });
  it("also triggers when the task body mentions impeccable audit; the line must start the item, a bare mention does not satisfy it", () => {
    expect(uiAuditWarning({ role: "developer", body: "## Tanım\nimpeccable audit çalıştır\n" }, NO_AUDIT)).not.toBeNull();
    expect(uiAuditWarning({ role: "developer", body: UI_BODY }, "### Açık noktalar\nimpeccable audit yapılmadı\n")).not.toBeNull();
  });
});

describe("task report CLI: UI audit warning", () => {
  const run = async (body: string, role: string | undefined, md: string, json: boolean) => {
    const t = createTask({ project: "p", title: "t", kind: "dev", role, body }, new Date(2026, 9, 15));
    setState(t.data.id, "running");
    const f = join(mkdtempSync(join(tmpdir(), "vlad-uiw-")), "r.md");
    writeFileSync(f, md);
    const chunks = { out: "", err: "" };
    const w = (k: "out" | "err") => new Writable({ write(c, _e, cb) { chunks[k] += String(c); cb(); } });
    const argv = ["node", "vlad", "task", "report", t.data.id, "--file", f, ...(json ? ["--json"] : [])];
    const ctx: CliCtx = { cliPath: "/x/dist/cli.js", argv, stdout: w("out"), stderr: w("err"), exit: (c) => { throw new Error(`exit ${c}`); }, env: {} };
    await buildProgram(ctx).parseAsync(argv);
    return { ...chunks, id: t.data.id };
  };
  it("still writes the report and warns (text mode)", async () => {
    const r = await run(UI_BODY, "developer", NO_AUDIT, false);
    expect(getTask(r.id).data.state).toBe("awaiting_approval");
    expect(r.out + r.err).toContain("uyarı: UI raporunda");
  });
  it("puts the warning into --json warnings", async () => {
    const r = await run(UI_BODY, "developer", NO_AUDIT, true);
    expect(JSON.parse(r.out).warnings.join("\n")).toMatch(/impeccable audit:/);
  });
  it("no warning when the audit line is there", async () => {
    const r = await run(UI_BODY, "developer", WITH_AUDIT, true);
    expect(JSON.parse(r.out).warnings).toEqual([]);
  });
});
