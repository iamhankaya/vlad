/**
 * The one HTTP door to api.github.com. Reads (`GET`) are open to anyone holding the client; a write (PUT/POST/PATCH/DELETE)
 * needs {@link WRITE_CAP}, which only `writer.ts` imports (a static scan in the tests keeps it that way). The
 * Authorization header is built here and never logged or put in an error.
 */
export const WRITE_METHODS: ReadonlySet<string> = new Set(["PUT", "POST", "PATCH", "DELETE"]);
export const WRITE_CAP: unique symbol = Symbol("github-write");

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
/** Gives the bearer token for a repo (an installation token of the App). */
export interface TokenProvider {
  token(repo: string): Promise<string>;
}

export class GithubHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GithubHttpError";
    this.status = status;
  }
}

export type GithubResponse = { status: number; body: any };
export type RequestOptions = { body?: unknown; cap?: symbol };

export interface GithubClientLike {
  request(method: string, path: string, repo: string, opts?: RequestOptions): Promise<GithubResponse>;
}

export const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export class GithubClient implements GithubClientLike {
  private readonly f: FetchLike;
  private readonly tokens: TokenProvider;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(o: { fetch?: FetchLike; tokens: TokenProvider; baseUrl?: string; timeoutMs?: number }) {
    this.f = o.fetch ?? ((url, init) => fetch(url, init));
    this.tokens = o.tokens;
    this.base = o.baseUrl ?? "https://api.github.com";
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  /** `path` starts with `/repos/<repo>/`; `repo` is the repository the token is for. Non-2xx answers are returned, not thrown. */
  async request(method: string, path: string, repo: string, opts: RequestOptions = {}): Promise<GithubResponse> {
    if (!REPO_RE.test(repo) || !path.startsWith(`/repos/${repo}/`)) throw new GithubHttpError(0, "geçersiz GitHub yolu");
    if (WRITE_METHODS.has(method) && opts.cap !== WRITE_CAP) throw new GithubHttpError(0, `GitHub yazması yalnız GithubWriter'dan: ${method}`);
    if (!WRITE_METHODS.has(method) && method !== "GET") throw new GithubHttpError(0, `desteklenmeyen yöntem: ${method}`);
    const token = await this.tokens.token(repo);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await this.f(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "vlad-gate",
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: ac.signal,
      });
      const text = await res.text();
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: res.status, body };
    } catch (e) {
      // Never forward the original message: a fetch implementation may echo request headers.
      throw new GithubHttpError(0, `GitHub isteği başarısız (${(e as Error).name})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Wraps a client in a Proxy that reports every write call (method + path, never headers or bodies) before it goes out.
 * Tests count writes with it; the app logs them.
 */
export function observeWrites<T extends GithubClientLike>(client: T, onWrite: (method: string, path: string) => void): T {
  return new Proxy(client, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== "request" || typeof v !== "function") return v;
      return (method: string, path: string, repo: string, opts?: RequestOptions) => {
        if (WRITE_METHODS.has(method)) onWrite(method, path);
        return v.call(target, method, path, repo, opts);
      };
    },
  });
}
