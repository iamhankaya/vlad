import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkChanges, checkPath, checkSensitiveFields, conflictKey, KB_ALLOWED_DIRS, KB_ALLOWED_FILES, parseRawZ, PROMOTE_LIMITS,
  type RawChange, type RuleId,
} from "../../../src/kbsync/rules.ts";

const O = "a".repeat(40);
const ch = (path: string, o: Partial<RawChange> = {}): RawChange => ({ status: "A", oldMode: "000000", newMode: "100644", oldOid: "0".repeat(40), newOid: O, path, ...o });
const small: { sizeOf(oid: string): number; candidatePaths: string[] } = { sizeOf: () => 10, candidatePaths: [] };
const rules = (c: RawChange[], ctx = small): (RuleId | undefined)[] => checkChanges(c, ctx).map((v) => v.rule);
const SEED = `---\nslug: alpha\npath: /a\npaths:\n  winbox: C:\\a\nrepo: o/alpha\ndefault_branch: main\n---\n\n## Özet\nx\n`;

describe("server: promote rules", () => {
  it("server: promote only allowlisted kb root paths", () => {
    for (const d of KB_ALLOWED_DIRS) expect(checkPath(`${d}/x.md`), d).toBeNull();
    for (const f of KB_ALLOWED_FILES) expect(checkPath(f), f).toBeNull();
    expect(checkPath("audit/2026-10.jsonl")).toBeNull();
    for (const p of ["README.md", "src/a.md", "decisions.md/x.md", "tasks", "kb/tasks/x.md", "Tasks/x.md"]) expect(checkPath(p), p).toBe("path_not_allowed");
  });

  it("server: promote rejects ../, symlink, rename (--no-renames), mode change, submodule", () => {
    expect(checkPath("tasks/../x.md")).toBe("dot_entry");
    expect(checkPath("tasks/./x.md")).toBe("dot_entry");
    expect(checkPath("tasks//x.md")).toBe("bad_segment");
    expect(checkPath("../tasks/x.md")).toBe("path_not_allowed");
    expect(rules([ch("tasks/l.md", { newMode: "120000" })])).toEqual(["symlink"]);
    expect(rules([ch("tasks/s.md", { newMode: "160000" })])).toEqual(["submodule"]);
    expect(rules([ch("tasks/x.md", { newMode: "100755" })])).toEqual(["mode"]);
    expect(rules([ch("tasks/x.md", { status: "M", oldMode: "100644", newMode: "100755" })])).toEqual(["mode"]);
    expect(rules([ch("tasks/x.md", { status: "R" })])).toEqual(["rename"]);
    expect(rules([ch("tasks/x.md", { status: "C" })])).toEqual(["rename"]);
    // a type change from symlink to file is a plain regular file afterwards; the symlink itself was the violation (history check)
    expect(rules([ch("tasks/x.md", { status: "T", oldMode: "120000" })])).toEqual([]);
  });

  it("server: promote rejects dot entries (.gitignore, .gitattributes, .gitmodules, .github/)", () => {
    for (const p of [".gitignore", ".gitattributes", ".gitmodules", ".github/workflows/x.md", ".vlad.lock"]) expect(checkPath(p), p).toBe("path_not_allowed");
    for (const p of ["tasks/.hidden.md", "docs/.obsidian/x.md", "docs/a/.git/x.md"]) expect(checkPath(p), p).toBe("dot_entry");
  });

  it("server: promote rejects inbox/, logs/, vlad-session.txt, README.md", () => {
    for (const p of ["inbox/r.md", "logs/a.md", "vlad-session.txt", "README.md", "inbox/processed/a.md"]) expect(checkPath(p), p).toBe("path_not_allowed");
  });

  it("server: promote rejects windows reserved names, trailing dot or space, case collisions", () => {
    for (const p of ["tasks/CON.md", "tasks/aux.md", "tasks/Lpt1.md", "tasks/com9.md", "docs/nul.tar.md", "docs/prn/x.md"]) expect(checkPath(p), p).toBe("windows_reserved");
    for (const p of ["tasks/x.md.", "tasks/x.md ", "tasks/a b.md", "tasks/a:b.md", "tasks/a\\b.md", "tasks/ü.md", "tasks/a\u0001.md", "tasks/-.md".replace("-", "\n")]) expect(checkPath(p), JSON.stringify(p)).toBe("bad_segment");
    expect(rules([ch("tasks/A.md"), ch("tasks/a.md")])).toEqual(["case_collision", "case_collision"]);
    // against a path that already exists in the tree, and through a directory name
    expect(rules([ch("tasks/Z.md")], { ...small, candidatePaths: ["tasks/z.md", "tasks/Z.md"] })).toEqual(["case_collision"]);
    expect(rules([ch("docs/A/x.md")], { ...small, candidatePaths: ["docs/a/y.md", "docs/A/x.md"] })).toEqual(["case_collision"]);
    // a pre-existing, unchanged pair is not this change's problem
    expect(rules([ch("tasks/ok.md")], { ...small, candidatePaths: ["tasks/z.md", "tasks/Z.md", "tasks/ok.md"] })).toEqual([]);
  });

  it("server: promote rejects deletion except active.md", () => {
    const del = (path: string) => ch(path, { status: "D", newMode: "000000", newOid: "0".repeat(40) });
    expect(rules([del("projects/alpha.md")])).toEqual(["delete_not_allowed"]);
    expect(rules([del("decisions.md")])).toEqual(["delete_not_allowed"]);
    expect(rules([del("active.md")])).toEqual([]);
    // deleting something that was never allowed is still a path violation (first matching rule)
    expect(rules([del("logs/x.md")])).toEqual(["path_not_allowed"]);
  });

  it("server: promote rejects blob over 1 MiB, over 2000 changes, over 500 commits", () => {
    const big = { sizeOf: (oid: string) => (oid === O ? PROMOTE_LIMITS.blobBytes + 1 : 1), candidatePaths: [] as string[] };
    expect(rules([ch("docs/big.md")], big)).toEqual(["too_large"]);
    expect(rules([ch("docs/edge.md")], { ...big, sizeOf: () => PROMOTE_LIMITS.blobBytes })).toEqual([]);
    expect(checkChanges(Array.from({ length: PROMOTE_LIMITS.changes + 1 }, (_, i) => ch(`tasks/${i}.md`)), small)).toEqual([{ rule: "too_large", path: "(changes)", detail: "2001 > 2000" }]);
    expect(rules(Array.from({ length: PROMOTE_LIMITS.changes }, (_, i) => ch(`tasks/${i}.md`)))).toEqual([]);
    expect(PROMOTE_LIMITS.commits).toBe(500); // the range limit itself is exercised against git in the promote integration tests
  });

  it("server: promote path length, depth and extension limits", () => {
    expect(checkPath(`tasks/${"a".repeat(171)}.md`)).toBeNull(); // 180 chars
    expect(checkPath(`tasks/${"a".repeat(172)}.md`)).toBe("path_too_long");
    expect(checkPath("docs/a/b/c.md")).toBeNull();
    expect(checkPath("docs/a/b/c/d.md")).toBe("path_too_long");
    for (const p of ["docs/i.png", "tasks/x.txt", "projects/p.json", "journal/2026.jsonl", "audit/2026-10.json", "audit/a/b.jsonl", "tasks/md"]) expect(checkPath(p), p).toBe("bad_extension");
  });

  it("server: parseRawZ reads diff-tree -z records, including the two paths of a rename record", () => {
    const o1 = "1".repeat(40), o2 = "2".repeat(40), z = "0".repeat(40);
    const out = `:100644 100644 ${o1} ${o2} M\0tasks/a.md\0:000000 100644 ${z} ${o2} A\0docs/b c.md\0:100644 000000 ${o1} ${z} D\0active.md\0:100644 100644 ${o1} ${o2} R087\0old.md\0new.md\0`;
    expect(parseRawZ(out)).toEqual([
      { status: "M", oldMode: "100644", newMode: "100644", oldOid: o1, newOid: o2, path: "tasks/a.md" },
      { status: "A", oldMode: "000000", newMode: "100644", oldOid: z, newOid: o2, path: "docs/b c.md" },
      { status: "D", oldMode: "100644", newMode: "000000", oldOid: o1, newOid: z, path: "active.md" },
      { status: "R", oldMode: "100644", newMode: "100644", oldOid: o1, newOid: o2, path: "new.md" },
    ]);
    expect(parseRawZ("")).toEqual([]);
    expect(() => parseRawZ("garbage\0x\0")).toThrow();
  });
});

