import { createSign } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_RE, type FetchLike, type TokenProvider } from "./client.ts";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Loads the App's private key from the server state directory (or `VLAD_GITHUB_APP_KEY_FILE`, or the env value). Never from the repo. */
export function loadAppKey(env: NodeJS.ProcessEnv, stateDir: string, warn: (m: string) => void = (m) => console.warn(m)): string | undefined {
  if (env.VLAD_GITHUB_APP_PRIVATE_KEY) return env.VLAD_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const file = env.VLAD_GITHUB_APP_KEY_FILE ?? join(stateDir, "github-app.pem");
  if (!existsSync(file)) return undefined;
  // One open file: the checks and the read look at the same inode, so the file cannot be swapped in between.
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    if (typeof process.getuid === "function") {
      // A key other users can read is as good as published; a key someone else owns could have been planted.
      if ((st.mode & 0o077) !== 0) throw new Error(`GitHub App anahtarı ${file} yalnız sahibi tarafından okunabilir olmalı (chmod 600)`);
      if (st.uid !== process.getuid()) throw new Error(`GitHub App anahtarı ${file} bu kullanıcıya ait olmalı`);
    } else {
      warn(`GitHub App anahtarı ${file}: bu platformda dosya izni/sahibi denetlenemiyor; dizini yalnız sunucu hesabına açın`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/** RS256 App JWT; valid 9 minutes (GitHub's limit is 10), issued 60 s in the past for clock skew. */
export function appJwt(appId: string, privateKeyPem: string, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000) - 60;
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64u(JSON.stringify({ iat, exp: iat + 600 - 60, iss: appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(privateKeyPem);
  return `${head}.${claims}.${b64u(sig)}`;
}

type Cached = { token: string; expMs: number };

export const API_TIMEOUT_MS = 15_000;
/** The least the approval path needs: write the check-run, merge (contents), read PRs and commit statuses. */
export const TOKEN_PERMISSIONS = { checks: "write", contents: "write", pull_requests: "read", statuses: "read" } as const;

/**
 * GitHub App JWT -> installation token, cached until 5 minutes before it expires. The installation is looked up per
 * repo (`GET /repos/{r}/installation`) unless one id is configured. Neither the key, the JWT nor a token is ever put in an error or log.
 */
export class AppTokenProvider implements TokenProvider {
  private readonly o: { appId: string; privateKey: string; installationId?: string; fetch?: FetchLike; now: () => number; baseUrl?: string; timeoutMs?: number };
  private readonly cache = new Map<string, Cached>();
  private readonly installs = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(o: { appId: string; privateKey: string; installationId?: string; fetch?: FetchLike; now?: () => number; baseUrl?: string; timeoutMs?: number }) {
    if (!/^[0-9]+$/.test(o.appId)) throw new Error("GitHub App id sayısal olmalı");
    this.o = { ...o, now: o.now ?? Date.now };
  }

  private async api(method: string, path: string, jwt: string, payload?: unknown): Promise<{ status: number; body: any }> {
    const f: FetchLike = this.o.fetch ?? ((url, init) => fetch(url, init));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.o.timeoutMs ?? API_TIMEOUT_MS);
    try {
      const res = await f(`${this.o.baseUrl ?? "https://api.github.com"}${path}`, {
        method, signal: ac.signal,
        headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "vlad-gate", ...(payload !== undefined ? { "content-type": "application/json" } : {}) },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      });
      const text = await Promise.race([
        res.text(),
        new Promise<never>((_, rej) => ac.signal.addEventListener("abort", () => rej(new Error("zaman aşımı")), { once: true })),
      ]);
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
      return { status: res.status, body };
    } catch (e) {
      throw new Error(`GitHub App isteği başarısız (${ac.signal.aborted ? "zaman aşımı" : "ağ hatası"})`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** `<slug>[bot]`, the login GitHub shows as `merged_by` for this App (`GET /app`). Undefined when it cannot be learned. */
  async botLogin(): Promise<string | undefined> {
    try {
      const r = await this.api("GET", "/app", appJwt(this.o.appId, this.o.privateKey, this.o.now()));
      return r.status === 200 && typeof r.body?.slug === "string" && /^[\w-]+$/.test(r.body.slug) ? `${r.body.slug}[bot]` : undefined;
    } catch {
      return undefined;
    }
  }

  async token(repo: string): Promise<string> {
    if (!REPO_RE.test(repo)) throw new Error("geçersiz repo");
    const key = repo; // the token is scoped to this one repository
    const hit = this.cache.get(key);
    if (hit && hit.expMs - 5 * 60_000 > this.o.now()) return hit.token;
    // One refresh at a time: concurrent callers share it.
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.refresh(repo, key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh(repo: string, key: string): Promise<string> {
    const jwt = appJwt(this.o.appId, this.o.privateKey, this.o.now());
    let id = this.o.installationId ?? this.installs.get(repo);
    if (!id) {
      const r = await this.api("GET", `/repos/${repo}/installation`, jwt);
      if (r.status !== 200 || !Number.isInteger(r.body?.id)) throw new Error(`GitHub App bu repoda kurulu değil (HTTP ${r.status})`);
      id = String(r.body.id);
      this.installs.set(repo, id);
    }
    const r = await this.api("POST", `/app/installations/${id}/access_tokens`, jwt, { repositories: [repo.split("/")[1]], permissions: TOKEN_PERMISSIONS });
    if (r.status !== 201 || typeof r.body?.token !== "string" || typeof r.body?.expires_at !== "string") throw new Error(`installation token alınamadı (HTTP ${r.status})`);
    const expMs = Date.parse(r.body.expires_at);
    if (Number.isNaN(expMs)) throw new Error("installation token yanıtı beklenen biçimde değil");
    this.cache.set(key, { token: r.body.token, expMs });
    return r.body.token;
  }
}
