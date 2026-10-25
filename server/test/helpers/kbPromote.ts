// T13 (T20261025-90): gerçek `promoteKb` için sahte bağımlılıklar + kb-server dalına keyfi (kötü niyetli) commit kurucuları.
// `protocol.file.allow` yalnız burada, test bağımlılığı olarak açılır (S13a "Test stratejisi"): üretim gitexec'i `protocol.allow=never` kullanır.
// S13c uygulanana kadar `loadPromote()` modül bulunamadı ile düşer; bu beklenen kırmızıdır.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IDENT, git, type World } from "./kbRepos.ts";

export interface PromoteResultShape {
  promoted: boolean;
  reason?: string;
  main?: string;
  head?: string;
  merge?: string;
  card?: string;
  violations?: Array<{ rule: string; path: string; detail?: string }>;
}

export async function loadPromote(): Promise<{ promoteKb: (d: any, o?: any) => Promise<PromoteResultShape> }> {
  // dinamik: modül yoksa yalnız bu test düşer, dosya toplanabilir kalır
  // değişken belirteç: S13c gelmeden `tsc --noEmit` (gate) bu dosyada TS2307 vermesin
  const spec = "../../src/kbsync/promote.ts";
  return (await import(/* @vite-ignore */ spec)) as any;
}

export interface PromoteEnv {
  deps: any;
  /** pushKbMain çağrıları */
  writes: Array<{ commit: string; expectedMain: string }>;
  /** cards.open girdileri */
  cards: any[];
  stateDir: string;
  /** promote'un kendi bare klonu */
  repoGit: string;
  run(o?: { trigger?: "timer" | "takeover"; waitLockMs?: number }): Promise<PromoteResultShape>;
}

