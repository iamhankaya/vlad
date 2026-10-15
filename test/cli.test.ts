import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeHome } from "./helpers.js";

const root = resolve(import.meta.dirname, "..");
const cli = join(root, "dist", "cli.js");
let home: string;

beforeAll(() => {
  const r = spawnSync("npx", ["tsc"], { cwd: root, shell: true, encoding: "utf8" });
  expect(r.status, r.stdout + r.stderr).toBe(0);
}, 120000);
beforeEach(() => { home = makeHome(); });

function vlad(args: string[], input?: string) {
  const r = spawnSync("node", [cli, ...args], {
    encoding: "utf8", input, env: { ...process.env, VLAD_HOME: home },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const mkTask = () => {
  const body = join(home, "body.md");
  writeFileSync(body, "## Tanım\nx\n");
  return JSON.parse(vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", body, "--json"]).out).id as string;
};

describe("vlad cli", () => {
  it("has a shebang", () => {
    expect(readFileSync(cli, "utf8").startsWith("#!/usr/bin/env node")).toBe(true);
  });
  it("task new --json returns the id", () => {
    const r = vlad(["task", "new", "--project", "alpha", "--title", "T", "--kind", "dev", "--body-file", "-", "--json"], "## Tanım\nx\n");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).id).toMatch(/^T\d{8}-01$/);
  });
  it("invalid transition exits 1 with JSON error on stderr", () => {
    const id = mkTask();
    const r = vlad(["task", "set", id, "done", "--json"]);
    expect(r.code).toBe(1);
    const e = JSON.parse(r.err);
    expect(e.error).toMatch(/geçersiz geçiş/);
    expect(Array.isArray(e.details)).toBe(true);
  });
  it("status --summary prints the one-line summary", () => {
    mkTask();
    const r = vlad(["status", "--summary"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("İşlenmemiş 0 rapor, 0 aktif görev (0 onay bekliyor, 0 takıldı, 0 soru soruyor)");
  });
  it("inbox count --json", () => {
    const r = vlad(["inbox", "count", "--json"]);
    expect(JSON.parse(r.out)).toEqual({ count: 0 });
  });
  it("task ask/answer/log round trip and list", () => {
    const id = mkTask();
    expect(vlad(["task", "set", id, "cancelled", "--json"]).code).toBe(0);
    const l = JSON.parse(vlad(["task", "list", "--state", "cancelled", "--json"]).out);
    expect(l.tasks.map((t: { id: string }) => t.id)).toEqual([id]);
  });
  it("session register/name round trip and missing file", () => {
    const miss = vlad(["session", "name", "--json"]);
    expect(miss.code).toBe(1);
    expect(JSON.parse(miss.err).error).toBeTruthy();
    expect(vlad(["session", "register", "  vlad-main  ", "--json"]).code).toBe(0);
    expect(JSON.parse(vlad(["session", "name", "--json"]).out)).toEqual({ name: "vlad-main" });
    expect(vlad(["session", "name"]).out.trim()).toBe("vlad-main");
    expect(existsSync(join(home, "kb", "vlad-session.txt"))).toBe(true);
  });
  it("project write rejects a bad slug", () => {
    const f = join(home, "c.md");
    writeFileSync(f, "---\nslug: x\n---\n");
    const r = vlad(["project", "write", "Bad/Slug", "--file", f, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/slug/);
  });
  it("decision add and journal append", () => {
    expect(vlad(["decision", "add", "--project", "p", "--title", "t", "--body-file", "-", "--json"], "- **Karar:** x").code).toBe(0);
    expect(readFileSync(join(home, "kb", "decisions.md"), "utf8")).toContain(" — p — t");
    expect(vlad(["journal", "append", "2026-10-15", "--file", "-", "--json"], "- a").code).toBe(0);
    expect(existsSync(join(home, "kb", "journal", "2026-10-15.md"))).toBe(true);
  });
  it("task launch on unknown task exits 1", () => {
    const r = vlad(["task", "launch", "T20260101-01", "--dry-run", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/bulunamadı/);
  });
});

