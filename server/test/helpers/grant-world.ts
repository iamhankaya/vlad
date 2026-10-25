// S10a test world: the whole approval stack (ActionService, real executor/writer/reader/client on a fake GitHub at `fetch` level) plus the
// grant engine with an in-memory kb. One fake GitHub per PR so several tasks can wait for their gate at once.
import { createExecutor } from "../../src/actions/executor.ts";
import { GrantStore, grantSigningPayload, type GrantKb, type GrantRecord } from "../../src/actions/grants.ts";
import type { VladOps } from "../../src/actions/ops.ts";
import type { TaskInfo } from "../../src/actions/service.ts";
import { GithubClient, observeWrites, type FetchLike } from "../../src/github/client.ts";
import { RestGithubReader } from "../../src/github/reader.ts";
import { GithubWriter } from "../../src/github/writer.ts";
import { pairDevice, rig, signDer, signedCall, type Rig, type TestDevice } from "./client.ts";
import { APP_ID, FakeGithubHttp } from "./fake-github-http.ts";
import { openPullBody } from "./fake-github.ts";

export const REPO = "iamhankaya/vlad";
export const REPO2 = "iamhankaya/other";
export const PARENT = "T20261024-94";
export const T1 = "T20261025-61"; // phase, PR 42
export const T2 = "T20261025-62"; // phase, PR 43
export const T3 = "T20261025-63"; // root task (merge_final), PR 44
export const T4 = "T20261025-64"; // phase of another project, PR 45
export const sha40 = (c: string) => c.repeat(40);

export class FakeKb implements GrantKb {
  added: GrantRecord[] = [];
  /** What `vlad grant list` returns: also files nobody signed. */
  files: { id: string; revoked: boolean }[] = [];
  /** The kb's tombstones, reported whatever became of the file. */
  revokedIds: string[] = [];
  warnings: string[] = [];
  revoked: string[] = [];
  failAdd = false;
  failList = false;
  onList?: () => Promise<void> | void;
  async add(rec: GrantRecord) {
    if (this.failAdd) throw new Error("kb meşgul");
    this.added.push(structuredClone(rec));
    this.files.push({ id: rec.id, revoked: false });
  }
  async list() {
    await this.onList?.();
    if (this.failList) throw new Error("kb okunamadı");
    return { grants: structuredClone(this.files), revoked_ids: [...this.revokedIds], warnings: [...this.warnings] };
  }
  async revoke(id: string) {
    this.revoked.push(id);
    this.revokedIds.push(id);
    const f = this.files.find((x) => x.id === id);
    if (f) f.revoked = true;
  }
}

export class FakeOps implements VladOps {
  audits = new Map<string, Record<string, any>>();
  auditCalls = 0;
  failAudit = 0;
  launched: string[] = [];
  /** Phases the pipeline would start after a merge (`vlad task ready`). */
  readyIds: string[] = [];
  private readonly tasks: Map<string, TaskInfo>;
  constructor(tasks: Map<string, TaskInfo>) {
    this.tasks = tasks;
  }
  async addAudit(e: Record<string, unknown>) {
    this.auditCalls++;
    if (this.failAudit > 0) {
      this.failAudit--;
      throw new Error("kb meşgul");
    }
    if (!this.audits.has(String(e.action_id))) this.audits.set(String(e.action_id), e);
  }
  async setDone(id: string) {
    this.tasks.get(id)!.state = "done";
  }
  async ready() {
    return [...this.readyIds];
  }
  async launch(id: string) {
    this.launched.push(id);
  }
}

export type GrantOver = Partial<Omit<GrantRecord, "device_id">>;

