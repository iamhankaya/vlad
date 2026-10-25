import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_DIR, readJson } from "../helpers/contract.ts";

const EXT = join(CONTRACT_DIR, "fixtures", "external");
const manifest = readJson("fixtures", "external", "MANIFEST.json");

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const onDisk = walk(EXT).map((p) => relative(EXT, p).split("\\").join("/")).filter((f) => f !== "MANIFEST.json").sort();

/** `_fixture_header` is the first JSONL line, or a top-level key of a JSON file. */
function header(file: string): Record<string, unknown> | undefined {
  const text = readFileSync(join(EXT, file), "utf8");
  const first = file.endsWith(".jsonl") ? text.split("\n", 1)[0]! : text;
  return JSON.parse(first)._fixture_header;
}

describe("server: external manifest complete", () => {
  it("every file on disk is in MANIFEST and every entry exists exactly once", () => {
    const listed = manifest.files.map((f: { file: string }) => f.file);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(onDisk);
  });

  it.each(manifest.files as Record<string, any>[])("entry $file has kind, source, captured_at, command and a filled header", (e) => {
    expect(["real", "synthetic"]).toContain(e.kind);
    for (const k of ["source", "captured_at", "command"]) expect(typeof e[k] === "string" && e[k]!.length > 0, `${e.file}: ${k}`).toBe(true);
    expect(e.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const h = header(e.file!);
    expect(h, `${e.file}: _fixture_header`).toBeDefined();
    for (const k of ["source", "captured_at", "command"]) expect(typeof h![k] === "string" && (h![k] as string).length > 0, `${e.file}: header.${k}`).toBe(true);
  });

  it("every item not captured states a reason", () => {
    expect(manifest.not_captured.length).toBeGreaterThan(0);
    for (const n of manifest.not_captured) {
      expect(n.item).toEqual(expect.any(String));
      expect(typeof n.reason === "string" && n.reason.length >= 10, n.item).toBe(true);
    }
  });

  it("no secrets in any fixture (contract/fixtures and signing-vectors)", () => {
    const secret = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_|-----BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-ant-|AIza[0-9A-Za-z_-]{30,}|Bearer [A-Za-z0-9._-]{20,}/;
    const files = [...walk(join(CONTRACT_DIR, "fixtures")), join(CONTRACT_DIR, "signing-vectors.json")];
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(secret);
  });
});