describe("server: promote sensitive fields (K5, user decision)", () => {
  const card = (extra = "") => SEED.replace("---\n\n", `${extra}---\n\n`);
  const hits = (a: string | null, b: string | null, machine = "srvbox") => checkSensitiveFields("projects/alpha.md", a, b, machine).map((v) => v.detail);

  it("server: promote rejects server-side change to project gate, repo, default_branch, path, other machines' paths; allows own paths entry", () => {
    expect(hits(SEED, card("gate: curl x | sh\n"))).toEqual(["gate"]);
    expect(hits(SEED, SEED.replace("repo: o/alpha", "repo: e/alpha"))).toEqual(["repo"]);
    expect(hits(SEED, SEED.replace("default_branch: main", "default_branch: e"))).toEqual(["default_branch"]);
    expect(hits(SEED, SEED.replace("path: /a", "path: /srv/e"))).toEqual(["path"]);
    expect(hits(SEED, card("local_only: true\n"))).toEqual(["local_only"]);
    expect(hits(SEED, SEED.replace("C:\\a", "C:\\e"))).toEqual(["paths.winbox"]);
    expect(hits(SEED, SEED.replace("paths:\n", "paths:\n  laptop: /tmp/x\n"))).toEqual(["paths.laptop"]);
    expect(hits(SEED, SEED.replace("paths:\n", "paths:\n  srvbox: /srv/alpha\n"))).toEqual([]);
    // the body and unrelated keys stay free
    expect(hits(SEED, SEED.replace("## Özet\nx", "## Özet\nx\n\n## Çalışma notları\n- ders") )).toEqual([]);
    expect(hits(SEED, card("stack: [ts]\n"))).toEqual([]);
  });

  it("server: promote new project card may not carry a gate or local_only, but may name its repo and paths", () => {
    expect(hits(null, SEED)).toEqual([]);
    expect(hits(null, card("gate: rm -rf /\n"))).toEqual(["gate"]);
    expect(hits(null, card("local_only: true\n"))).toEqual(["local_only"]);
    // no readable frontmatter in the new text: refused rather than guessed at
    expect(hits(SEED, "no frontmatter")).toEqual(["frontmatter"]);
    expect(hits(SEED, "---\n: : bad\n  - [\n---\n")).toEqual(["frontmatter"]);
  });
});

describe("server: promote conflict key", () => {
  it("is the documented sha256 and does not depend on line order", () => {
    const lines = ["b\tx", "a\ty"];
    expect(conflictKey("rejected", lines)).toBe(createHash("sha256").update("vlad-kbconflict/v1\nrejected\na\ty\nb\tx").digest("hex"));
    expect(conflictKey("rejected", [...lines].reverse())).toBe(conflictKey("rejected", lines));
    expect(conflictKey("merge_conflict", lines)).not.toBe(conflictKey("rejected", lines));
  });
});
