import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_BYTES, listVault, readVault, searchVault } from "../../src/vault/search.js";
import { makeHome } from "../helpers.js";

const cli = join(resolve(import.meta.dirname, "..", ".."), "dist", "cli.js");
let home: string;
const put = (rel: string, body: string | Buffer) => {
  mkdirSync(dirname(join(home, rel)), { recursive: true });
  writeFileSync(join(home, rel), body);
};
const vlad = (args: string[]) => {
  const r = spawnSync("node", [cli, ...args], { encoding: "utf8", env: { ...process.env, VLAD_HOME: home } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

beforeEach(() => {
  home = makeHome();
  put("kb/projects/vlad.md", "# VLAD\n\n## Açık konular\n- sunucu\n\n## Notlar\nİstanbul notu\n");
  put("kb/inbox/secret.md", "gizli-inbox\n");
  put("kb/logs/x.md", "gizli-log\n");
  put("kb/grants/G-001.md", "gizli-grant\n");
  put("kb/audit/2026-10.md", "gizli-audit\n");
  put("vault/docs/plan.md", "# Plan\nsunucu sunucu sunucu\n");
  put("outside.md", "dışarıda\n");
});

describe("records: vault paths", () => {
  it("records: vault read ../../etc/passwd rejected", () => {
    expect(() => readVault("../../etc/passwd")).toThrow(/üst dizin/);
    expect(() => readVault("kb/../../outside.md")).toThrow(/üst dizin/);
    expect(() => readVault("kb/projects/../../outside.md")).toThrow(/üst dizin/);
  });

  it("records: vault absolute path / ..\\ / null byte / %2e%2e / double-encoding rejected", () => {
    for (const p of ["/etc/passwd", join(home, "kb/projects/vlad.md"), "C:/x.md", "kb\\projects\\vlad.md", "..\\x.md",
      "kb/projects/vlad.md\0.png", "%2e%2e/outside.md", "kb/%2e%2e/outside.md", "kb/%252e%252e/outside.md", "kb%2fprojects%2fvlad.md",
      "kb/projects/vlad\n.md", ""]) {
      expect(() => readVault(p), JSON.stringify(p)).toThrow();
    }
  });

  it("records: vault symlink escape rejected", () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "vlad-out-"));
    writeFileSync(join(elsewhere, "far.md"), "uzak\n");
    symlinkSync(join(elsewhere, "far.md"), join(home, "kb/projects/far.md"));
    symlinkSync(join(home, "outside.md"), join(home, "kb/projects/out.md"));
    symlinkSync(home, join(home, "kb/up"));
    symlinkSync(join(home, "kb/inbox"), join(home, "kb/innocent"));
    symlinkSync(join(home, "kb/inbox/secret.md"), join(home, "kb/projects/s.md"));
    expect(() => readVault("kb/projects/far.md")).toThrow(/kök dışına/);
    expect(() => readVault("kb/projects/out.md")).toThrow(/izin listesinde değil/);
    expect(() => readVault("kb/up/outside.md")).toThrow();
    expect(() => readVault("kb/innocent/secret.md")).toThrow(/izin listesinde değil/);
    expect(() => readVault("kb/projects/s.md")).toThrow(/izin listesinde değil/);
    const names = listVault("kb").map((e) => e.path);
    expect(names).not.toContain("kb/up");
    expect(names).not.toContain("kb/innocent");
    expect(listVault("kb/projects").map((e) => e.path)).toEqual(["kb/projects/vlad.md"]);
    expect(searchVault("gizli").length).toBe(0);
    expect(searchVault("dışarıda").length).toBe(0);
    expect(searchVault("uzak").length).toBe(0);
  });

  it("records: vault kb/inbox and KB/LOGS case variants forbidden", () => {
    for (const p of ["kb/inbox/secret.md", "KB/INBOX/secret.md", "kb/Inbox/secret.md", "Kb/LoGs/x.md", "KB/LOGS/x.md",
      "kb/grants/G-001.md", "KB/Audit/2026-10.md", "kb/./inbox/secret.md", "kb//inbox/secret.md", "kb/projects/.hidden.md", "outside.md", "vault/other.md"]) {
      expect(() => readVault(p), p).toThrow();
    }
    expect(() => listVault("KB/INBOX")).toThrow();
    expect(() => listVault("kb/logs")).toThrow();
  });

  it("records: vault binary and invalid utf8 and size cap", () => {
    put("kb/projects/bin.md", Buffer.from([0x23, 0x20, 0x61, 0x00, 0x62]));
    put("kb/projects/bad.md", Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    put("kb/projects/big.md", "a".repeat(MAX_FILE_BYTES + 1));
    put("kb/projects/ok.md", "a".repeat(MAX_FILE_BYTES));
    put("kb/projects/pic.png", "x");
    expect(() => readVault("kb/projects/bin.md")).toThrow(/ikili/);
    expect(() => readVault("kb/projects/bad.md")).toThrow(/UTF-8/);
    expect(() => readVault("kb/projects/big.md")).toThrow(/çok büyük/);
    expect(readVault("kb/projects/ok.md").content.length).toBe(MAX_FILE_BYTES);
    expect(() => readVault("kb/projects/pic.png")).toThrow(/\.md/);
    expect(() => readVault("kb/projects")).toThrow(/dosya değil/);
    // unreadable files are skipped by search instead of failing it
    expect(searchVault("vlad").map((h) => h.path)).toContain("kb/projects/vlad.md");
  });
});

describe("records: vault read", () => {
  it("records: vault heading read returns section", () => {
    const f = readVault("kb/projects/vlad.md", "açık konular");
    expect(f.content).toBe("## Açık konular\n- sunucu");
    expect(f.headings.map((h) => h.text)).toEqual(["VLAD", "Açık konular", "Notlar"]);
    expect(readVault("kb/projects/vlad.md", "VLAD").content).toContain("İstanbul notu");
    expect(() => readVault("kb/projects/vlad.md", "yok")).toThrow(/başlık bulunamadı/);
  });

  it("records: vault heading ignores headings inside code fences", () => {
    put("kb/projects/f.md", "# A\n```\n# fake\n```\ntext\n# B\nb\n");
    expect(readVault("kb/projects/f.md").headings.map((h) => h.text)).toEqual(["A", "B"]);
    expect(readVault("kb/projects/f.md", "A").content).toBe("# A\n```\n# fake\n```\ntext");
  });
});

describe("records: vault search", () => {
  it("records: vault turkish İ/ı search", () => {
    expect(searchVault("istanbul").map((h) => h.path)).toEqual(["kb/projects/vlad.md"]);
    expect(searchVault("İSTANBUL")[0].path).toBe("kb/projects/vlad.md");
    expect(searchVault("ISTANBUL")[0].path).toBe("kb/projects/vlad.md");
    expect(searchVault("açık konular")[0].path).toBe("kb/projects/vlad.md");
    put("kb/projects/ik.md", "ılık süt\n");
    expect(searchVault("ILIK")[0].path).toBe("kb/projects/ik.md");
    expect(searchVault("ilik")[0].path).toBe("kb/projects/ik.md");
  });

  it("records: vault empty and 10k-char query bounded", () => {
    expect(() => searchVault("")).toThrow(/boş/);
    expect(() => searchVault("   ")).toThrow(/boş/);
    expect(() => searchVault("a".repeat(10_000))).toThrow(/çok uzun/);
    expect(() => searchVault("a\0b")).toThrow(/null/);
    expect(searchVault("a".repeat(256))).toEqual([]);
  });

  it("records: vault search treats regex characters literally", () => {
    put("kb/projects/re.md", "a.b (x) [y] c++ $1 \\d\n");
    expect(searchVault(".*")).toEqual([]);
    expect(searchVault("(x)")[0].path).toBe("kb/projects/re.md");
    expect(searchVault("c++")[0].path).toBe("kb/projects/re.md");
    expect(searchVault("[y]")[0].path).toBe("kb/projects/re.md");
    expect(searchVault("\\d")[0].path).toBe("kb/projects/re.md");
    expect(searchVault("a.b")[0].path).toBe("kb/projects/re.md");
    expect(searchVault("axb").length).toBe(0);
  });

  it("records: vault search lists only allowlisted paths (no grants/audit)", () => {
    const hits = searchVault("gizli");
    expect(hits).toEqual([]);
    const all = searchVault("sunucu").map((h) => h.path);
    expect(all.sort()).toEqual(["kb/projects/vlad.md", "vault/docs/plan.md"]);
    expect(listVault().map((e) => e.path)).toEqual(["kb", "vault/docs"]);
    expect(listVault("kb").map((e) => e.path)).toEqual(["kb/journal", "kb/projects", "kb/tasks"]);
  });

  it("records: vault search score order and --zone", () => {
    put("kb/projects/b.md", "sunucu\n");
    const hits = searchVault("sunucu");
    expect(hits[0].path).toBe("vault/docs/plan.md"); // 3 occurrences beat 1
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    expect(searchVault("sunucu", { zone: "kb" }).every((h) => h.path.startsWith("kb/"))).toBe(true);
    expect(searchVault("sunucu", { zone: "docs" }).map((h) => h.path)).toEqual(["vault/docs/plan.md"]);
    expect(() => searchVault("x", { zone: "all" })).toThrow(/bölge/);
    expect(searchVault("sunucu", { limit: 1 }).length).toBe(1);
    expect(() => searchVault("x", { limit: 0 })).toThrow(/limit/);
    // a heading match outranks a plain body match with the same count
    put("kb/projects/h.md", "# zebra\n");
    put("kb/projects/p.md", "zebra\n");
    expect(searchVault("zebra").map((h) => h.path)).toEqual(["kb/projects/h.md", "kb/projects/p.md"]);
  });

  it("records: every search hit path is readable", () => {
    for (const h of searchVault("sunucu")) expect(readVault(h.path).path).toBe(h.path);
  });
});

describe("records: vault cli", () => {
  it("search/read/ls --json", () => {
    const s = vlad(["vault", "search", "sunucu", "--zone", "docs", "--json"]);
    expect(s.code).toBe(0);
    expect(JSON.parse(s.out).hits[0].path).toBe("vault/docs/plan.md");
    const r = vlad(["vault", "read", "kb/projects/vlad.md", "--heading", "Notlar", "--json"]);
    expect(JSON.parse(r.out).content).toContain("İstanbul");
    const l = vlad(["vault", "ls", "--json"]);
    expect(JSON.parse(l.out).entries.map((e: { path: string }) => e.path)).toEqual(["kb", "vault/docs"]);
  });

  it("errors use the stderr json contract and exit 1", () => {
    const r = vlad(["vault", "read", "KB/INBOX/secret.md", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.err).error).toMatch(/izin listesinde değil/);
    expect(vlad(["vault", "search", "", "--json"]).code).toBe(1);
  });
});
