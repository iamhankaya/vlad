// Wiring of the promote gate from the environment: `VLAD_KB_REPO`, `VLAD_KB_MAIN`, `VLAD_KB_SERVER_BRANCH`, `VLAD_KB_DIR`,
// `VLAD_SERVER_MACHINE` (else `VLAD_MACHINE`, else the hostname), state in `<stateDir>/kbpromote`.
import { hostname } from "node:os";
import { join } from "node:path";
import { KB_TOKEN_PERMISSIONS } from "../github/appToken.ts";
import { GithubWriter } from "../github/writer.ts";
import { runVlad, runVladJson } from "../vlad/cli.ts";
import { createGitExec, createKbGitPort, ensureBareRepo, type GitExec } from "./gitexec.ts";
import { mainActiveMachine, promoteKb, type KbConflictInput, type KbSyncConfig, type PromoteDeps, type PromoteResult } from "./promote.ts";
import { requestSync, waitSync, type TakeoverDeps } from "./takeover.ts";

const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;
const MACHINE = /^[A-Za-z0-9._-]+$/;

/** Config of the gate, or undefined when `VLAD_KB_REPO` is not set (the gate is off). A bad value throws: a half-configured gate must not start. */
export function loadKbSyncConfig(env: NodeJS.ProcessEnv, stateDir: string): (KbSyncConfig & { kbDir: string }) | undefined {
  const repo = env.VLAD_KB_REPO;
  if (!repo) return undefined;
  const main = env.VLAD_KB_MAIN ?? "main";
  const serverBranch = env.VLAD_KB_SERVER_BRANCH ?? "kb-server";
  const serverMachine = (env.VLAD_SERVER_MACHINE ?? env.VLAD_MACHINE ?? hostname()).toLowerCase();
  if (!REPO.test(repo)) throw new Error("VLAD_KB_REPO geçersiz (owner/repo)");
  if (!BRANCH.test(main) || !BRANCH.test(serverBranch) || main === serverBranch) throw new Error("VLAD_KB_MAIN / VLAD_KB_SERVER_BRANCH geçersiz ya da aynı");
  if (!MACHINE.test(serverMachine)) throw new Error("sunucu makine adı geçersiz");
  const kbDir = env.VLAD_KB_DIR ?? (env.VLAD_HOME ? join(env.VLAD_HOME, "kb") : "");
  if (!kbDir) throw new Error("VLAD_KB_DIR (ya da VLAD_HOME) gerekli");
  return { repo, main, serverBranch, serverMachine, stateDir: join(stateDir, "kbpromote"), kbDir };
}

/**
 * Startup check (K10): the kb repository must not be a project's code repository. `pushKbMain` writes main without the approval path, so on
 * a code repo it would be a way around it. `repos` are the `repo` fields of all project cards.
 */
export function assertKbRepoIsNotCodeRepo(kbRepo: string, repos: Iterable<string | null | undefined>): void {
  for (const r of repos) if (r && r.toLowerCase() === kbRepo.toLowerCase()) throw new Error(`kb_repo_is_code_repo: ${kbRepo} bir proje reposu; kb reposu ayrı olmalı`);
}

export async function projectRepos(): Promise<string[]> {
  const r = await runVladJson<{ projects: { repo?: string | null }[] }>(["project", "list"]);
  return (r.projects ?? []).map((p) => p.repo ?? "").filter(Boolean);
}

/** Promote's card port: `vlad card new` (idempotent by key) and closing the open promote cards. */
export function vladCardPort(): PromoteDeps["cards"] {
  return {
    async open(i: KbConflictInput) {
      const args = ["card", "new", "--kind", "kb_conflict", "--project", "vlad", "--title", i.title,
        "--conflict-key", i.key, "--conflict-reason", i.reason, "--conflict-source", i.source, "--conflict-head", i.head, "--conflict-base", i.base];
      // `--opt=value`: a path that starts with `-` must not be read as an option
      for (const p of i.paths) args.push(`--conflict-path=${p}`);
      for (const r of i.rules) args.push("--conflict-rule", r);
      const r = await runVladJson<{ id: string; created?: boolean }>(args);
      return { id: r.id, created: r.created !== false };
    },
    async resolveOpen(source) {
      const r = await runVladJson<{ cards: { id: string; kb_conflict?: { source?: string } }[] }>(["card", "list", "--state", "open", "--kind", "kb_conflict"]);
      let n = 0;
      for (const c of r.cards) if (c.kb_conflict?.source === source) { await runVlad(["card", "resolve", c.id]); n++; }
      return n;
    },
  };
}

export interface KbGate { config: KbSyncConfig & { kbDir: string }; git: GitExec; writer: GithubWriter; deps: PromoteDeps; promote(o?: { trigger?: "timer" | "takeover"; waitLockMs?: number }): Promise<PromoteResult>; takeoverDeps: TakeoverDeps }

/** Builds the gate. `tokens.token(repo, perms)` is the App token provider; the writer's client is the guarded GitHub client (unused by `pushKbMain`). */
export async function buildKbGate(o: {
  config: KbSyncConfig & { kbDir: string };
  tokens: { token(repo: string, perms: typeof KB_TOKEN_PERMISSIONS): Promise<string> };
  client: ConstructorParameters<typeof GithubWriter>[0];
  now?: () => number;
}): Promise<KbGate> {
  const { config } = o;
  await ensureBareRepo(config.stateDir);
  const git = createGitExec({ stateDir: config.stateDir });
  const url = config.remoteUrl ?? `https://github.com/${config.repo}.git`;
  const writer = new GithubWriter(o.client, { repo: config.repo, main: config.main, tokens: o.tokens, git: createKbGitPort(git, url) });
  const now = o.now ?? Date.now;
  const deps: PromoteDeps = { config, git, tokens: o.tokens, writer, cards: vladCardPort(), now };
  const promote = (po?: { trigger?: "timer" | "takeover"; waitLockMs?: number }) => promoteKb(deps, po);
  const takeoverDeps: TakeoverDeps = {
    serverMachine: config.serverMachine, stateDir: config.stateDir, now,
    requestSync: (reason) => requestSync(config.kbDir, reason, now),
    waitSync: (seq) => waitSync(config.kbDir, seq, { now }),
    claim: async () => { await runVlad(["active", "claim", "--takeover", "--json"]); },
    promote: (po) => promote(po),
    mainActive: () => mainActiveMachine(deps),
  };
  return { config, git, writer, deps, promote, takeoverDeps };
}
