import { cpSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "../helpers.js";
import { spawnVlad } from "../support/spawn-vlad.js";

let home: string;
beforeEach(() => {
  home = makeHome();
  cpSync(resolve(import.meta.dirname, "..", "..", "roles"), join(home, "roles"), { recursive: true });
});
const vlad = (args: string[], input?: string) => {
  const r = spawnVlad({ args, input, env: { VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const base = ["task", "new", "--pipeline", "--project", "p", "--title", "T", "--body-file", "-"];
const BODY = "## Tanım\nbüyük iş\n";
const files = () => readdirSync(join(home, "kb", "tasks")).filter((f) => f.endsWith(".md"));

describe("task new --pipeline", { timeout: 30_000 }, () => {
  it("creates çatı + phases in one call and prints them as json", () => {
    const r = vlad([...base, "--cycle", "kısa", "--ui", "--json"], BODY);
    expect(r.code, r.err).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.phases.map((p: { phase: string }) => p.phase)).toEqual(["uygulama", "doğrulama", "denetim"]);
    expect(files()).toHaveLength(4);
  });
  it("--phase-body faz=dosya replaces that phase's body", () => {
    const f = join(home, "u.md");
    writeFileSync(f, "## Tanım\nÖZEL-GÖVDE\n");
    const r = vlad([...base, "--cycle", "kısa", "--phase-body", `uygulama=${f}`, "--json"], BODY);
    expect(r.code, r.err).toBe(0);
    const id = JSON.parse(r.out).phases[0].id;
    expect(vlad(["kb", "get", id, "--json"]).out).toContain("ÖZEL-GÖVDE");
  });
  it("--phase-model faz=model[:gerekçe] sets the phase model; opus needs a reason", () => {
    const r = vlad([...base, "--cycle", "kısa", "--phase-model", "uygulama=opus:kritik iş", "--phase-model", "doğrulama=haiku", "--json"], BODY);
    expect(r.code, r.err).toBe(0);
    const [u, d] = JSON.parse(r.out).phases.map((p: { id: string }) => vlad(["kb", "get", p.id, "--json"]).out);
    expect(u).toMatch(/model: opus/); expect(u).toContain("kritik iş"); expect(d).toMatch(/model: haiku/);
    const before = files().length;
    expect(vlad([...base, "--cycle", "kısa", "--phase-model", "uygulama=opus"], BODY).code).toBe(1);
    expect(vlad([...base, "--cycle", "kısa", "--phase-model", "uygulama"], BODY).code).toBe(1);
    expect(vlad(["task", "new", "--project", "p", "--title", "T", "--phase-model", "uygulama=haiku", "--body-file", "-"], BODY).code).toBe(1);
    expect(files()).toHaveLength(before);
  });
  it("errors write nothing: bad cycle, missing cycle, skip without reason, stray flags", () => {
    expect(vlad([...base, "--cycle", "tek"], BODY).code).toBe(1);
    expect(vlad(base, BODY).code).toBe(1);
    expect(vlad([...base, "--cycle", "tam", "--skip", "sözleşme"], BODY).code).toBe(1);
    expect(vlad(["task", "new", "--project", "p", "--title", "T", "--cycle", "tam", "--body-file", "-"], BODY).code).toBe(1);
    expect(files()).toEqual([]);
  });
  it("rejects ignored flags, duplicate --phase-body and double stdin", () => {
    expect(vlad([...base, "--cycle", "kısa", "--model", "opus"], BODY).code).toBe(1);
    expect(vlad([...base, "--cycle", "kısa", "--phase-body", "uygulama=-"], BODY).code).toBe(1);
    const f = join(home, "u.md");
    writeFileSync(f, "## Tanım\nx\n");
    expect(vlad([...base, "--cycle", "kısa", "--phase-body", `uygulama=${f}`, "--phase-body", `uygulama=${f}`], BODY).code).toBe(1);
    expect(files()).toEqual([]);
  });
});
