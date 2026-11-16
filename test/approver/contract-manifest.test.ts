import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { COMMANDS } from "../../src/commands/manifest.js";
import { COMMAND_DOCS } from "../../src/commands/docs-data.js";
import { buildProgram } from "../../src/cli/program.js";

const spec = (p: string) => COMMANDS.find((s) => s.path.join(" ") === p)!;

describe("approver sözleşmesi: manifest satırları (plandaki politika)", () => {
  it("mode request: lock none, işçide reddedilir, json, konsolda yok", () => {
    const s = spec("mode request");
    expect(s).toMatchObject({ lock: "none", worker: { kind: "reject" }, json: true });
    expect(s.console.kind).toBe("none");
  });
  it("approver install|uninstall|rotate|unlock|run: konsolda yok, işçide reddedilir (def() her komuta --json ekler: json true)", () => {
    for (const n of ["install", "uninstall", "rotate", "unlock", "run"]) {
      const s = spec(`approver ${n}`);
      expect(s.console.kind, n).toBe("none");
      expect(s.json, n).toBe(true);
      expect(s.worker.kind, n).toBe("reject");
    }
  });
  it("approver status|requests|show: konsol read, işçide reddedilir, json", () => {
    for (const n of ["status", "requests", "show"]) expect(spec(`approver ${n}`), n).toMatchObject({ console: { kind: "read" }, worker: { kind: "reject" }, json: true });
  });
  it("her yeni komutun açıklaması docs-data'da", () => {
    for (const k of ["mode request", "approver install", "approver uninstall", "approver rotate", "approver unlock", "approver run", "approver status", "approver requests", "approver show"]) expect(COMMAND_DOCS[k], k).toBeTruthy();
  });
});

describe("approver sözleşmesi: CLI iskeleti (komutlar kayıtlı, --help yazılı)", () => {
  const find = (c: Command, ...p: string[]): Command | undefined => p.reduce<Command | undefined>((a, n) => a?.commands.find((x) => x.name() === n), c);
  const prog = () => buildProgram({ stdout: { write: () => true }, stderr: { write: () => true }, env: {}, cliPath: "cli.js" } as never);
  it("approver alt komutları ve mode request kayıtlı; run 'launchd girişi' der", () => {
    const p = prog();
    for (const n of ["install", "uninstall", "rotate", "unlock", "status", "requests", "show", "run"]) expect(find(p, "approver", n), n).toBeTruthy();
    expect(find(p, "mode", "request")).toBeTruthy();
    expect(find(p, "approver", "run")!.description()).toContain("launchd girişi");
    expect(find(p, "approver", "install")!.options.some((o) => o.long === "--server")).toBe(true);
    const req = find(p, "mode", "request")!;
    expect(req.options.some((o) => o.long === "--wait" && !o.required && !o.optional)).toBe(true); // değer almaz: işlem adını yutmaz
    expect(req.options.some((o) => o.long === "--wait-seconds")).toBe(true);
  });
});
