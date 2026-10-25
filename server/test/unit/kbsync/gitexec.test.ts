import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppTokenProvider, KB_TOKEN_PERMISSIONS, TOKEN_PERMISSIONS } from "../../../src/github/appToken.ts";
import { GithubWriter } from "../../../src/github/writer.ts";
import { assertKbRepoIsNotCodeRepo, loadKbSyncConfig } from "../../../src/kbsync/config.ts";
import { createGitExec, createKbGitPort, ensureBareRepo, hardenedEnv, HARDENED_CONFIG, type Runner } from "../../../src/kbsync/gitexec.ts";

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "vlad-gx-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const TOKEN = "ghs_SECRETTOKENVALUE123";
const A = "a".repeat(40), B = "b".repeat(40);
const KB = "acme/vlad-kb";

function recorder(reply: (args: string[]) => { code: number; stdout?: string; stderr?: string } = () => ({ code: 0 })) {
  const calls: { file: string; args: string[]; cwd: string; env: Record<string, string>; input?: string }[] = [];
  const run: Runner = async (file, args, o) => { calls.push({ file, args, cwd: o.cwd, env: o.env, input: o.input }); const r = reply(args); return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }; };
  return { calls, run };
}

describe("server: promote git env hardened and token absent from argv", () => {
  it("every call carries the hardening config and a minimal environment; the token is only an env value for askpass", async () => {
    const dir = tmp();
    const rec = recorder();
    const git = createGitExec({ stateDir: dir, run: rec.run, path: "/usr/bin" });
    await git(["fetch", "-q", "--no-tags", "https://github.com/acme/vlad-kb.git", "+refs/heads/main:refs/remotes/origin/main"], { token: TOKEN });
    await git(["rev-parse", "HEAD"]);
    const [f, p] = rec.calls;
    for (const c of rec.calls) {
      expect(c.file).toBe("git");
      expect(c.cwd).toBe(join(dir, "repo.git"));
      for (const cfg of HARDENED_CONFIG) expect(c.args).toContain(cfg);
      // `-c` pairs come first, then the command
      expect(c.args.slice(0, HARDENED_CONFIG.length * 2).filter((_, i) => i % 2 === 0).every((x) => x === "-c")).toBe(true);
      expect(Object.keys(c.env).sort()).toEqual(expect.arrayContaining(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "PATH"]));
      expect(c.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", HOME: dir });
      expect(JSON.stringify(c.args)).not.toContain(TOKEN);
    }
    expect(HARDENED_CONFIG).toEqual(expect.arrayContaining(["core.hooksPath=/dev/null", "core.fsmonitor=false", "protocol.allow=never", "protocol.https.allow=always", "transfer.fsckObjects=true", "fetch.fsckObjects=true", "submodule.recurse=false", "credential.helper="]));
    expect(f!.env.VLAD_GIT_TOKEN).toBe(TOKEN);
    expect(f!.env.GIT_ASKPASS).toBe(join(dir, "askpass.sh"));
    expect(p!.env.VLAD_GIT_TOKEN).toBeUndefined();
    expect(p!.env.GIT_ASKPASS).toBeUndefined();
    // nothing of the parent's environment (tokens, proxies, GIT_DIR...) is inherited
    process.env.VLAD_LEAK_PROBE = "x";
    process.env.GIT_DIR = "/nope";
    try {
      const e = hardenedEnv(dir, "/usr/bin");
      expect(Object.keys(e)).not.toContain("VLAD_LEAK_PROBE");
      expect(Object.keys(e)).not.toContain("GIT_DIR");
    } finally {
      delete process.env.VLAD_LEAK_PROBE;
      delete process.env.GIT_DIR;
    }
  });

  it("askpass answers the username with x-access-token and the password from the environment; bare repo is private", async () => {
    const dir = tmp();
    const rec = recorder();
    await ensureBareRepo(dir, rec.run, "/usr/bin");
    const askpass = join(dir, "askpass.sh");
    const body = readFileSync(askpass, "utf8");
    expect(body).toContain("x-access-token");
    expect(body).toContain("$VLAD_GIT_TOKEN");
    expect(body).not.toContain(TOKEN);
    expect(statSync(askpass).mode & 0o077).toBe(0);
    expect(statSync(join(dir, "repo.git")).mode & 0o077).toBe(0);
    expect(rec.calls[0]!.args).toEqual(["init", "--bare", "-q"]);
    expect(existsSync(join(dir, "repo.git"))).toBe(true);
  });

  it("the writer's port pushes commit:ref without force and maps a refused update to rejected", async () => {
    const dir = tmp();
    const rec = recorder((args) => (args.at(-1)!.startsWith(B) ? { code: 1, stderr: " ! [rejected]        bbbb -> main (fetch first)" } : { code: 0 }));
    const port = createKbGitPort(createGitExec({ stateDir: dir, run: rec.run, path: "/usr/bin" }), `https://github.com/${KB}.git`);
    expect(await port.push({ token: TOKEN, commit: A, ref: "refs/heads/main" })).toBe("pushed");
    expect(await port.push({ token: TOKEN, commit: B, ref: "refs/heads/main" })).toBe("rejected");
    const pushes = rec.calls.map((c) => c.args.slice(HARDENED_CONFIG.length * 2));
    expect(pushes[0]).toEqual(["push", "-q", `https://github.com/${KB}.git`, `${A}:refs/heads/main`]);
    for (const c of rec.calls) expect(c.args.join(" ")).not.toMatch(/--force|\s-f\b|\+refs/);
    // an auth or network failure is not "main moved"
    const bad = createKbGitPort(createGitExec({ stateDir: dir, run: recorder(() => ({ code: 128, stderr: "fatal: Authentication failed" })).run, path: "/usr/bin" }), "https://x/y.git");
    await expect(bad.push({ token: TOKEN, commit: A, ref: "refs/heads/main" })).rejects.toThrow(/kb push başarısız/);
    await expect(bad.push({ token: TOKEN, commit: A, ref: "refs/heads/main" })).rejects.not.toThrow(TOKEN);
  });
});

