import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, listVault, readVault, searchVault } from "../../src/vault/search.js";
import { makeHome } from "../helpers.js";

// S5x: docs zone root. Separate kb -> `<kb>/docs`; fallback / legacy -> `<home>/vault/docs`. The virtual path stays vault/docs/…
const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
let kb: string;
let outside: string;
const put = (root: string, rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const vlad = (args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home, VLAD_KB_DIR: kb } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const search = (q: string, o: Parameters<typeof searchVault>[1] = {}) => searchVault(q, o).hits.map((h) => h.path);
const ls = (d?: string) => listVault(d).entries.map((e) => e.path);

beforeEach(() => {
  home = makeHome();
  kb = mkdtempSync(join(tmpdir(), "vlad-kb-"));
  outside = mkdtempSync(join(tmpdir(), "vlad-out-"));
  process.env.VLAD_KB_DIR = kb;
  for (const d of ["projects", "inbox", "logs", "grants", "audit"]) mkdirSync(join(kb, d), { recursive: true });
  put(kb, "projects/vlad.md", "# VLAD\nkart-metni\n");
  put(kb, "inbox/secret.md", "gizli-inbox\n");
  put(kb, "audit/2026-10.md", "gizli-audit\n");
  put(kb, "docs/plan.md", "# Plan\nyeni-kok yeni-kok\n");
  put(kb, "docs/alt/rehber.md", "# Rehber\n## Kurulum\nyeni-kok adımları\n");
  put(home, "vault/docs/eski.md", "# Eski\neski-kok\n");
  put(outside, "far.md", "dis-gizli\n");
});
afterEach(() => {
  delete process.env.VLAD_KB_DIR;
});

describe("records: vault docs root in a separate kb (S5x)", () => {
  it("records: vault docs read, ls and search resolve <kb>/docs under the virtual vault/docs path", () => {
    expect(readVault("vault/docs/plan.md").path).toBe("vault/docs/plan.md");
    expect(readVault("vault/docs/alt/rehber.md", "kurulum").content).toContain("adımları");
    expect(ls()).toEqual(["kb", "vault/docs"]);
    expect(ls("vault/docs")).toEqual(["vault/docs/alt", "vault/docs/plan.md"]);
    expect(search("yeni-kok", { zone: "docs" })).toEqual(["vault/docs/plan.md", "vault/docs/alt/rehber.md"]);
  });

  it("records: vault docs folder is not part of the kb zone (no double results)", () => {
    expect(ls("kb")).not.toContain("kb/docs");
    expect(search("yeni-kok")).toEqual(["vault/docs/plan.md", "vault/docs/alt/rehber.md"]);
    for (const p of ["kb/docs/plan.md", "KB/DOCS/plan.md", "kb/Docs/alt/rehber.md", "kb/ＤＯＣＳ/plan.md"]) expect(() => readVault(p), p).toThrow(/izin listesinde değil/);
    expect(() => listVault("kb/docs")).toThrow();
  });

  it("records: vault <kb>/docs wins over a leftover <home>/vault/docs; the leftover is not searched or read", () => {
    expect(() => readVault("vault/docs/eski.md")).toThrow(/bulunamadı/);
    expect(search("eski-kok")).toEqual([]);
  });

  it("records: vault falls back to <home>/vault/docs while the kb has no docs/ yet", () => {
    
    rmSync(join(kb, "docs"), { recursive: true });
    expect(readVault("vault/docs/eski.md").content).toContain("eski-kok");
    expect(search("eski-kok")).toEqual(["vault/docs/eski.md"]);
    expect(search("yeni-kok")).toEqual([]);
    expect(ls("vault/docs")).toEqual(["vault/docs/eski.md"]);
  });

  it("records: vault docs path traversal / encoding / backslash / null byte / case rejected under the new root", () => {
    for (const p of ["vault/docs/../../etc/passwd", "vault/docs/../projects/vlad.md", "vault/docs/alt/../../inbox/secret.md",
      "/etc/passwd", join(kb, "docs/plan.md"), "C:/x.md", "vault\\docs\\plan.md", "vault/docs\\plan.md", "vault/docs/..\\x.md",
      "vault/docs/plan.md\0.png", "vault/docs/%2e%2e/projects/vlad.md", "vault/docs/%252e%252e/projects/vlad.md", "vault%2fdocs%2fplan.md",
      "vault/docs/plan.md.", "vault/docs/plan.md ", "vault/docs/plan.md::$DATA", "vault/docs/PLAN~1.md", "vault/docs/.hidden.md", "vault/docs/.git/config"]) {
      expect(() => readVault(p), JSON.stringify(p)).toThrow();
    }
    // upper/lower case of the zone itself is no way around the allowlist, and inbox/audit stay out of reach
    for (const p of ["VAULT/DOCS/../kb/inbox/secret.md", "kb/INBOX/secret.md", "kb/Audit/2026-10.md"]) expect(() => readVault(p), p).toThrow();
  });

  it("records: vault docs symlinks cannot leave the docs root or reach forbidden folders", () => {
    symlinkSync(join(outside, "far.md"), join(kb, "docs/far.md"));
    symlinkSync(outside, join(kb, "docs/out"));
    symlinkSync(join(kb, "inbox"), join(kb, "docs/inbox-link"));
    symlinkSync(join(kb, "audit/2026-10.md"), join(kb, "docs/audit.md"));
    symlinkSync(home, join(kb, "docs/home"));
    expect(() => readVault("vault/docs/far.md")).toThrow(/kök dışına/);
    expect(() => readVault("vault/docs/out/far.md")).toThrow();
    expect(() => readVault("vault/docs/inbox-link/secret.md")).toThrow(/izin listesinde değil/);
    expect(() => readVault("vault/docs/audit.md")).toThrow(/izin listesinde değil/);
    expect(() => readVault("vault/docs/home/vault/docs/eski.md")).toThrow();
    const names = ls("vault/docs");
    for (const n of ["far.md", "out", "inbox-link", "audit.md", "home"]) expect(names).not.toContain(`vault/docs/${n}`);
    for (const q of ["dis-gizli", "gizli-inbox", "gizli-audit", "eski-kok"]) expect(search(q), q).toEqual([]);
  });

  it("records: vault a link from the kb into docs is read as the docs file, a link out of it is refused", () => {
    symlinkSync(join(kb, "docs/plan.md"), join(kb, "projects/plan-link.md"));
    expect(readVault("kb/projects/plan-link.md").content).toContain("yeni-kok");
    symlinkSync(join(kb, "inbox/secret.md"), join(kb, "docs/s.md"));
    expect(() => readVault("vault/docs/s.md")).toThrow();
  });

  it("records: vault a linked docs root is refused (fail closed, nothing leaks)", () => {
    
    rmSync(join(kb, "docs"), { recursive: true });
    symlinkSync(outside, join(kb, "docs"));
    // the link is not trusted as a root: falls back to <home>/vault/docs, never the link target
    expect(() => readVault("vault/docs/far.md")).toThrow();
    expect(search("dis-gizli")).toEqual([]);
    expect(search("eski-kok")).toEqual(["vault/docs/eski.md"]);
  });

  it("records: vault docs only .md and at most 1 MiB", () => {
    put(kb, "docs/pic.png", "x");
    put(kb, "docs/data.json", "{}");
    put(kb, "docs/big.md", "x".repeat(MAX_FILE_BYTES + 1));
    put(kb, "docs/ok.md", "x".repeat(MAX_FILE_BYTES));
    put(kb, "docs/bin.md", Buffer.from([0x23, 0x0a, 0x00, 0xff]));
    expect(() => readVault("vault/docs/pic.png")).toThrow(/\.md/);
    expect(() => readVault("vault/docs/data.json")).toThrow(/\.md/);
    expect(() => readVault("vault/docs/big.md")).toThrow(/çok büyük/);
    expect(() => readVault("vault/docs/bin.md")).toThrow(/ikili/);
    expect(readVault("vault/docs/ok.md").content.length).toBe(MAX_FILE_BYTES);
    expect(ls("vault/docs")).not.toContain("vault/docs/pic.png");
    expect(ls("vault/docs")).not.toContain("vault/docs/data.json");
    expect(search("x".repeat(40))).toEqual(["vault/docs/ok.md"]);
  });

  it("records: vault cli resolves the new root", () => {
    const s = vlad(["vault", "search", "yeni-kok", "--zone", "docs", "--json"]);
    expect(JSON.parse(s.out).hits.map((h: { path: string }) => h.path)).toEqual(["vault/docs/plan.md", "vault/docs/alt/rehber.md"]);
    expect(JSON.parse(vlad(["vault", "read", "vault/docs/plan.md", "--json"]).out).content).toContain("yeni-kok");
    expect(JSON.parse(vlad(["vault", "ls", "vault/docs", "--json"]).out).entries.map((e: { path: string }) => e.path)).toEqual(["vault/docs/alt", "vault/docs/plan.md"]);
    expect(vlad(["vault", "read", "kb/docs/plan.md", "--json"]).code).toBe(1);
    expect(vlad(["vault", "read", "vault/docs/../projects/vlad.md", "--json"]).code).toBe(1);
  });
});

describe("records: vault docs root notice (S5x B2)", () => {
  const summary = () => JSON.parse(vlad(["status", "--summary", "--json"]).out).summary as string;
  const logFile = () => join(kb, "logs", "docs-root.log");

  it("records: vault status warns while a stale vault/docs sits next to kb/docs, and logs the change once", () => {
    expect(summary()).toContain("uyarı: docs kökü: kb/docs (eski vault/docs artık okunmuyor)");
    expect(existsSync(logFile())).toBe(false); // --summary never writes
    for (let i = 0; i < 2; i++) {
      const r = vlad(["status", "--json"]);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out).warnings).toEqual(["docs kökü: kb/docs (eski vault/docs artık okunmuyor)"]);
    }
    const lines = readFileSync(logFile(), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT\S+ docs kökü: kb\/docs \(eski vault\/docs artık okunmuyor\)$/);
  });

  it("records: vault status warns on the fallback root and logs the switch to kb/docs", () => {
    rmSync(join(kb, "docs"), { recursive: true });
    expect(summary()).toContain("uyarı: docs kökü: vault/docs (yedek: kb/docs yok, taşıma bekliyor)");
    vlad(["status"]);
    mkdirSync(join(kb, "docs"));
    vlad(["status"]);
    const lines = readFileSync(logFile(), "utf8").trim().split("\n");
    expect(lines.map((l) => l.replace(/^\S+ /, ""))).toEqual(["docs kökü: vault/docs (yedek: kb/docs yok, taşıma bekliyor)", "docs kökü: kb/docs (eski vault/docs artık okunmuyor)"]);
  });

  it("records: vault status has no docs warning once the old copy is gone, and none in the legacy layout", () => {
    rmSync(join(home, "vault"), { recursive: true });
    expect(summary()).not.toContain("uyarı");
    const legacy = makeHome();
    put(legacy, "vault/docs/x.md", "# x\n");
    const r = spawnSync("node", [cli, "status", "--summary", "--json"], { encoding: "utf8", env: { ...process.env, VLAD_HOME: legacy, VLAD_KB_DIR: "" } });
    expect(JSON.parse(r.stdout).summary).not.toContain("docs kökü");
  });
});