export async function mkWorld(o: { kb?: FakeKb; dir?: string; mergerLogin?: () => Promise<string | undefined> } = {}) {
  const kb = o.kb ?? new FakeKb();
  const tasks = new Map<string, TaskInfo>();
  const gh = new Map<string, FakeGithubHttp>();
  const shas = new Map<string, string>(); // initial head sha -> task
  const add = (id: string, project: string, repo: string, pr: number, base: string, parent: string | null, c: string) => {
    tasks.set(id, { id, project, state: "awaiting_approval", parent, pr: { number: pr, repo, base } });
    const g = new FakeGithubHttp();
    g.pull = openPullBody({ sha: sha40(c), ref: `vlad/${id}`, base });
    g.pull.head.repo.full_name = repo;
    g.pull.base.repo.full_name = repo;
    gh.set(id, g);
    shas.set(sha40(c), id);
  };
  add(T1, "vlad", REPO, 42, `vlad/${PARENT}`, PARENT, "a");
  add(T2, "vlad", REPO, 43, `vlad/${PARENT}`, PARENT, "b");
  add(T3, "vlad", REPO, 44, "master", null, "c");
  add(T4, "other", REPO2, 45, "vlad/T20261024-95", "T20261024-95", "d");
  const prOf = (id: string) => tasks.get(id)!.pr!.number;

  const forUrl = (url: string, body?: string): FakeGithubHttp => {
    const p = new URL(url).pathname;
    let m = p.match(/\/pulls\/(\d+)/);
    if (m) return [...gh.entries()].find(([id]) => prOf(id) === Number(m![1]))![1];
    m = p.match(/\/commits\/([0-9a-f]{40})\//);
    const sha = m ? m[1]! : JSON.parse(body ?? "{}").head_sha;
    const hit = [...gh.entries()].find(([id, g]) => g.pull.head.sha === sha || shas.get(sha) === id);
    if (!hit) throw new Error(`no fake PR for ${url}`);
    return hit[1];
  };
  const fetch: FetchLike = (url, init) => forUrl(url, init.body).fetch(url, init);

  const proxied: string[] = [];
  const client = observeWrites(new GithubClient({ fetch, tokens: { token: async () => "tok" } }), (m, p) => proxied.push(`${m} ${p}`));
  const reader = new RestGithubReader(client);
  const ops = new FakeOps(tasks);
  const taskSource = async (id: string) => {
    const t = tasks.get(id);
    return t ? structuredClone(t) : null;
  };
  const cards: Record<string, { repo: string; default_branch: string }> = { vlad: { repo: REPO, default_branch: "master" }, other: { repo: REPO2, default_branch: "master" } };
  const projects = async (slug: string) => (cards[slug] ? { ...cards[slug]! } : null);
  const world = {
    kb, tasks, gh, ops, proxied, cards, severe: new Set<string>(), codex: false, findingsCalls: 0, onFindings: undefined as undefined | ((n: number) => void), sleeps: [] as number[], logs: [] as string[],
  };
  const sleep = async (ms: number) => void world.sleeps.push(ms);
  let r!: Rig;
  r = rig(
    {
      limits: { unpaired: [100000, 1000], paired: [100000, 1000], public: [100000, 1000] },
      events: { every: () => () => {} },
      actions: {
        reader, tasks: taskSource, projects, sleep, policy: { prepareIntervalMs: 0, allowBlocked: true, appId: APP_ID },
        execute: createExecutor({
          reader, writer: new GithubWriter(client), tasks: taskSource, ops, now: () => r.clock.t, sleep, appId: APP_ID, ...(o.mergerLogin ? { resolveMergerLogin: o.mergerLogin } : { mergerLogin: "vlad-gate[bot]" }),
          appendEvent: (type, data, key) => r.app.vladEvents.ledger.append(type, data, key),
        }),
      },
      grants: {
        kb,
        log: (m: string) => world.logs.push(m),
        findingsClear: async (project) => {
          world.onFindings?.(++world.findingsCalls);
          return !world.severe.has(project);
        },
        codexClear: async () => world.codex,
        listAwaiting: async () => [...tasks.values()].filter((t) => t.state === "awaiting_approval").map((t) => t.id),
      },
    },
    o.dir,
  );
  const engine = () => r.app.vladGrants!;
  const iso = (ms: number) => new Date(ms).toISOString();
  const DAY = 86_400_000;

  /** A grant body signed by `d`'s approval key (override fields, or the signature with `sig`). */
  const grantBody = (d: TestDevice, over: GrantOver & { sig?: string; extra?: Record<string, unknown> } = {}) => {
    const { sig, extra, ...rest } = over;
    const g = {
      id: "G-001", scope: { type: "project" as const, ref: "vlad" }, project: "vlad", repo: REPO, action: "merge_phase", conditions: ["ci_green"], created: iso(r.clock.t), expires: iso(r.clock.t + DAY),
      max_uses: 5, payload_version: "v2" as const, ...rest,
    };
    return { ...g, signature: sig ?? signDer(d.approval.priv, Buffer.from(grantSigningPayload(g))), ...extra };
  };
  const post = (d: TestDevice, body: unknown) => signedCall(r, d, "POST", "/v1/grants", typeof body === "string" ? body : JSON.stringify(body));
  const create = async (d: TestDevice, over: GrantOver = {}) => {
    const body = grantBody(d, over);
    const res = await post(d, body);
    if (res.statusCode !== 200) throw new Error(`createGrant failed ${res.statusCode} ${res.body}`);
    return body.id;
  };

  return Object.assign(world, {
    r, engine, iso, DAY, grantBody, post, create,
    reader,
    phone: (name = "Pixel 9") => pairDevice(r, name),
    get: (path: string, d: TestDevice) => signedCall(r, d, "GET", path),
    del: (d: TestDevice, id: string) => signedCall(r, d, "DELETE", `/v1/grants/${id}`),
    merges: (id: string) => gh.get(id)!.merges,
    writes: (id: string) => gh.get(id)!.writes,
    events: (type: string) => r.app.vladEvents.ledger.after(0, 1000).filter((e) => e.type === type),
    ledger: () => r.app.vladEvents.ledger,
    store: () => new GrantStore(r.dir),
    redCi: (id: string) => void (gh.get(id)!.ci = [{ id: 1, name: "gate", status: "completed", conclusion: "failure", app: { id: 15368 } }]),
    close: () => r.app.close(),
  });
}
export type GrantWorld = Awaited<ReturnType<typeof mkWorld>>;