describe("server: pushKbMain fixed to VLAD_KB_REPO and refs/heads/main", () => {
  const writer = (o: { main?: string; parent?: string; push?: "pushed" | "rejected" } = {}) => {
    const seen: { token: string; repo: string; perms: unknown; push?: { token: string; commit: string; ref: string }; parentOf?: string } = { token: "", repo: "", perms: null };
    const w = new GithubWriter({ request: async () => { throw new Error("client must not be used"); } }, {
      repo: KB, main: o.main ?? "main",
      tokens: { token: async (repo, perms) => { seen.repo = repo; seen.perms = perms; return TOKEN; } },
      git: { firstParent: async (c) => { seen.parentOf = c; return o.parent ?? B; }, push: async (p) => { seen.push = p; return o.push ?? "pushed"; } },
    });
    return { w, seen };
  };

  it("pushes the commit to the configured repository's main and nowhere else; the token is contents:write on the kb repo only", async () => {
    const { w, seen } = writer();
    expect(await w.pushKbMain(A, B)).toEqual({ kind: "pushed" });
    expect(seen.repo).toBe(KB);
    expect(seen.perms).toEqual({ contents: "write" });
    expect(seen.push).toEqual({ token: TOKEN, commit: A, ref: "refs/heads/main" });
    expect(w.pushKbMain.length).toBe(2); // (commit, expectedMain): no repo, no ref, no force parameter
  });

  it("refuses a commit whose first parent is not the main it was validated against, before any token is minted", async () => {
    const { w, seen } = writer({ parent: A });
    await expect(w.pushKbMain(A, B)).rejects.toThrow(/ilk ebeveyni/);
    expect(seen.repo).toBe("");
    expect(seen.push).toBeUndefined();
    await expect(w.pushKbMain("nope", B)).rejects.toThrow(/geçersiz sha/);
    await expect(w.pushKbMain(A, "../main")).rejects.toThrow(/geçersiz sha/);
  });

  it("a moved main is reported, not retried or forced; a writer without a kb target cannot push", async () => {
    expect(await writer({ push: "rejected" }).w.pushKbMain(A, B)).toEqual({ kind: "main_moved" });
    await expect(new GithubWriter({ request: async () => ({ status: 200, body: null }) }).pushKbMain(A, B)).rejects.toThrow(/yapılandırılmadı/);
    expect(() => new GithubWriter({ request: async () => ({ status: 200, body: null }) }, { repo: "../x", main: "main", tokens: {} as never, git: {} as never })).toThrow();
  });
});

