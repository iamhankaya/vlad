import { createSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_RE, type FetchLike, type TokenProvider } from "./client.ts";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Loads the App's private key from the server state directory (or `VLAD_GITHUB_APP_KEY_FILE`, or the env value). Never from the repo. */
export function loadAppKey(env: NodeJS.ProcessEnv, stateDir: string): string | undefined {
  if (env.VLAD_GITHUB_APP_PRIVATE_KEY) return env.VLAD_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const file = env.VLAD_GITHUB_APP_KEY_FILE ?? join(stateDir, "github-app.pem");
  if (!existsSync(file)) return undefined;
  // A key other users can read is as good as published: refuse it (POSIX modes only).
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) throw new Error(`GitHub App anahtarı ${file} yalnız sahibi tarafından okunabilir olmalı (chmod 600)`);
  return readFileSync(file, "utf8");
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

/**
 * GitHub App JWT -> installation token, cached until 5 minutes before it expires. The installation is looked up per
 * repo (`GET /repos/{r}/installation`) unless one id is configured. Neither the key, the JWT nor a token is ever put in an error or log.
 */
export class AppTokenProvider implements TokenProvider {
  private readonly o: { appId: string; privateKey: string; installationId?: string; fetch?: FetchLike; now: () => number; baseUrl?: string };
  private readonly cache = new Map<string, Cached>();
  private readonly installs = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(o: { appId: string; privateKey: string; installationId?: string; fetch?: FetchLike; now?: () => number; baseUrl?: string }) {
    if (!/^[0-9]+$/.test(o.appId)) throw new Error("GitHub App id sayısal olmalı");
    this.o = { ...o, now: o.now ?? Date.now };
  }

  private async api(method: string, path: string, jwt: string): Promise<{ status: number; body: any }> {
    const f: FetchLike = this.o.fetch ?? ((url, init) => fetch(url, init));
    const res = await f(`${this.o.baseUrl ?? "https://api.github.com"}${path}`, {
      method, headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "vlad-gate" },
    });
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, body };
  }

  async token(repo: string): Promise<string> {
    if (!REPO_RE.test(repo)) throw new Error("geçersiz repo");
    const key = this.o.installationId ?? repo;
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
    const r = await this.api("POST", `/app/installations/${id}/access_tokens`, jwt);
    if (r.status !== 201 || typeof r.body?.token !== "string" || typeof r.body?.expires_at !== "string") throw new Error(`installation token alınamadı (HTTP ${r.status})`);
    const expMs = Date.parse(r.body.expires_at);
    if (Number.isNaN(expMs)) throw new Error("installation token yanıtı beklenen biçimde değil");
    this.cache.set(key, { token: r.body.token, expMs });
    return r.body.token;
  }
}