export function makePromoteEnv(world: World, o: { serverMachine?: string; now?: () => number } = {}): PromoteEnv {
  const stateDir = mkdtempSync(join(tmpdir(), "vlad-t13-promote-"));
  const repoGit = join(stateDir, "repo.git");
  spawnSync("git", ["init", "--bare", "-q", repoGit]);
  const gitExec = async (args: string[], gi: { input?: string } = {}) => {
    const r = spawnSync("git", ["-c", "protocol.file.allow=always", ...args], {
      cwd: repoGit, encoding: "utf8", input: gi.input, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: stateDir, ...IDENT, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? "" };
  };
  const writes: PromoteEnv["writes"] = [];
  const cards: any[] = [];
  const deps = {
    config: {
      repo: "acme/vlad-kb", main: "main", serverBranch: "kb-server", serverMachine: o.serverMachine ?? "srvbox",
      stateDir, remoteUrl: world.url,
    },
    git: gitExec,
    tokens: { token: async () => "test-token" },
    writer: {
      // gerçek yazıcı gibi: sabit ref, zorlamasız, ilk ebeveyn beklenen main olmalı
      pushKbMain: async (commit: string, expectedMain: string) => {
        const parent = (await gitExec(["rev-parse", `${commit}^1`])).stdout.trim();
        if (parent !== expectedMain) throw new Error(`pushKbMain: ilk ebeveyn ${parent} != beklenen main ${expectedMain}`);
        if (world.remoteHead("main") !== expectedMain) return { kind: "main_moved" as const };
        const r = await gitExec(["push", "-q", world.url, `${commit}:refs/heads/main`]);
        if (r.code !== 0) return { kind: "main_moved" as const };
        writes.push({ commit, expectedMain });
        return { kind: "pushed" as const };
      },
    },
    cards: {
      open: async (input: any) => { cards.push(input); return { id: `C-${String(cards.length).padStart(3, "0")}`, created: true }; },
      resolveOpen: async () => 0,
    },
    now: o.now ?? (() => Date.now()),
  };
  return {
    deps, writes, cards, stateDir, repoGit,
    run: async (opts) => (await loadPromote()).promoteKb(deps, opts),
  };
}

// ---------------------------------------------------------------- kb-server dalına commit kurucuları

export type Change =
  | { path: string; text: string }
  | { path: string; bytes: number }
  | { path: string; exec: true; text: string }
  | { path: string; symlink: string }
  | { path: string; gitlink: string }
  | { path: string; delete: true };

/** kb-server dalının ucuna tek commit ekler (ya da `commits` ile zincir) ve origin/kb-server'a push eder. */
export function pushToServerBranch(world: World, commits: Change[][], message = "sunucu yazması"): string {
  const d = world.scratch("kb-server");
  try {
    for (const [i, changes] of commits.entries()) {
      for (const c of changes) {
        const f = join(d, c.path);
        if ("delete" in c) { git(d, ["rm", "-q", "--", c.path]); continue; }
        mkdirSync(dirname(f), { recursive: true });
        if (!("gitlink" in c)) rmSync(f, { force: true }); // var olan symlink'in hedefine yazılmasın
        if ("gitlink" in c) { git(d, ["update-index", "--add", "--cacheinfo", `160000,${c.gitlink},${c.path}`]); continue; }
        if ("symlink" in c) { rmSync(f, { force: true }); symlinkSync(c.symlink, f); }
        else if ("bytes" in c) writeFileSync(f, "x".repeat(c.bytes));
        else { writeFileSync(f, c.text); if ("exec" in c) chmodSync(f, 0o755); }
        git(d, ["add", "-f", "--", c.path]);
        if ("exec" in c) git(d, ["update-index", "--chmod=+x", "--", c.path]);
      }
      git(d, ["commit", "-q", "--allow-empty", "-m", `${message} ${i + 1}`]);
    }
    git(d, ["push", "-q", "origin", "HEAD:refs/heads/kb-server"]);
    return git(d, ["rev-parse", "HEAD"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** `git fast-import` ile büyük aralıklar: `n` commit (her biri bir dosya) ya da tek commit'te `files` dosya. */
export function bulkOnServerBranch(world: World, o: { commits?: number; filesInOneCommit?: number }): string {
  const d = world.scratch("kb-server");
  try {
    const parent = git(d, ["rev-parse", "HEAD"]);
    let s = "";
    const commit = (n: number, files: string[], from: string) => {
      s += `commit refs/heads/kb-bulk\nmark :${n}\ncommitter T <t@t> ${1_700_000_000 + n} +0000\ndata 4\nbulk\nfrom ${from}\n`;
      for (const f of files) s += `M 100644 inline ${f}\ndata 2\nx\n\n`;
    };
    if (o.commits) for (let i = 1; i <= o.commits; i++) commit(i, [`tasks/bulk-${i}.md`], i === 1 ? parent : `:${i - 1}`);
    if (o.filesInOneCommit) commit(1, Array.from({ length: o.filesInOneCommit }, (_, i) => `findings/bulk-${i}.md`), parent);
    const r = spawnSync("git", ["fast-import", "--quiet"], { cwd: d, input: s, encoding: "utf8", env: { ...process.env, ...IDENT } });
    if (r.status !== 0) throw new Error(`fast-import: ${r.stderr}`);
    git(d, ["push", "-q", "origin", "refs/heads/kb-bulk:refs/heads/kb-server"]);
    return git(d, ["rev-parse", "refs/heads/kb-bulk"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** Ham ağaç yolu (git'in normal araçlarının reddettiği `..`, `.git` gibi girdiler) `git mktree` ile kurulur. */
export function pushRawTreeEntry(world: World, rawPath: string[], text = "x\n"): string {
  const d = world.scratch("kb-server");
  try {
    const blob = git(d, ["hash-object", "-w", "--stdin"], { input: text });
    // en içten dışa: [a, b, c] -> c blob, b tree{c}, a tree{b}
    let entry = `100644 blob ${blob}\t${rawPath[rawPath.length - 1]}`;
    let treeId = git(d, ["mktree", "--missing"], { input: entry + "\n" });
    for (let i = rawPath.length - 2; i >= 1; i--) treeId = git(d, ["mktree", "--missing"], { input: `040000 tree ${treeId}\t${rawPath[i]}\n` });
    const base = git(d, ["rev-parse", "HEAD^{tree}"]);
    // mevcut ağacı koru: yeni kök = eski kök girdileri + yeni üst düzey girdi
    const old = git(d, ["ls-tree", base]);
    const top = rawPath[0]!;
    const rows = old.split("\n").filter((l) => l && !l.endsWith(`\t${top}`));
    rows.push(`040000 tree ${treeId}\t${top}`);
    const root = git(d, ["mktree", "--missing"], { input: rows.join("\n") + "\n" });
    const commit = git(d, ["commit-tree", root, "-p", git(d, ["rev-parse", "HEAD"]), "-m", "ham girdi"]);
    git(d, ["push", "-q", "origin", `${commit}:refs/heads/kb-server`]);
    return commit;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}