describe("server: kb token scoped to kb repo with contents:write only", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  it("requests an installation token for the kb repository alone with exactly contents:write, cached apart from the approval token", async () => {
    const bodies: any[] = [];
    const p = new AppTokenProvider({
      appId: "1", privateKey: pem, now: () => Date.parse("2026-10-25T12:00:00Z"),
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/installation")) return { status: 200, text: async () => JSON.stringify({ id: 5 }) };
        bodies.push(JSON.parse(init.body!));
        return { status: 201, text: async () => JSON.stringify({ token: `ghs_${bodies.length}`, expires_at: "2026-10-25T13:00:00Z" }) };
      },
    });
    expect(await p.token(KB, KB_TOKEN_PERMISSIONS)).toBe("ghs_1");
    expect(await p.token(KB, { contents: "write" })).toBe("ghs_1"); // same repo + same set: cached
    expect(bodies[0]).toEqual({ repositories: ["vlad-kb"], permissions: { contents: "write" } });
    // the code repositories' token keeps its own, wider set and never receives the kb one
    expect(await p.token("acme/alpha")).toBe("ghs_2");
    expect(bodies[1]).toEqual({ repositories: ["alpha"], permissions: TOKEN_PERMISSIONS });
    expect(await p.token(KB)).toBe("ghs_3"); // default set on the kb repo is a different cache entry
    expect(KB_TOKEN_PERMISSIONS).toEqual({ contents: "write" });
  });
});

describe("server: startup refuses VLAD_KB_REPO equal to a project repo", () => {
  it("throws kb_repo_is_code_repo when any project card names the kb repository (case-insensitive), passes otherwise", () => {
    expect(() => assertKbRepoIsNotCodeRepo("iamhankaya/vlad", ["iamhankaya/vlad-kb", "iamhankaya/vlad"])).toThrow(/kb_repo_is_code_repo/);
    expect(() => assertKbRepoIsNotCodeRepo("IamHankaya/Vlad", ["iamhankaya/vlad"])).toThrow(/kb_repo_is_code_repo/);
    expect(() => assertKbRepoIsNotCodeRepo("iamhankaya/vlad-kb", ["iamhankaya/vlad", null, undefined, "x/y"])).not.toThrow();
  });

  it("the gate is off without VLAD_KB_REPO; a malformed or self-colliding setting refuses to start", () => {
    expect(loadKbSyncConfig({}, "/s")).toBeUndefined();
    expect(loadKbSyncConfig({ VLAD_KB_REPO: KB, VLAD_KB_DIR: "/kb", VLAD_SERVER_MACHINE: "SrvBox" }, "/s")).toEqual({
      repo: KB, main: "main", serverBranch: "kb-server", serverMachine: "srvbox", stateDir: join("/s", "kbpromote"), kbDir: "/kb",
    });
    expect(() => loadKbSyncConfig({ VLAD_KB_REPO: "bad", VLAD_KB_DIR: "/kb" }, "/s")).toThrow(/VLAD_KB_REPO/);
    expect(() => loadKbSyncConfig({ VLAD_KB_REPO: KB, VLAD_KB_DIR: "/kb", VLAD_KB_SERVER_BRANCH: "main" }, "/s")).toThrow(/aynı/);
    expect(() => loadKbSyncConfig({ VLAD_KB_REPO: KB }, "/s")).toThrow(/VLAD_KB_DIR/);
  });
});
