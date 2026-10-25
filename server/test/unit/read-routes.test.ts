import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ReadCache } from "../../src/read/cache.ts";
import { registerReadRoutes } from "../../src/read/routes.ts";
import type { GateProvider } from "../../src/read/types.ts";
import { runVlad } from "../../src/vlad/cli.ts";
import { readJson } from "../helpers/contract.ts";
import { doc, jsonSchema, validator } from "../helpers/openapi.ts";

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const BUILD = join(REPO, `.cli-build-${process.pid}`); // fresh tsc output of src/: never a stale dist/
let tmp: string;
const saved = { ...process.env };

const schemaOf = (op: string, status: string) => {
  for (const item of Object.values<any>(doc.paths)) for (const m of Object.values<any>(item)) {
    if (m?.operationId === op) {
      const r = m.responses[status];
      return jsonSchema(r.$ref ? doc.components.responses[r.$ref.split("/").pop()!] : r);
    }
  }
  throw new Error(`no schema ${op} ${status}`);
};
const check = (op: string, status: number, body: unknown) => expect(validator(schemaOf(op, String(status)))(body)).toEqual([]);

const vlad = (args: string[]) => runVlad(args);
const writeTmp = (name: string, text: string) => { const p = join(tmp, name); writeFileSync(p, text); return p; };

/** The API shape of an object with every value stripped to its type: keys and nesting must match the contract fixture. */
const shape = (v: any): any =>
  Array.isArray(v) ? (v.length ? [shape(v[0])] : []) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : v === null ? null : typeof v;

// fake signature layer (S6b supplies the real one): requests need this header
const AUTH = { "x-test-auth": "ok" };
const auth: any = async (req: any, reply: any) => {
  if (req.headers["x-test-auth"] !== "ok") return reply.code(401).send({ error: { code: "unauthorized", message_tr: "Yetkisiz." } });
};

let app: FastifyInstance;
let gate: GateProvider | undefined;
let nowMs = 1_000_000;

