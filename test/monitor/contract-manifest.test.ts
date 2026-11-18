import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Command } from "commander";
import { COMMANDS } from "../../src/commands/manifest.js";
import { COMMAND_DOCS } from "../../src/commands/docs-data.js";
import { buildProgram } from "../../src/cli/program.js";

const spec = (p: string) => COMMANDS.find((s) => s.path.join(" ") === p)!;
const root = join(import.meta.dirname, "..", "..");

describe("monitor sözleşmesi: manifest satırları (plandaki politika)", () => {
  it("pull: lock outer, işçide reddedilir, konsol write, json", () => {
    expect(spec("monitor pull")).toMatchObject({ lock: "outer", worker: { kind: "reject" }, console: { kind: "write" }, json: true, refresh: false });
  });
  it("status: işçide yerel, konsol read", () => {
    expect(spec("monitor status")).toMatchObject({ worker: { kind: "local" }, console: { kind: "read" }, lock: "none" });
  });
  it("install|uninstall: konsolda yok (gerekçeli), işçide reddedilir", () => {
    for (const n of ["install", "uninstall"]) {
      const s = spec(`monitor ${n}`);
      expect(s.console.kind, n).toBe("none");
      expect(s.worker.kind, n).toBe("reject");
    }
  });
  it("her komutun açıklaması docs-data'da", () => {
    for (const k of ["monitor pull", "monitor status", "monitor install", "monitor uninstall"]) expect(COMMAND_DOCS[k], k).toBeTruthy();
  });
  it("docs/commands.md bu komutları içerir (npm run docs:commands)", () => {
    const md = readFileSync(join(root, "docs", "commands.md"), "utf8");
    for (const k of ["monitor pull", "monitor status", "monitor install", "monitor uninstall"]) expect(md, k).toContain(k);
  });
});

describe("monitor sözleşmesi: CLI iskeleti", () => {
  const find = (c: Command, ...p: string[]): Command | undefined => p.reduce<Command | undefined>((a, n) => a?.commands.find((x) => x.name() === n), c);
  const prog = () => buildProgram({ stdout: { write: () => true }, stderr: { write: () => true }, env: {}, cliPath: "cli.js" } as never);
  it("alt komutlar kayıtlı; pull --server ve --dry-run, her komut --json", () => {
    const p = prog();
    for (const n of ["pull", "status", "install", "uninstall"]) {
      const c = find(p, "monitor", n);
      expect(c, n).toBeTruthy();
      expect(c!.options.some((o) => o.long === "--json"), `${n} --json`).toBe(true);
    }
    const pl = find(p, "monitor", "pull")!;
    expect(pl.options.some((o) => o.long === "--server")).toBe(true);
    expect(pl.options.some((o) => o.long === "--dry-run")).toBe(true);
  });
});

describe("monitor sözleşmesi: yapılandırma şeması", () => {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "config.schema.json"), "utf8"));
  it("config şemasında monitor.servers[{id,agent_url,project}], sır alanı yok, ek alan yasak", () => {
    const item = schema.properties.monitor.properties.servers.items;
    expect(item.required).toEqual(["id", "agent_url", "project"]);
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties)).toEqual(["id", "agent_url", "project"]);
  });
});