beforeAll(async () => {
  const r = spawnSync("npx", ["tsc", "-p", join(REPO, "tsconfig.json"), "--outDir", BUILD], { cwd: REPO, shell: true, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
  tmp = mkdtempSync(join(tmpdir(), "vlad-read-"));
  const home = join(tmp, "home");
  mkdirSync(home);
  cpSync(join(REPO, "schemas"), join(home, "schemas"), { recursive: true });
  cpSync(join(REPO, "roles"), join(home, "roles"), { recursive: true });
  for (const d of ["projects", "tasks", "cards", "logs", "inbox/processed", "journal"]) mkdirSync(join(tmp, "kb", d), { recursive: true });
  process.env.VLAD_HOME = home;
  process.env.VLAD_KB_DIR = join(tmp, "kb");
  process.env.VLAD_CLI = join(BUILD, "cli.js");
  process.env.CLAUDE_CODE_REMOTE = "";

  const card = [
    "---", "slug: vlad", "name: vlad", `path: ${home}`, "stack: [ts]", "status: active", "autonomy: commit", "repo: iamhankaya/vlad",
    "last_activity: null", "last_scanned: null", "---", "", "## Özet", "x", "",
  ].join("\n");
  await vlad(["project", "write", "vlad", "--file", writeTmp("p.md", card)]);
});
afterAll(() => {
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

beforeEach(async () => {
  gate = undefined;
  app = Fastify();
  registerReadRoutes(app, auth, { cache: new ReadCache(() => nowMs), gate: (t, r) => (gate ? gate(t, r) : Promise.resolve(null)), seq: () => 17 });
  await app.ready();
});

const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });

describe("server: read routes (real vlad CLI, temp VLAD_HOME)", () => {
  it("every read route runs the signature preHandler", async () => {
    for (const url of ["/v1/home", "/v1/cards/C-20261025-01", "/v1/tasks/T20261025-01", "/v1/pipelines"]) {
      const res = await get(url, {});
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("server: /home matches fixture with real vlad CLI and temp VLAD_HOME", async () => {
    nowMs += 10_000;
    // pipeline + running phase with progress, an open question card, a corrupt card file
    await vlad(["task", "new", "--project", "vlad", "--title", "Çatı", "--kind", "pipeline"]);
    const root = (await runVlad(["task", "list", "--json"]).then(JSON.parse)).tasks[0].id as string;
    await vlad(["task", "new", "--project", "vlad", "--title", "Faz bir", "--parent", root, "--phase", "uygulama", "--role", "developer"]);
    const phase = (JSON.parse(await runVlad(["task", "list", "--parent", root, "--json"])).tasks[0].id) as string;
    await vlad(["task", "set", phase, "running"]);
    await vlad(["task", "progress", phase, "--pct", "60", "--label", "yazılıyor"]);
    await vlad(["card", "new", "--kind", "vlad_question", "--project", "vlad", "--title", "Exposure kalsın mı?", "--option", "yes=Evet", "--option", "no=Hayır"]);
    writeFileSync(join(tmp, "kb", "cards", "C-20250101-01.md"), "---\nid: nope\n---\n");

    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    check("getHome", 200, body);

    const fx = readJson("fixtures", "api", "get-home.200.json").response.body;
    expect(shape(body.asks[0])).toEqual(shape(fx.asks[1])); // card, not gate
    // host is only set by a launch; this phase was moved to running by hand
    expect(shape(body.workers[0])).toEqual(shape({ ...fx.workers[0], host: null }));
    expect(shape(body.quota)).toEqual({ limited: "boolean" });
    expect(Object.keys(body).sort()).toEqual(Object.keys(fx).sort());
    expect(body.seq).toBe(17);
    expect(body.asks).toHaveLength(1);
    expect(body.asks[0]).toMatchObject({ kind: "vlad_question", project: "vlad", state: "open", answer: null });
    expect(body.workers).toHaveLength(1);
    expect(body.workers[0]).toMatchObject({ task_id: phase, phase: "uygulama", state: "running", progress: { pct: 60, label: "yazılıyor" } });
    expect(body.active_vlad.mine).toBe(false);
    // the pipeline root is not a worker; a stored path never appears
    expect(JSON.stringify(body)).not.toContain(tmp);
    expect(body.warnings.length).toBeGreaterThan(0);
  });

  it("server: one corrupt kb record does not crash /home (warnings)", async () => {
    nowMs += 10_000;
    writeFileSync(join(tmp, "kb", "tasks", "T20250101-01.md"), "not a task at all");
    writeFileSync(join(tmp, "kb", "cards", "C-20250101-02.md"), "---\n: : :\n---\n");
    const res = await get("/v1/home");
    expect(res.statusCode).toBe(200);
    const w: string[] = res.json().warnings;
    expect(w.some((x) => x.startsWith("T20250101-01.md"))).toBe(true);
    expect(w.some((x) => x.startsWith("C-20250101-02.md"))).toBe(true);
    check("getHome", 200, res.json());
    rmSync(join(tmp, "kb", "tasks", "T20250101-01.md"), { force: true });
    rmSync(join(tmp, "kb", "cards", "C-20250101-02.md"), { force: true });
    rmSync(join(tmp, "kb", "cards", "C-20250101-01.md"), { force: true });
  });

  it("quota and active record show on /home", async () => {
    nowMs += 10_000;
    const until = new Date(Date.now() + 3600_000).toISOString();
    await vlad(["quota", "set", "--until", until, "--reason", "test"]);
    await vlad(["active", "claim"]);
    const body = (await get("/v1/home")).json();
    expect(body.quota).toEqual({ limited: true, until });
    expect(body.active_vlad).toMatchObject({ mine: true });
    check("getHome", 200, body);
    await vlad(["quota", "clear"]);
    await vlad(["active", "release"]);
    nowMs += 10_000;
    const empty = (await get("/v1/home")).json();
    expect(empty.quota).toEqual({ limited: false });
    expect(empty.active_vlad.mine).toBe(false);
    check("getHome", 200, empty);
  });

  it("GET /tasks/{id} matches the fixture shape, includes the closing report", async () => {
    nowMs += 10_000;
    const { tasks } = JSON.parse(await runVlad(["task", "list", "--json"]));
    const t = tasks.find((x: any) => x.phase === "uygulama");
    await vlad(["task", "report", t.id, "--file", writeTmp("r.md", "### Yapılanlar\n- bir")]);
    const res = await get(`/v1/tasks/${t.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    check("getTask", 200, body);
    expect(shape({ ...body, report_md: null, pr: null, error: null })).toEqual(shape({ ...readJson("fixtures", "api", "get-task.200.json").response.body, host: null, report_md: null, pr: null, error: null }));
    expect(body.report_md).toBe("### Yapılanlar\n- bir");
    expect(body.state).toBe("awaiting_approval");
    expect(body).not.toHaveProperty("branch");
    expect(body).not.toHaveProperty("worktree");
  });

  it("GET /pipelines lists roots with their phases", async () => {
    nowMs += 10_000;
    const res = await get("/v1/pipelines");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    check("listPipelines", 200, body);
    expect(body.pipelines).toHaveLength(1);
    expect(body.pipelines[0].phases).toHaveLength(1);
    expect(body.pipelines[0].phases[0]).toMatchObject({ phase: "uygulama", role: "developer" });
    const fx = readJson("fixtures", "api", "list-pipelines.200.json").response.body;
    expect(shape(body.pipelines[0])).toEqual(shape(fx.pipelines[0]));
  });

  it("GET /cards/{id}: stored card, 404 and malformed ids", async () => {
    nowMs += 10_000;
    await vlad(["card", "new", "--kind", "vlad_question", "--project", "vlad", "--title", "Soru", "--option", "a=A"]);
    const id = JSON.parse(await runVlad(["card", "list", "--json"])).cards[0].id as string;
    const res = await get(`/v1/cards/${id}`);
    expect(res.statusCode).toBe(200);
    check("getCard", 200, res.json());
    const miss = await get("/v1/cards/C-20250101-99");
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toMatchObject({ error: { code: "bad_request", details: { reason: "not_found" } } });
    check("getCard", 404, miss.json());
    expect((await get("/v1/cards/..%2F..%2Fetc")).statusCode).toBe(400);
    expect((await get("/v1/cards/C-1")).statusCode).toBe(400);
    expect((await get("/v1/tasks/nope")).statusCode).toBe(400);
    // option-like and shell-like ids never reach runVlad
    for (const bad of ["--help", "-h", "%3Bls", "T20261025-01%3Bls", "--json"]) {
      expect((await get(`/v1/tasks/${bad}`)).statusCode, bad).toBe(400);
      expect((await get(`/v1/cards/${bad}`)).statusCode, bad).toBe(400);
    }
    const noTask = await get("/v1/tasks/T20250101-99");
    expect(noTask.statusCode).toBe(404);
    check("getTask", 404, noTask.json());
  });

  it("gate cards come from tasks awaiting approval, with live PR facts from the provider", async () => {
    nowMs += 10_000;
    const { tasks } = JSON.parse(await runVlad(["task", "list", "--json"]));
    const t = tasks.find((x: any) => x.state === "awaiting_approval");
    await vlad(["task", "pr", t.id, "--number", "42", "--repo", "iamhankaya/vlad", "--base", "vlad/T20261024-94"]);
    // no provider: no head SHA is known, so no gate card (and the id is a 404)
    nowMs += 10_000;
    expect((await get("/v1/home")).json().asks.every((a: any) => a.kind !== "gate")).toBe(true);
    expect((await get(`/v1/cards/gate-${t.id}`)).statusCode).toBe(404);

    gate = async () => ({
      pr: { number: 42, repo: "iamhankaya/vlad", base: "vlad/T20261024-94", url: "https://github.com/iamhankaya/vlad/pull/42" },
      head_sha: "0123456789abcdef0123456789abcdef01234567", ci: "green", mergeable: true, merge_kind: "merge_phase", reviews: [],
    });
    nowMs += 10_000;
    const home = (await get("/v1/home")).json();
    check("getHome", 200, home);
    expect(home.asks[0]).toMatchObject({ id: `gate-${t.id}`, kind: "gate", gate: { head_sha: "0123456789abcdef0123456789abcdef01234567", report_md: "### Yapılanlar\n- bir" } });
    const fx = readJson("fixtures", "api", "get-card.200-gate.json").response.body;
    expect(shape(home.asks[0])).toEqual(shape(fx));
    const one = await get(`/v1/cards/gate-${t.id}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toEqual(home.asks[0]);
  });

  it("2 s cache: repeated reads share one run, a stale entry reloads", async () => {
    nowMs += 10_000;
    await get("/v1/pipelines");
    await vlad(["task", "new", "--project", "vlad", "--title", "Yeni çatı", "--kind", "pipeline"]);
    nowMs += 1500;
    expect((await get("/v1/pipelines")).json().pipelines).toHaveLength(1); // cached
    nowMs += 1000;
    expect((await get("/v1/pipelines")).json().pipelines).toHaveLength(2); // expired
  });

  it("a vlad failure is a 503 without CLI text; a hung CLI times out", async () => {
    nowMs += 10_000;
    const dead = Fastify();
    registerReadRoutes(dead, auth, { cache: new ReadCache(() => nowMs), timeoutMs: 1 });
    const res = await dead.inject({ method: "GET", url: "/v1/pipelines", headers: AUTH });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "bad_request", details: { reason: "vlad_failed", kind: "timeout" } } });
    expect(JSON.stringify(res.json())).not.toContain(tmp);
  });
});
